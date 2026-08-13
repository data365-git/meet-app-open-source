/**
 * Per-JOB health of the FREE Gemini tier (review round-11 ship-blocker).
 *
 * The two failure modes this balances, both real:
 *  - Falling to paid on the FIRST real free error re-opens the owner's
 *    original money defect (a transient free hiccup silently bills paid
 *    while free quota is intact) — that bug shipped three times.
 *  - NEVER falling to paid turns a persistently broken free key (revoked /
 *    invalid `GEMINI_API_KEY_FREE` — a 400/403 that `isQuotaLikeAiError`
 *    correctly does not match) into a permanent, product-unrecoverable
 *    failure: every chunk retries the same dead key, the recovery cron
 *    re-kicks into the same wall, terminal ERROR, and the user's Retry
 *    repeats it forever.
 *
 * The rule: a single genuine (non-quota, non-deadline) free failure still
 * surfaces as the real error it is — no paid billing. Only after
 * MAX_CONSECUTIVE_GENUINE_FREE_FAILURES in a row for the SAME job is the
 * free key treated as unusable FOR THAT JOB, which is a classified fact the
 * paid-key gate accepts (`freeAttempted: true` — the free chain genuinely
 * had its chance). A free success clears the streak. Quota answers and
 * probe deadlines are neutral: they are not evidence of a broken key.
 *
 * In-memory by design: the workflow runs inline in one process, so the
 * streak spans a job's chunk retries; a cron re-kick in a fresh process
 * simply re-proves the breakage (a few free attempts) before paying —
 * bounded either way.
 */

const MAX_CONSECUTIVE_GENUINE_FREE_FAILURES = 3;

const genuineFailureStreak = new Map<string, number>();

/** True when this job's free chain has proven persistently broken. */
export function isFreeTierUnusable(videoId: string): boolean {
	return (
		(genuineFailureStreak.get(videoId) ?? 0) >=
		MAX_CONSECUTIVE_GENUINE_FREE_FAILURES
	);
}

/**
 * Record one genuine (non-quota, non-deadline) free failure for this job.
 * Returns true when the streak has now crossed the bound — i.e. the caller
 * may continue on paid with `freeAttempted: true` as a classified fact.
 */
export function recordGenuineFreeFailure(videoId: string): boolean {
	const next = (genuineFailureStreak.get(videoId) ?? 0) + 1;
	genuineFailureStreak.set(videoId, next);
	return next >= MAX_CONSECUTIVE_GENUINE_FREE_FAILURES;
}

/** A free success proves the key works — clear the streak for this job. */
export function recordFreeTierSuccess(videoId: string): void {
	genuineFailureStreak.delete(videoId);
}

/** Test seam: clear all per-job state between tests. */
export function resetFreeTierHealth(): void {
	genuineFailureStreak.clear();
}
