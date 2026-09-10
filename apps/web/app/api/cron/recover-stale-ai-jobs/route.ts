import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, inArray, isNull, like, lte, or, sql } from "drizzle-orm";
import { Effect, Schedule } from "effect";
import { NextResponse } from "next/server";
import { getAffectedRows } from "@/lib/affected-rows";
import { bankedStartRequestsFullAnalysis } from "@/lib/ai-generation-request";
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

// How many stale rows to LOOK at per tick. Deliberately much larger than the
// number we may relaunch: most candidates are cheap to reject (a storage HEAD),
// and a small SELECT let permanently dead rows starve the live ones.
const STALE_UPLOAD_SCAN_LIMIT = 50;
// How many may actually be relaunched per tick — the expensive part, since the
// relaunch runs ffmpeg inline in this process. Same figure the neighbouring
// recovery loops use.
const STALE_UPLOAD_RELAUNCH_LIMIT = 3;

// Only the upload-completion routes write a `raw-upload.*` object; an edit row
// carries `<owner>/<video>/source/original.mp4` and an admin reprocess carries
// `result.mp4`. Relaunching those would re-encode the wrong source.
function isRawUploadKey(key: string): boolean {
	const lastSegment = key.split("/").pop() ?? "";
	return lastSegment.startsWith("raw-upload.");
}

// Storage is the only trustworthy source for "the bytes really are all
// there" — the row alone says nothing about a multipart that never assembled.
type RawObjectProbe = "present" | "absent" | "unknown";

// TRI-STATE ON PURPOSE. A blind review caught that collapsing this to a boolean
// makes "storage unreachable" indistinguishable from "object genuinely gone" —
// and the caller RETIRES an absent row, so one expired bucket credential or a
// brief S3 outage would have condemned up to a whole scan's worth of healthy,
// bytes-present uploads with a false "Upload never completed", which only a
// manual retry can undo and the affected user never clicks.
//
// `S3BucketAccess.headObject` rethrows a real 404 as an Error named NoSuchKey
// and passes every other failure through untouched, so that name is the only
// thing allowed to mean "absent".
async function probeRawObject(
	video: typeof videos.$inferSelect,
	rawFileKey: string,
): Promise<RawObjectProbe> {
	try {
		const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
		const head = await bucket
			.headObject(rawFileKey)
			.pipe(
				Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
				runPromise,
			);
		return (head.ContentLength ?? 0) > 0 ? "present" : "absent";
	} catch (error) {
		return isNotFoundError(error) ? "absent" : "unknown";
	}
}

// Is this rejection a genuine "the object is not there", as opposed to any
// other storage failure?
//
// The name has to be dug out rather than read off the top: a rejection from
// `runPromise` is an Effect FiberFailure whose real error sits inside a Cause
// under `cause`, and the S3 layer wraps it again in an S3Error. So walk the
// small set of fields those wrappers use, bounded in both depth and breadth so
// a cyclic or huge object can never turn this into a hang.
const NOT_FOUND_NAMES = new Set(["NoSuchKey", "NotFound"]);

// MEASURED, not assumed: a rejection out of `runPromise` is a FiberFailureImpl
// whose only own fields are stack/message/name, and whose name is the string
// "(FiberFailure) NoSuchKey" - the original name is folded into that label
// rather than kept in a nested field. So strip the label before comparing, and
// compare the NAME only. Matching the message instead would fire on any error
// that merely mentions the key.
function isNotFoundName(name: string): boolean {
	const bare = name.replace(/^\(FiberFailure\)\s*/, "").trim();
	return NOT_FOUND_NAMES.has(name) || NOT_FOUND_NAMES.has(bare);
}
const WRAPPER_FIELDS = ["cause", "error", "defect", "failure", "left"] as const;

function isNotFoundError(error: unknown): boolean {
	const queue: unknown[] = [error];
	const seen = new Set<unknown>();
	while (queue.length > 0 && seen.size < 40) {
		const current = queue.shift();
		if (current === null || typeof current !== "object" || seen.has(current)) {
			continue;
		}
		seen.add(current);
		const named = current as Record<string, unknown>;
		if (typeof named.name === "string" && isNotFoundName(named.name)) {
			return true;
		}
		for (const field of WRAPPER_FIELDS) {
			if (named[field] !== undefined) queue.push(named[field]);
		}
	}
	return false;
}

// Resolve the raw-upload key to relaunch from, and confirm its bytes are
// really in storage.
//
// `recorded` is whatever the row carries, which on the real production
// incident was NULL for every stuck row. In that case the key is derivable:
// create-for-processing.ts and loom.ts both build
// `<ownerId>/<videoId>/raw-upload.mp4`, and replace-with-audio.ts treats
// `.mp4` and `.webm` as the two raw-upload names, so those are the only
// candidates worth probing.
//
// Returns the key whose object exists and is non-empty; "absent" only when
// storage said so plainly, and "unknown" when it could not be asked at all.
async function resolveRawUploadKey(
	video: typeof videos.$inferSelect,
	recorded: string | null,
): Promise<
	| { status: "present"; key: string }
	| { status: "absent" }
	| { status: "unknown" }
> {
	const candidates = recorded
		? [recorded]
		: [
				`${video.ownerId}/${video.id}/raw-upload.mp4`,
				`${video.ownerId}/${video.id}/raw-upload.webm`,
			];
	let sawUnknown = false;
	for (const key of candidates) {
		const probe = await probeRawObject(video, key);
		if (probe === "present") return { status: "present", key };
		if (probe === "unknown") sawUnknown = true;
	}
	// One unreadable candidate is enough to withhold a verdict: retiring a row
	// on a storage failure is the damaging direction.
	return sawUnknown ? { status: "unknown" } : { status: "absent" };
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
	// Rows retired because their object never appeared - reported so a spike is
	// visible instead of silent.
	let staleUploadRetired = 0;

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
			// The banked MODE is the run's switch (2026-09-10): this cron redeems
			// the same upload-time press as process-video.ts, carrying the mode the
			// press banked - "Only transcript" starts transcription only (false);
			// "Full AI analysis" chains the summary and tasks in the same run
			// (true) with no second press. An explicit flag, not the durable-marker
			// OR, so the 2026-09-05 no-op cannot repeat.
			const wantsFullAnalysis = bankedStartRequestsFullAnalysis(
				(candidate.metadata as VideoMetadata) ?? {},
			);
			const result = await transcribeVideo(
				candidate.id,
				candidate.ownerId,
				wantsFullAnalysis,
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
							'$.aiStartPendingUpload',
							'$.aiStartMode'
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
	// lost". The relaunch is safe to repeat because THIS loop claims the row
	// with its own conditional UPDATE below before launching anything — and
	// because the transcription claim in lib/transcribe.ts is a compare-and-set,
	// so even a duplicate hand-off launches nothing paid.
	// The SCAN is wide, the RELAUNCH is capped at 3 (enforced in JS below,
	// where ffmpeg is actually launched). A blind review caught that limiting
	// the SELECT to 3 and only then checking storage lets three permanently
	// dead rows — created with a rawFileKey at phase 'uploading' and then
	// abandoned, so their object never appeared and nothing ever removes them —
	// starve every genuinely stuck row forever. The safety net would have
	// existed and never fired, which is the failure mode it was built to end.
	const staleUploadCandidates: StaleUploadCandidate[] = await db()
		.select({ video: videos, upload: videoUploads })
		.from(videos)
		.innerJoin(videoUploads, eq(videoUploads.videoId, videos.id))
		.where(
			and(
				isNull(videos.deletedAt),
				inArray(videoUploads.phase, ["uploading", "processing"]),
				lte(videoUploads.updatedAt, staleUploadBefore),
				// MEASURED ON PRODUCTION 2026-09-10, and it decides this query:
				// the real stuck rows carry `raw_file_key IS NULL` AND
				// `mode IS NULL` — including the two from the incident this pass
				// exists for. An earlier version required the column to be set
				// and would therefore have recovered NOTHING, which is the same
				// mistake as the marker the old cron keyed on: a condition only
				// the successful path fills in.
				//
				// So: admit a row whose key is EMPTY (we derive the canonical
				// one below), and otherwise only a key the upload-completion
				// routes wrote. An edit row carries
				// `<owner>/<video>/source/original.mp4` and an admin-reprocess
				// row carries `result.mp4`; relaunching either would re-encode
				// the PRE-EDIT original — silently reverting a user's trim — or
				// re-encode result.mp4 onto itself. Both always have a non-null
				// key, so this predicate keeps excluding them.
				or(
					isNull(videoUploads.rawFileKey),
					like(videoUploads.rawFileKey, "%/raw-upload.%"),
				),
			),
		)
		.limit(STALE_UPLOAD_SCAN_LIMIT);

	for (const candidate of staleUploadCandidates) {
		const { video, upload } = candidate;
		// Hard cap mirroring the SQL LIMIT, so a future edit of that query can
		// never fan inline ffmpeg launches wider than the neighbouring loops.
		if (staleUploadRelaunched >= STALE_UPLOAD_RELAUNCH_LIMIT) break;
		// Freshness re-check in JS on the row we actually hold (same law as the
		// transcription loop above): never relaunch an upload that is still
		// visibly landing bytes.
		if (upload.updatedAt.getTime() > staleUploadBefore.getTime()) continue;
		// Belt and suspenders on the SQL filter above: a key that IS set must be
		// an upload-completion key, never an edit source or a result.mp4.
		if (upload.rawFileKey && !isRawUploadKey(upload.rawFileKey)) continue;
		// Resolve the key. When the row never recorded one — the shape the real
		// production incident had — probe the canonical raw-upload names in
		// turn. `create-for-processing.ts` and `loom.ts` both build exactly
		// `<ownerId>/<videoId>/raw-upload.mp4`, and `replace-with-audio.ts`
		// treats `.mp4` and `.webm` as the two raw-upload names, so those are
		// the only candidates.
		const resolved = await resolveRawUploadKey(video, upload.rawFileKey);
		// Storage could not answer. Say nothing and try again next tick: a
		// retirement here would condemn a healthy upload on an S3 blip.
		if (resolved.status === "unknown") continue;
		if (resolved.status === "absent") {
			// The object is genuinely gone (a real NoSuchKey) and the row has
			// been quiet for the whole staleness window: this upload failed.
			// Retire the row so it stops occupying the candidate set on every
			// future tick and the UI stops implying an upload is in flight.
			try {
				const retire = await db()
					.update(videoUploads)
					.set({
						phase: "error",
						processingError: "Upload never completed",
						updatedAt: new Date(),
					})
					.where(
						and(
							eq(videoUploads.videoId, video.id),
							inArray(videoUploads.phase, ["uploading", "processing"]),
							lte(videoUploads.updatedAt, staleUploadBefore),
						),
					);
				// Count only writes that landed, so the number stays a number he
				// can act on rather than an attempt counter.
				if (getAffectedRows(retire) > 0) staleUploadRetired++;
			} catch (error) {
				console.error(
					`[recover-stale-ai-jobs] Failed to retire the dead upload row for video ${video.id}:`,
					error,
				);
			}
			continue;
		}
		const rawFileKey = resolved.key;
		// CLAIM THE ROW FIRST, conditionally. `forceRestart` deliberately drops
		// the phase guard inside startVideoProcessingWorkflow, and the freshness
		// check above reads the SELECT snapshot rather than the live row — so
		// without this a row claimed by a real upload completing in that window
		// would receive a SECOND concurrent processVideoWorkflow and two ffmpeg
		// runs would race on result.mp4. The transcription compare-and-set
		// protects money, not the media. This UPDATE is the claim: if it changes
		// no row, somebody else owns it and we walk away.
		//
		// `updatedAt` is stamped because the column has no ON UPDATE clause;
		// without it a claimed row whose launch then throws keeps its stale
		// timestamp and is re-claimed on every tick with no backoff, occupying
		// a relaunch slot forever — the starvation shape through another door.
		let claimed = false;
		try {
			const claim = await db()
				.update(videoUploads)
				.set({
					phase: "processing",
					processingMessage: "Recovering...",
					updatedAt: new Date(),
				})
				.where(
					and(
						eq(videoUploads.videoId, video.id),
						inArray(videoUploads.phase, ["uploading", "processing"]),
						lte(videoUploads.updatedAt, staleUploadBefore),
					),
				);
			claimed = getAffectedRows(claim) > 0;
		} catch (error) {
			// A failed claim must not abort the rest of this cron run — the
			// timestamp-refinement loop still has work to do after this one.
			console.error(
				`[recover-stale-ai-jobs] Failed to claim the stale upload row for video ${video.id}:`,
				error,
			);
		}
		if (!claimed) continue;
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
		staleUploadRetired,
	});
}
