import type { VideoMetadata } from "@cap/database/types";

export const FAST_STALE_JOB_THRESHOLD_MS = 60 * 60 * 1000;
export const CHEAP_STALE_JOB_THRESHOLD_MS = 20 * 60 * 1000;
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
