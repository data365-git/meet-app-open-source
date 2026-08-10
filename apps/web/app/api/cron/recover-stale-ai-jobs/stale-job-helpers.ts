import type { VideoMetadata } from "@cap/database/types";

export const FAST_STALE_JOB_THRESHOLD_MS = 60 * 60 * 1000;
const CHEAP_AUTO_PAID_AFTER_MS = 4 * 60 * 60 * 1000;
// Cheap staleness is NOT a wall-clock judgment on the patient path itself —
// the things that make cheap legitimately slow both leave evidence of life
// (aiQuotaWaiting for a parked free-quota wait, aiBatchJobs for a pending
// durable Batch) and the recovery loop already treats those specially
// (quota waits are exempt from the death counter; Batch rows are skipped for
// the collector). What this threshold detects is a cheap row with NEITHER
// marker: its claim/extract/transcribe machinery is the same as fast's, so a
// silent hour means the same thing it means for fast — a crashed run. Keeping
// it well under CHEAP_AUTO_PAID_AFTER_MS is what guarantees a crashed cheap
// job gets FREE re-kicks (bounded by MAX_AUTO_RETRY_ATTEMPTS) before the 4h
// paid flip ever spends money against the owner's explicit cheap choice.
// History: 20min killed healthy long extractions every tick (2026-08-10
// treadmill); 4h made the free re-kick branch unreachable because the flip
// (checked first, keyed on the preserved aiJobStartedAt) was already due the
// moment a row first became eligible.
export const CHEAP_STALE_JOB_THRESHOLD_MS = 60 * 60 * 1000;
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

/**
 * Quota re-kick budget. A flat cap is the wrong shape: at the 30-min cron
 * cadence a 5-attempt cap expires ~2.5h into an outage, which is far sooner
 * than a human tops the account up — every video would burn out before credits
 * returned and nothing would self-heal. Backoff instead: the ladder below
 * spans well over a day while staying bounded, so a misclassified permanent
 * failure still stops.
 */
export const MAX_QUOTA_RETRY_ATTEMPTS = 12;

const QUOTA_RETRY_BACKOFF_MS = [
	30 * 60 * 1000, // 30m
	60 * 60 * 1000, // 1h
	2 * 60 * 60 * 1000,
	4 * 60 * 60 * 1000,
	8 * 60 * 60 * 1000,
	12 * 60 * 60 * 1000, // ceiling, reused for every later attempt
];

/** True when the last transcription attempt died for quota/credits — i.e. the
 * recording is fine and the account merely needs topping up. */
export function isQuotaBlocked(metadata: VideoMetadata): boolean {
	return metadata.transcriptionError?.code === "QUOTA";
}

/** Pure decision: may this quota-blocked video be re-kicked right now? */
export function shouldRetryQuotaBlocked(
	metadata: VideoMetadata,
	nowMs = Date.now(),
): boolean {
	if (!isQuotaBlocked(metadata)) return false;
	if ((metadata.quotaRetryAttempts ?? 0) >= MAX_QUOTA_RETRY_ATTEMPTS)
		return false;
	if (!metadata.quotaRetryNextAt) return true;
	const nextMs = Date.parse(metadata.quotaRetryNextAt);
	return !Number.isFinite(nextMs) || nextMs <= nowMs;
}

/** Metadata after booking one quota re-kick: counter up, next attempt pushed
 * out by the backoff ladder. Everything else is preserved — the counter must
 * survive validateVideo's metadata spread or the loop becomes unbounded. */
export function withQuotaRetryScheduled(
	metadata: VideoMetadata,
	nowMs = Date.now(),
): VideoMetadata {
	const attempts = (metadata.quotaRetryAttempts ?? 0) + 1;
	const backoff =
		QUOTA_RETRY_BACKOFF_MS[attempts - 1] ??
		QUOTA_RETRY_BACKOFF_MS[QUOTA_RETRY_BACKOFF_MS.length - 1] ??
		30 * 60 * 1000;
	return {
		...metadata,
		quotaRetryAttempts: attempts,
		quotaRetryNextAt: new Date(nowMs + backoff).toISOString(),
	};
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
