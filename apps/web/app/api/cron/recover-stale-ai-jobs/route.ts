import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { Effect, Schedule } from "effect";
import { NextResponse } from "next/server";
import { sendOpsAlert } from "@/lib/ops-alert";
import { startAiGeneration } from "@/lib/generate-ai";
import { runPromise } from "@/lib/server";
import { transcribeVideo } from "@/lib/transcribe";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { getStorageAccessForVideo } from "@/lib/video-storage";
import {
	FAST_STALE_JOB_THRESHOLD_MS,
	hasPendingBatchJobs,
	isTranscriptionJobStale,
	shouldAutoRetry,
	shouldRetryQuotaBlocked,
	withIncrementedAutoRecoverAttempts,
	withQuotaRetryScheduled,
} from "./stale-job-helpers";

export const dynamic = "force-dynamic";

// Mirrors CapCard's REFINE_STALE_MS (apps/web/app/(org)/dashboard/caps/components/CapCard/CapCard.tsx)
// and the local REFINE_STALE_MS in actions/video/refine-timestamps.ts — a PROCESSING timestamp
// refinement older than this is a crashed run, not truly in-flight.
const REFINE_STALE_JOB_THRESHOLD_MS = 30 * 60 * 1000;

// A video_uploads row older than this in phase 'uploading' or 'processing'
// means the processing hand-off was lost: a live multipart upload re-stamps
// updated_at every 2 seconds and a live remux deletes the row within
// milliseconds of taking over, so neither phase can be healthy at 30 minutes.
const STALE_UPLOAD_THRESHOLD_MS = 30 * 60 * 1000;

type StaleTranscriptionCandidate = {
	id: Video.VideoId;
	ownerId: string;
	name: string;
	metadata: VideoMetadata | null;
};

type StaleAiCandidate = {
	id: Video.VideoId;
	ownerId: string;
	name: string;
	metadata: VideoMetadata | null;
};

type StaleRefinementCandidate = {
	id: Video.VideoId;
	ownerId: string;
	name: string;
	metadata: VideoMetadata | null;
};

type StaleUploadCandidate = {
	video: typeof videos.$inferSelect;
	upload: typeof videoUploads.$inferSelect;
};

// Storage is the only trustworthy source for "the bytes really are all
// there" — the row alone says nothing about a multipart that never
// assembled. Mirrors verifyRawFileUploaded in actions/video/trigger-processing.ts,
// but returns a boolean instead of throwing: for this cron an absent or
// zero-length object means the upload genuinely failed, which is a row to
// leave alone, not an error to surface.
async function isRawObjectInStorage(
	video: typeof videos.$inferSelect,
	rawFileKey: string,
): Promise<boolean> {
	try {
		const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
		const head = await bucket
			.headObject(rawFileKey)
			.pipe(
				Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
				runPromise,
			);
		return (head.ContentLength ?? 0) > 0;
	} catch {
		return false;
	}
}

// NOTE (round-8 deletion): the quota-park ladder branch is GONE from this
// loop. Cheap transcription no longer parks — each chunk falls back to the
// paid sync call when free is out — so PROCESSING + aiQuotaWaiting can no
// longer be produced by transcription. A LEGACY parked row simply goes
// stale (its heartbeat stopped) and takes the normal bounded re-kick path
// below, which completes it under the new semantics or ends it in ERROR.
export async function GET(request: Request) {
	const cronSecret = process.env.CRON_SECRET;
	if (!cronSecret) {
		return NextResponse.json(
			{ error: "Server misconfiguration" },
			{ status: 500 },
		);
	}

	const authHeader = request.headers.get("authorization");
	const expected = `Bearer ${cronSecret}`;
	if (
		!authHeader ||
		authHeader.length !== expected.length ||
		!timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected))
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	const now = Date.now();
	const fastStaleBefore = new Date(now - FAST_STALE_JOB_THRESHOLD_MS);
	const fastStaleBeforeIso = fastStaleBefore.toISOString();
	const refineStaleBefore = new Date(now - REFINE_STALE_JOB_THRESHOLD_MS);
	const refineStaleBeforeIso = refineStaleBefore.toISOString();
	const staleUploadBefore = new Date(now - STALE_UPLOAD_THRESHOLD_MS);

	const transcriptionCandidates: StaleTranscriptionCandidate[] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(
			and(
				eq(videos.transcriptionStatus, "PROCESSING"),
				isNull(videos.deletedAt),
				// Staleness = time since LAST PROGRESS (the aiProgressAt heartbeat,
				// re-stamped on every completed chunk), falling back to the claim
				// time for pre-heartbeat rows. Judging from processingStartedAt
				// alone killed every recording longer than the threshold.
				// The final COALESCE arm '' makes a row with NO markers at all
				// compare as infinitely stale — matching isTranscriptionJobStale.
				// Without it, NULL <= ? is NULL and a PROCESSING row whose takeover
				// cleared both markers (and whose re-claim then failed: budget, no
				// key, crash) was INVISIBLE forever: no retry, no ERROR, no flip —
				// a permanent spinner the generate route refuses as already-running.
				sql`COALESCE(
					JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiProgressAt')),
					JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.processingStartedAt')),
					''
				) <= ${fastStaleBeforeIso}`,
			),
		);

	// Videos that died because the AI account ran out of credits. Deliberately a
	// SEPARATE query from the PROCESSING one above: these are terminal-ERROR rows
	// with no stale timestamp, so the 4h paid flip, the Batch-collector skip and
	// the "dead after 2 auto-retries" ops alert must NOT apply to them.
	// LIMIT 3 because transcribeVideo detaches via after() — an unbounded tick
	// would launch every blocked video's ffmpeg/S3 work concurrently in one box.
	const quotaBlockedCandidates: StaleTranscriptionCandidate[] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(
			and(
				eq(videos.transcriptionStatus, "ERROR"),
				isNull(videos.deletedAt),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.transcriptionError.code')) = 'QUOTA'`,
			),
		)
		.limit(3);

	const aiGenerationCandidates: StaleAiCandidate[] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(
			and(
				isNull(videos.deletedAt),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiGenerationStatus')) IN ('PROCESSING', 'QUEUED')`,
				// Staleness = time since LAST PROGRESS (the aiProgressAt heartbeat,
				// stamped every 5 min by the generation workflow since round-12 #3),
				// falling back to the claim time for pre-heartbeat rows. Judging by
				// aiProcessingStartedAt alone re-kicked a HEALTHY generation longer
				// than the window into a second concurrent paid run. The '' arm
				// makes a row with NO markers compare as infinitely stale.
				sql`COALESCE(
					JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiProgressAt')),
					JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiProcessingStartedAt')),
					''
				) <= ${fastStaleBeforeIso}`,
			),
		);

	// Restart-proof safety net for a request the user made while the upload was
	// still processing: the generate route recorded aiStartPendingUpload but
	// could not start anything, and processVideoWorkflow — which normally
	// redeems that marker the moment processing finishes — may never have run it
	// (container restart, crashed workflow).
	//
	// The marker is aiStartPendingUpload, NOT aiGenerationRequestedAt. The
	// latter is written by the already-PROCESSING branch too and nothing ever
	// clears it (shouldStartAiAfterTranscription still needs it), so keying on
	// it made this query mean "every video that ever asked for AI and is
	// currently unclaimed" — a standing order that re-launched full paid
	// transcription every 30 minutes on any row an operator reset to NULL.
	// aiStartPendingUpload is one-shot: removed below the moment it is redeemed.
	// transcriptionStatus IS NULL is
	// exactly "nobody ever claimed this job", so there is no live run to
	// duplicate; transcribeVideo re-checks the upload row itself and simply
	// refuses again (a no-op) while bytes are genuinely still landing.
	// LIMIT 3 for the same reason as the quota query: transcribeVideo detaches
	// via after(), so an unbounded tick would launch every pending video's
	// ffmpeg/S3 work concurrently in one box.
	const pendingRequestCandidates: StaleTranscriptionCandidate[] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(
			and(
				isNull(videos.deletedAt),
				isNull(videos.transcriptionStatus),
				sql`COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiStartPendingUpload')), '') <> ''`,
			),
		)
		.limit(3);

	const refinementCandidates: StaleRefinementCandidate[] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			name: videos.name,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(
			and(
				isNull(videos.deletedAt),
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.timestampRefinement.status')) = 'PROCESSING'`,
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.timestampRefinement.requestedAt')) <= ${refineStaleBeforeIso}`,
			),
		);

	let retried = 0;
	let gaveUp = 0;
	let skippedForBatch = 0;
	let skippedAlive = 0;
	let quotaRetried = 0;
	let refinementReset = 0;
	let pendingRequestStarted = 0;
	let staleUploadRelaunched = 0;

	for (const candidate of transcriptionCandidates) {
		const metadata = candidate.metadata ?? {};
		try {
			if (hasPendingBatchJobs(metadata)) {
				// The poll-batch-jobs collector owns this cheap job's pending Batch;
				// re-kicking here would create a duplicate non-idempotent Batch.
				skippedForBatch++;
			} else if (!isTranscriptionJobStale(metadata, now)) {
				// Freshness re-check in JS on the row we actually hold: the job has
				// proven life (heartbeat) — chunk progress is the third liveness
				// case that neither aiQuotaWaiting nor aiBatchJobs marks. Never
				// kill a job that is visibly advancing, whatever its total runtime.
				skippedAlive++;
			} else if (shouldAutoRetry(metadata.autoRecoverAttempts)) {
				const nextMetadata = withIncrementedAutoRecoverAttempts(metadata);
				// Deliberately NOT resetting transcriptionStatus to null: the status
				// must never pass through NULL on a re-kick — a page load in that
				// window reads NULL and renders "start AI analysis?" for a job that
				// is alive. transcribeVideo(isRetry=true) re-claims a PROCESSING row
				// in place.
				await db()
					.update(videos)
					.set({ metadata: nextMetadata })
					.where(eq(videos.id, candidate.id));
				await transcribeVideo(candidate.id, candidate.ownerId, true, true);
				retried++;
			} else {
				// Retries exhausted: terminal ERROR + ops alert.
				await db()
					.update(videos)
					.set({
						transcriptionStatus: "ERROR",
						// Stamp the reason explicitly. A bare status write would leave a
						// stale QUOTA code in place, and the quota query above would then
						// resurrect the very video we just declared dead.
						metadata: {
							...metadata,
							transcriptionError: {
								code: "FAILED",
								message: "Dead after 2 auto-retries",
								at: new Date().toISOString(),
							},
						} as VideoMetadata,
					})
					.where(eq(videos.id, candidate.id));
				await sendOpsAlert(
					`AI job dead after 2 auto-retries: ${candidate.id} (${candidate.name})`,
				);
				gaveUp++;
			}
		} catch (error) {
			console.error(
				`[recover-stale-ai-jobs] Failed to recover transcription for video ${candidate.id}:`,
				error,
			);
		}
	}

	// Credits-depleted videos: re-run them once the backoff deadline passes. This
	// is what removes the operator's manual `UPDATE videos SET
	// transcriptionStatus = NULL` from the 2026-07-20 incident.
	for (const candidate of quotaBlockedCandidates) {
		const metadata = candidate.metadata ?? {};
		if (!shouldRetryQuotaBlocked(metadata, now)) continue;
		try {
			const nextMetadata: VideoMetadata = {
				...withQuotaRetryScheduled(metadata, now),
				transcriptionError: undefined,
			};
			// Keep the row's ERROR status until the re-claim writes PROCESSING —
			// never NULL in between (same no-NULL law as the stale re-kick above;
			// ERROR passes transcribeVideo's start guard on its own).
			await db()
				.update(videos)
				.set({ metadata: nextMetadata })
				.where(eq(videos.id, candidate.id));
			await transcribeVideo(candidate.id, candidate.ownerId, true, true);
			quotaRetried++;
		} catch (error) {
			console.error(
				`[recover-stale-ai-jobs] Failed to retry quota-blocked video ${candidate.id}:`,
				error,
			);
		}
	}

	// NOTE (round-10 #2): the generation 4h paid flip is GONE, because cheap
	// generation no longer parks — like transcription since round 8, it pays
	// INLINE the moment its free chain is genuinely exhausted, so "stuck on
	// free for 4h" is not a state a healthy cheap generation can be in. A
	// stale generation row is a crash, owned by the bounded re-kick below.
	for (const candidate of aiGenerationCandidates) {
		const metadata = candidate.metadata ?? {};
		try {
			if (shouldAutoRetry(metadata.autoRecoverAttempts)) {
				const nextMetadata: VideoMetadata = {
					...withIncrementedAutoRecoverAttempts(metadata),
					aiGenerationStatus: undefined,
				};
				await db()
					.update(videos)
					.set({ metadata: nextMetadata })
					.where(eq(videos.id, candidate.id));
				await startAiGeneration(candidate.id, candidate.ownerId, {
					force: true,
					isRetry: true,
				});
				retried++;
			} else {
				await db()
					.update(videos)
					.set({
						metadata: sql<VideoMetadata>`JSON_SET(COALESCE(${videos.metadata}, JSON_OBJECT()), '$.aiGenerationStatus', 'ERROR')`,
					})
					.where(eq(videos.id, candidate.id));
				await sendOpsAlert(
					`AI job dead after 2 auto-retries: ${candidate.id} (${candidate.name})`,
				);
				gaveUp++;
			}
		} catch (error) {
			console.error(
				`[recover-stale-ai-jobs] Failed to recover AI generation for video ${candidate.id}:`,
				error,
			);
		}
	}

	for (const candidate of pendingRequestCandidates) {
		try {
			// isRetry = TRUE, reclaimProcessing = FALSE — and the split matters.
			// isRetry is needed only for its no-refund half: a non-retry claim
			// JSON_REMOVEs autoRecoverAttempts / quotaRetryAttempts /
			// quotaRetryNextAt ("a cron RETRY must NOT refund itself"), so
			// refunding here let a repeatedly-failing video reset its budget every
			// 30 minutes and the bounded-retry alert could never fire.
			// But isRetry ALSO used to mean "may re-claim a PROCESSING row", and
			// that half is wrong here (round-21 #1): the SELECT says the row is
			// NULL, yet four awaits pass before the claim, and inside that window
			// the process-video redeemer can claim it. With the PROCESSING arm the
			// CAS would then MATCH and launch a SECOND paid transcription for one
			// video. Passing false keeps this starter on the NULL/ERROR arm, so a
			// lost race launches nothing.
			// aiGenerationEnabled=false (2026-09-05): this cron redeems the same
			// upload-time press as process-video.ts, and for the same reason it
			// now starts transcription ONLY. AI generation is the separate
			// "Xulosalash" step the owner presses once the transcript is ready.
			const result = await transcribeVideo(
				candidate.id,
				candidate.ownerId,
				false,
				true,
				false,
			);
			// Redeem the one-shot order ONLY when the start actually took. A refusal
			// that launched nothing must LEAVE the marker so the other redeemer (or
			// the 30-minute cron) can try again — `code === "UPLOAD_IN_PROGRESS"` is
			// only ONE of several such refusals: no usable key, "AI budget exceeded"
			// and a failed workflow launch all return with the row still at NULL and
			// carry no code. Consuming the order on those turned a transient budget
			// or key blip into permanent silent loss of the user's press, which is
			// the 2026-08-16 incident all over again (round-21 #2).
			// Removing AFTER a successful start is safe against a duplicate: the
			// claim inside transcribeVideo is a compare-and-swap, so a second
			// redeemer that also sees the marker loses the claim and launches
			// nothing.
			if (result.success && result.code !== "UPLOAD_IN_PROGRESS") {
				await db()
					.update(videos)
					.set({
						metadata: sql`JSON_REMOVE(
							COALESCE(${videos.metadata}, JSON_OBJECT()),
							'$.aiStartPendingUpload'
						)`,
					})
					.where(eq(videos.id, candidate.id));
				pendingRequestStarted++;
			}
		} catch (error) {
			console.error(
				`[recover-stale-ai-jobs] Failed to start the pending AI request for video ${candidate.id}:`,
				error,
			);
		}
	}

	// Safety net for a lost processing hand-off (2026-09-10 incident, ~15% of
	// uploads): the multipart complete route verifies the object and then hands
	// off to startVideoProcessingWorkflow with a single unrecorded, in-process,
	// fire-and-forget call — nothing reconciles it. When the call does not take
	// effect the video_uploads row sits at phase 'uploading' forever with every
	// byte safely in storage and the user told success, and no marker exists
	// for the loops above to see. phase IN ('uploading','processing') plus the
	// raw object being present IS the durable fact "bytes complete, hand-off
	// lost". The relaunch is safe to repeat: forceRestart re-claims the row,
	// and the transcription claim in lib/transcribe.ts is a compare-and-swap,
	// so a duplicate hand-off loses the claim and launches nothing paid.
	// LIMIT 3 for the same reason as the neighbouring loops above — the
	// relaunch runs ffmpeg inline in this process.
	const staleUploadCandidates: StaleUploadCandidate[] = await db()
		.select({ video: videos, upload: videoUploads })
		.from(videos)
		.innerJoin(videoUploads, eq(videoUploads.videoId, videos.id))
		.where(
			and(
				isNull(videos.deletedAt),
				inArray(videoUploads.phase, ["uploading", "processing"]),
				lte(videoUploads.updatedAt, staleUploadBefore),
				isNotNull(videoUploads.rawFileKey),
			),
		)
		.limit(3);

	for (const candidate of staleUploadCandidates) {
		const { video, upload } = candidate;
		// Hard cap mirroring the SQL LIMIT, so a future edit of that query can
		// never fan inline ffmpeg launches wider than the neighbouring loops.
		if (staleUploadRelaunched >= 3) break;
		// Freshness re-check in JS on the row we actually hold (same law as the
		// transcription loop above): never relaunch an upload that is still
		// visibly landing bytes.
		if (upload.updatedAt.getTime() > staleUploadBefore.getTime()) continue;
		// Narrow the key in JS as well as in SQL. The query already filters
		// `raw_file_key IS NOT NULL`, but the column is nullable in the schema,
		// so without this the relaunch below does not typecheck — and a future
		// edit that loosens the query would silently start passing null.
		const rawFileKey = upload.rawFileKey;
		if (!rawFileKey) continue;
		// Confirm the raw object really is in storage before doing anything. A
		// zero-length or absent object means the upload genuinely failed —
		// leave the row completely untouched.
		if (!(await isRawObjectInStorage(video, rawFileKey))) continue;
		try {
			await startVideoProcessingWorkflow({
				videoId: video.id,
				userId: video.ownerId,
				rawFileKey,
				bucketId: video.bucket,
				processingMessage: "Recovering video processing...",
				startFailureMessage: "Video processing could not be recovered.",
				mode: upload.mode ?? undefined,
				forceRestart: true,
			});
			staleUploadRelaunched++;
		} catch (error) {
			console.error(
				`[recover-stale-ai-jobs] Failed to relaunch processing for video ${video.id}:`,
				error,
			);
		}
	}

	for (const candidate of refinementCandidates) {
		const metadata = candidate.metadata ?? {};
		const current = metadata.timestampRefinement;
		if (!current) continue;
		try {
			const nextMetadata: VideoMetadata = {
				...metadata,
				timestampRefinement: {
					...current,
					status: "ERROR",
					completedAt: new Date().toISOString(),
					error: "failed",
				},
			};
			// Guard the write: only reset if the row is STILL a stale PROCESSING
			// refinement. Prevents stomping a run that completed, or one the user
			// just re-started (the retry-guard in refine-timestamps.ts now allows
			// restarting a stale refinement — its fresh requestedAt fails the
			// `<= refineStaleBeforeIso` check, so this update becomes a no-op).
			await db()
				.update(videos)
				.set({ metadata: nextMetadata })
				.where(
					and(
						eq(videos.id, candidate.id),
						sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.timestampRefinement.status')) = 'PROCESSING'`,
						sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.timestampRefinement.requestedAt')) <= ${refineStaleBeforeIso}`,
					),
				);
			refinementReset++;
		} catch (error) {
			console.error(
				`[recover-stale-ai-jobs] Failed to recover timestamp refinement for video ${candidate.id}:`,
				error,
			);
		}
	}

	return NextResponse.json({
		success: true,
		staleBefore: fastStaleBefore.toISOString(),
		refineStaleBefore: refineStaleBefore.toISOString(),
		retried,
		gaveUp,
		skippedForBatch,
		skippedAlive,
		quotaRetried,
		refinementReset,
		pendingRequestStarted,
		staleUploadRelaunched,
	});
}
