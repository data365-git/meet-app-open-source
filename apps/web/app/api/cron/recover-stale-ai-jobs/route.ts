import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { continueAiJobOnPaid } from "@/lib/ai-job-control";
import { resolveAiSpeedMode } from "@/lib/ai-speed-mode";
import { sendOpsAlert } from "@/lib/ops-alert";
import { startAiGeneration } from "@/lib/generate-ai";
import { transcribeVideo } from "@/lib/transcribe";
import {
	CHEAP_STALE_JOB_THRESHOLD_MS,
	FAST_STALE_JOB_THRESHOLD_MS,
	hasPendingBatchJobs,
	isQuotaRetryDue,
	isTranscriptionJobStale,
	MAX_QUOTA_RETRY_ATTEMPTS,
	shouldAutoFlipCheapJobToPaid,
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

/**
 * Terminal exit shared by the exhausted quota ladder (round-6): when a
 * quota-parked cheap row has used its whole bounded free-retry budget and
 * still cannot proceed, it must END — visibly — rather than sit parked
 * forever behind a spinner. QUOTA code (not FAILED): the recording is fine,
 * the account/quota is the problem, and the share panel already shows the
 * calmer "credits" message with a retry button for that code. The same
 * quotaRetryAttempts budget blocks the quota-ERROR loop from resurrecting it.
 */
async function markQuotaLadderExhausted(candidate: {
	id: Video.VideoId;
	name: string;
}): Promise<void> {
	await db()
		.update(videos)
		.set({
			transcriptionStatus: "ERROR",
			metadata: sql`JSON_SET(
				COALESCE(${videos.metadata}, JSON_OBJECT()),
				'$.transcriptionError', JSON_OBJECT(
					'code', 'QUOTA',
					'message', ${"Free-quota retry budget exhausted while parked; no discounted Batch was available"},
					'at', ${new Date().toISOString()}
				)
			)`,
		})
		.where(eq(videos.id, candidate.id));
	await sendOpsAlert(
		`Cheap AI job exhausted its free-quota retry budget: ${candidate.id} (${candidate.name})`,
	);
}

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
	const cheapStaleBefore = new Date(now - CHEAP_STALE_JOB_THRESHOLD_MS);
	const fastStaleBeforeIso = fastStaleBefore.toISOString();
	const cheapStaleBeforeIso = cheapStaleBefore.toISOString();
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
				sql`(
					(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiMode')) = 'cheap'
						AND COALESCE(
							JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiProgressAt')),
							JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.processingStartedAt')),
							''
						) <= ${cheapStaleBeforeIso})
					OR
					(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiMode')), 'fast') <> 'cheap'
						AND COALESCE(
							JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiProgressAt')),
							JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.processingStartedAt')),
							''
						) <= ${fastStaleBeforeIso})
				)`,
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
				sql`(
					(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiMode')) = 'cheap'
						AND JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiProcessingStartedAt')) <= ${cheapStaleBeforeIso})
					OR
					(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiMode')), 'fast') <> 'cheap'
						AND JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiProcessingStartedAt')) <= ${fastStaleBeforeIso})
				)`,
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
	let flippedToPaid = 0;
	let skippedForBatch = 0;
	let skippedQuotaWaiting = 0;
	let skippedAlive = 0;
	let quotaRetried = 0;
	let refinementReset = 0;

	for (const candidate of transcriptionCandidates) {
		const metadata = candidate.metadata ?? {};
		try {
			// NOTE: no automatic 4h paid flip for TRANSCRIPTION anymore (owner
			// decision 2026-08-11): cheap now continues on the discounted Batch
			// the moment free fails, so "stuck on free for 4h" is not a state a
			// healthy cheap job can be in. Termination is guaranteed by: the
			// Batch collector (with-Batch rows), the bounded free ladder ending
			// in terminal ERROR below (no-Batch rows), and the bounded stale
			// re-kicks ending in the death branch (crashed rows). The owner's
			// manual "continue on paid" button remains the only cheap→full-price
			// path.
			if (hasPendingBatchJobs(metadata)) {
				// The poll-batch-jobs collector owns this cheap job's pending Batch;
				// re-kicking here would create a duplicate non-idempotent Batch.
				skippedForBatch++;
			} else if (
				metadata.aiMode === "cheap" &&
				metadata.aiQuotaWaiting === true
			) {
				// Quota-parked WITHOUT a pending Batch (the branch above owns the
				// with-Batch case). This state's owner is THIS loop and its exit is
				// the SAME backoff schedule the quota-ERROR loop uses. BE HONEST
				// about what that buys (round-5 #2): the 4h paid flip is checked
				// FIRST and aiJobStartedAt always exists, so a parked row only
				// reaches the rungs inside the 4h window — in practice ~3 free
				// re-kicks (≈1h, 1.5h, 2.5h after claim), then the flip takes every
				// later tick. That ceiling is DELIBERATE: it is the UI's own
				// promise ("4 soatda avtomatik tezlashadi") and changing it is an
				// owner decision, not a cron patch. A free-quota outage longer
				// than 4h therefore bills a cheap job — by design. The ladder's
				// later rungs are only reachable for quota-ERROR rows, which have
				// no flip. History: re-kicking every tick was hourly-ffmpeg noise
				// (round-3 #5); skipping entirely made paid billing the ONLY exit
				// (round-4 #1).
				if (isQuotaRetryDue(metadata, now)) {
					// Server-side JSON_SET (round-5 #5): the `metadata` in hand is a
					// snapshot from the SELECT at the top of this tick, and a row can
					// legitimately gain aiBatchJobs while earlier candidates await
					// (park sequence = submit Batch -> throw -> markQuotaWaiting). A
					// JS spread would erase that handle and orphan a BILLED Batch.
					const scheduled = withQuotaRetryScheduled(metadata, now);
					await db()
						.update(videos)
						.set({
							metadata: sql`JSON_SET(
								JSON_REMOVE(
									COALESCE(${videos.metadata}, JSON_OBJECT()),
									'$.processingStartedAt',
									'$.aiProgressAt'
								),
								'$.quotaRetryAttempts', ${scheduled.quotaRetryAttempts ?? 1},
								'$.quotaRetryNextAt', ${scheduled.quotaRetryNextAt ?? new Date(now).toISOString()}
							)`,
						})
						.where(eq(videos.id, candidate.id));
					await transcribeVideo(
						candidate.id,
						candidate.ownerId,
						true,
						true,
						"cheap",
					);
					quotaRetried++;
				} else if (
					(metadata.quotaRetryAttempts ?? 0) >= MAX_QUOTA_RETRY_ATTEMPTS
				) {
					// The whole bounded free budget is spent and the row is still
					// parked (no Batch was ever available — e.g. no server paid
					// key). Terminal exit; replaces the removed 4h flip as this
					// state's guaranteed terminator.
					await markQuotaLadderExhausted(candidate);
					gaveUp++;
				} else {
					skippedQuotaWaiting++;
				}
			} else if (!isTranscriptionJobStale(metadata, now)) {
				// Freshness re-check in JS on the row we actually hold: the job has
				// proven life (heartbeat) — chunk progress is the third liveness
				// case that neither aiQuotaWaiting nor aiBatchJobs marks. Never
				// kill a job that is visibly advancing, whatever its total runtime.
				skippedAlive++;
			} else if (shouldAutoRetry(metadata.autoRecoverAttempts, metadata)) {
				const nextMetadata = withIncrementedAutoRecoverAttempts(metadata);
				// Deliberately NOT resetting transcriptionStatus to null: the status
				// must never pass through NULL on a re-kick — a page load in that
				// window reads NULL and renders "start AI analysis?" for a job that
				// is alive. transcribeVideo(isRetry=true) re-claims a PROCESSING row
				// in place. The re-kick also carries the job's own resolved speed
				// mode so the owner's cheap choice survives the restart.
				await db()
					.update(videos)
					.set({ metadata: nextMetadata })
					.where(eq(videos.id, candidate.id));
				await transcribeVideo(
					candidate.id,
					candidate.ownerId,
					true,
					true,
					resolveAiSpeedMode(nextMetadata.aiMode),
				);
				retried++;
			} else {
				// Retries exhausted (cheap or fast alike): terminal ERROR + ops
				// alert. No automatic paid rescue for cheap — the owner's rule
				// allows paid only via the discounted Batch (already attempted on
				// every re-kick) or his own explicit "continue on paid" click.
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
			// ERROR passes transcribeVideo's start guard on its own). The re-kick
			// carries the job's resolved mode so a cheap choice stays cheap.
			await db()
				.update(videos)
				.set({ metadata: nextMetadata })
				.where(eq(videos.id, candidate.id));
			await transcribeVideo(
				candidate.id,
				candidate.ownerId,
				true,
				true,
				resolveAiSpeedMode(nextMetadata.aiMode),
			);
			quotaRetried++;
		} catch (error) {
			console.error(
				`[recover-stale-ai-jobs] Failed to retry quota-blocked video ${candidate.id}:`,
				error,
			);
		}
	}

	for (const candidate of aiGenerationCandidates) {
		const metadata = candidate.metadata ?? {};
		try {
			if (shouldAutoFlipCheapJobToPaid(metadata, now)) {
				console.warn(
					`[recover-stale-ai-jobs] Cheap AI generation job exceeded 4h; continuing on paid: ${candidate.id}`,
				);
				const result = await continueAiJobOnPaid({
					videoId: candidate.id,
					ownerId: candidate.ownerId,
					phase: "generation",
				});
				if (!result.success) {
					throw new Error(result.message);
				}
				flippedToPaid++;
				retried++;
			} else if (shouldAutoRetry(metadata.autoRecoverAttempts, metadata)) {
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
		cheapStaleBefore: cheapStaleBefore.toISOString(),
		refineStaleBefore: refineStaleBefore.toISOString(),
		retried,
		gaveUp,
		flippedToPaid,
		skippedForBatch,
		skippedQuotaWaiting,
		skippedAlive,
		quotaRetried,
		refinementReset,
	});
}
