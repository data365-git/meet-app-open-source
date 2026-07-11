import { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { and, eq, isNull, sql } from "drizzle-orm";
import { NextResponse } from "next/server";
import { continueAiJobOnPaid } from "@/lib/ai-job-control";
import { sendOpsAlert } from "@/lib/ops-alert";
import { startAiGeneration } from "@/lib/generate-ai";
import { transcribeVideo } from "@/lib/transcribe";

export const dynamic = "force-dynamic";

const FAST_STALE_JOB_THRESHOLD_MS = 60 * 60 * 1000;
const CHEAP_STALE_JOB_THRESHOLD_MS = 20 * 60 * 1000;
const CHEAP_AUTO_PAID_AFTER_MS = 4 * 60 * 60 * 1000;
const MAX_AUTO_RETRY_ATTEMPTS = 2;

export function staleThresholdMsForMetadata(metadata: VideoMetadata): number {
	return metadata.aiMode === "cheap"
		? CHEAP_STALE_JOB_THRESHOLD_MS
		: FAST_STALE_JOB_THRESHOLD_MS;
}

export function shouldAutoFlipCheapJobToPaid(
	metadata: VideoMetadata,
	nowMs = Date.now(),
): boolean {
	if (metadata.aiMode !== "cheap") return false;
	if (!metadata.aiJobStartedAt) return false;
	const startedMs = Date.parse(metadata.aiJobStartedAt);
	return Number.isFinite(startedMs) && nowMs - startedMs > CHEAP_AUTO_PAID_AFTER_MS;
}

export function shouldCountStaleJobTowardDeath(
	metadata: VideoMetadata,
): boolean {
	return !(metadata.aiMode === "cheap" && metadata.aiQuotaWaiting === true);
}

/** A cheap job with a pending durable Batch is owned by the poll-batch-jobs
 * collector, not this recovery cron. Skip the normal stale re-kick for it —
 * EXCEPT the four-hour paid flip, which is checked first and always wins. */
export function hasPendingBatchJobs(metadata: VideoMetadata): boolean {
	return Array.isArray(metadata.aiBatchJobs) && metadata.aiBatchJobs.length > 0;
}

/** Pure decision: does this video still get an automatic re-kick, or has it used up its retries? */
export function shouldAutoRetry(
	attempts: number | undefined,
	metadata: VideoMetadata = {},
): boolean {
	if (!shouldCountStaleJobTowardDeath(metadata)) return true;
	return (attempts ?? 0) < MAX_AUTO_RETRY_ATTEMPTS;
}

/** Metadata after incrementing the auto-recover attempt counter, resetting the stale processing markers. */
export function withIncrementedAutoRecoverAttempts(
	metadata: VideoMetadata,
): VideoMetadata {
	const next: VideoMetadata = {
		...metadata,
		processingStartedAt: undefined,
		aiProcessingStartedAt: undefined,
	};
	if (shouldCountStaleJobTowardDeath(metadata)) {
		next.autoRecoverAttempts = (metadata.autoRecoverAttempts ?? 0) + 1;
	}
	return next;
}

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
				sql`(
					(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiMode')) = 'cheap'
						AND JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.processingStartedAt')) <= ${cheapStaleBeforeIso})
					OR
					(COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.aiMode')), 'fast') <> 'cheap'
						AND JSON_UNQUOTE(JSON_EXTRACT(${videos.metadata}, '$.processingStartedAt')) <= ${fastStaleBeforeIso})
				)`,
			),
		);

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

	let retried = 0;
	let gaveUp = 0;
	let flippedToPaid = 0;
	let skippedForBatch = 0;

	for (const candidate of transcriptionCandidates) {
		const metadata = candidate.metadata ?? {};
		try {
			if (shouldAutoFlipCheapJobToPaid(metadata, now)) {
				console.warn(
					`[recover-stale-ai-jobs] Cheap transcription job exceeded 4h; continuing on paid: ${candidate.id}`,
				);
				const result = await continueAiJobOnPaid({
					videoId: candidate.id,
					ownerId: candidate.ownerId,
					phase: "transcription",
				});
				if (!result.success) {
					throw new Error(result.message);
				}
				flippedToPaid++;
				retried++;
			} else if (hasPendingBatchJobs(metadata)) {
				// The poll-batch-jobs collector owns this cheap job's pending Batch;
				// re-kicking here would create a duplicate non-idempotent Batch.
				skippedForBatch++;
			} else if (shouldAutoRetry(metadata.autoRecoverAttempts, metadata)) {
				const nextMetadata = withIncrementedAutoRecoverAttempts(metadata);
				await db()
					.update(videos)
					.set({ transcriptionStatus: null, metadata: nextMetadata })
					.where(eq(videos.id, candidate.id));
				await transcribeVideo(candidate.id, candidate.ownerId, true);
				retried++;
			} else {
				await db()
					.update(videos)
					.set({ transcriptionStatus: "ERROR" })
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

	return NextResponse.json({
		success: true,
		staleBefore: fastStaleBefore.toISOString(),
		cheapStaleBefore: cheapStaleBefore.toISOString(),
		retried,
		gaveUp,
		flippedToPaid,
		skippedForBatch,
	});
}
