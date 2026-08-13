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
 * The rule (tightened in round-12 #1): ONLY the permanent auth family —
 * HTTP 400/401/403, API_KEY_INVALID, PERMISSION_DENIED, the same errors
 * gemini-transcribe classifies `permanent` — counts as evidence of a broken
 * key. A 503 overload, a socket reset or an empty/unusable result NEVER
 * moves the streak: those surface as the real errors they are and the paid
 * path stays closed. Even a permanent-family error surfaces until
 * MAX_CONSECUTIVE_GENUINE_FREE_FAILURES accumulate for the SAME job; only
 * then is the free key treated as unusable FOR THAT JOB — a classified fact
 * the paid-key gate accepts (`freeAttempted: true`). A free success clears
 * the streak, and BOTH phase launchers clear it at job start, so a Retry
 * after the key is fixed always begins on free. Quota answers and probe
 * deadlines are neutral throughout.
 *
 * In-memory by design: the workflow runs inline in one process, so the
 * streak spans a job's chunk retries; a cron re-kick in a fresh process
 * simply re-proves the breakage (a few free attempts) before paying —
 * bounded either way.
 */

const MAX_CONSECUTIVE_GENUINE_FREE_FAILURES = 3;

const genuineFailureStreak = new Map<string, number>();

/**
 * Evidence of a BROKEN/REVOKED free key: the permanent auth family only.
 * Transcription tags these errors `permanent` upstream, but both phases'
 * messages carry the status, so the message is the shared signal. Everything
 * else — 5xx overloads, socket errors, deadline aborts, empty or unusable
 * output — is NOT evidence and must never move the streak.
 */
export function isBrokenFreeKeyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /HTTP (400|401|403)\b|\b40[013] |API[_ ]?KEY[_ ]?INVALID|API key not valid|PERMISSION_DENIED/i.test(
		message,
	);
}

/** True when this job's free chain has proven persistently broken. */
export function isFreeTierUnusable(videoId: string): boolean {
	return (
		(genuineFailureStreak.get(videoId) ?? 0) >=
		MAX_CONSECUTIVE_GENUINE_FREE_FAILURES
	);
}

/**
 * Record one broken-key signal (an isBrokenFreeKeyError failure) for this
 * job. Returns true when the streak has now crossed the bound — i.e. the
 * caller may continue on paid with `freeAttempted: true` as a classified
 * fact. The CALLER classifies; this function only counts.
 */
export function recordBrokenFreeKeySignal(videoId: string): boolean {
	const next = (genuineFailureStreak.get(videoId) ?? 0) + 1;
	genuineFailureStreak.set(videoId, next);
	return next >= MAX_CONSECUTIVE_GENUINE_FREE_FAILURES;
}

/** A free success proves the key works — clear the streak for this job. */
export function recordFreeTierSuccess(videoId: string): void {
	genuineFailureStreak.delete(videoId);
}

/** Job-start reset (round-12 #1b): a fresh start — the owner's Retry, a cron
 * re-kick — must give a possibly-fixed free key its chance again instead of
 * inheriting a stale verdict from a previous run. */
export function clearFreeTierStreak(videoId: string): void {
	genuineFailureStreak.delete(videoId);
}

/** Test seam: clear all per-job state between tests. */
export function resetFreeTierHealth(): void {
	genuineFailureStreak.clear();
}
