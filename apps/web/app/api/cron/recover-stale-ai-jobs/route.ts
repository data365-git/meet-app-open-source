import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { sendOpsAlert } from "@/lib/ops-alert";
import { startAiGeneration } from "@/lib/generate-ai";
import { transcribeVideo } from "@/lib/transcribe";
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
				sql`JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiProcessingStartedAt')) <= ${fastStaleBeforeIso}`,
			),
		);

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
	});
}
