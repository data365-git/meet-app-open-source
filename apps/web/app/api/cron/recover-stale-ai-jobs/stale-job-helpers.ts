import type { VideoMetadata } from "@cap/database/types";

// Rowless-upload recovery admits only videos created on/after this instant:
// older rows have no metadata.processedAt and would ALL look unprocessed. It
// must be >= the deploy that ships the marker writers (see route.ts).
export const ROWLESS_UPLOAD_CUTOFF = new Date("2026-09-25T23:59:00Z"); // SET TO DEPLOY TIME

export const FAST_STALE_JOB_THRESHOLD_MS = 60 * 60 * 1000;
// This threshold is TIME SINCE LAST PROGRESS (the aiProgressAt heartbeat,
// falling back to processingStartedAt for rows claimed before the heartbeat
// existed), NOT time since the job started. That distinction is the whole
// mechanism: a job's total runtime is unbounded — a 3-hour recording at
// chunk 12/20 is perfectly healthy at minute 61 — but a healthy job always
// advances within minutes (the heartbeat rides the existing per-chunk
// metadata writes, so it costs zero extra write volume). A row that has shown
// NO progress of any kind for a whole hour is crashed, whatever its length.
// History of tuning this as time-since-start, recorded so nobody re-tries
// it: 20min killed healthy long extractions (2026-08-10 treadmill); 4h made
// the free re-kick unreachable behind the paid flip; 60min-since-start
// killed healthy 2-3h recordings mid-chunk. The number stopped being
// load-bearing when the clock became time-since-progress.
// (2026-08-13: the fast/cheap mode split is deleted — ONE threshold for every
// row; legacy rows still carrying aiMode in metadata get the same window.)

/** The job's last evidence of life: the progress heartbeat, or the claim
 * time for rows that never got a heartbeat (pre-heartbeat claims). */
export function lastTranscriptionProgressAt(
	metadata: VideoMetadata,
): string | undefined {
	return metadata.aiProgressAt ?? metadata.processingStartedAt;
}

/** Pure decision: has this transcription job shown NO evidence of life for
 * longer than its threshold? No marker at all = handed over / never claimed
 * = stale (safe to take). */
export function isTranscriptionJobStale(
	metadata: VideoMetadata,
	nowMs = Date.now(),
	thresholdMs = FAST_STALE_JOB_THRESHOLD_MS,
): boolean {
	const last = lastTranscriptionProgressAt(metadata);
	if (!last) return true;
	const lastMs = Date.parse(last);
	return !Number.isFinite(lastMs) || nowMs - lastMs > thresholdMs;
}
const MAX_AUTO_RETRY_ATTEMPTS = 2;

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

/** Pure schedule check shared by BOTH quota-blocked shapes — terminal ERROR
 * rows (code QUOTA) and cheap rows PARKED in PROCESSING + aiQuotaWaiting with
 * no durable Batch (the no-paid-key / failed-submit deployment). One ladder,
 * one owner, one budget: free re-kicks at the backoff cadence until the
 * bounded budget runs out. */
export function isQuotaRetryDue(
	metadata: VideoMetadata,
	nowMs = Date.now(),
): boolean {
	if ((metadata.quotaRetryAttempts ?? 0) >= MAX_QUOTA_RETRY_ATTEMPTS)
		return false;
	if (!metadata.quotaRetryNextAt) return true;
	const nextMs = Date.parse(metadata.quotaRetryNextAt);
	return !Number.isFinite(nextMs) || nextMs <= nowMs;
}

/** Pure decision: may this quota-blocked (terminal ERROR) video be re-kicked
 * right now? */
export function shouldRetryQuotaBlocked(
	metadata: VideoMetadata,
	nowMs = Date.now(),
): boolean {
	if (!isQuotaBlocked(metadata)) return false;
	return isQuotaRetryDue(metadata, nowMs);
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
 * collector, not this recovery cron — skip the normal stale re-kick for it.
 * (Legacy-only since round 8: nothing submits new Batch jobs; the collector
 * exists solely to drain in-flight ones.) */
export function hasPendingBatchJobs(metadata: VideoMetadata): boolean {
	return Array.isArray(metadata.aiBatchJobs) && metadata.aiBatchJobs.length > 0;
}

/** Pure decision: does this video still get an automatic re-kick, or has it
 * used up its retries? The old cheap+aiQuotaWaiting exemption is GONE
 * (round-9 #2): it was only safe while the quota-ladder branch bounded those
 * rows first, and that branch was deleted in round 8 — an unbounded
 * exemption would let a legacy parked row re-kick forever. */
export function shouldAutoRetry(attempts: number | undefined): boolean {
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
		// Handing the row over: the heartbeat must go too, or the retry
		// re-claim guard would read the OLD heartbeat and misjudge liveness in
		// either direction. A workflow that is secretly still alive will
		// re-stamp it before the re-claim reads, which is exactly the race the
		// guard exists to catch.
		aiProgressAt: undefined,
		// Counts for EVERY row — quota-parked included (round-9 #2).
		autoRecoverAttempts: (metadata.autoRecoverAttempts ?? 0) + 1,
	};
	return next;
}
