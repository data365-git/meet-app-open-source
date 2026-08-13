/**
 * Per-JOB verdict on the FREE Gemini tier (round-11 ship-blocker; counter
 * deleted in round-13 #2).
 *
 * The two failure modes this balances, both real:
 *  - Falling to paid on ANY free error re-opens the owner's original money
 *    defect (a transient free hiccup silently bills paid while free quota is
 *    intact) — that bug shipped three times.
 *  - NEVER falling to paid turns a revoked/invalid `GEMINI_API_KEY_FREE`
 *    into a permanent, product-unrecoverable failure: every retry re-runs
 *    the same dead key, terminal ERROR, forever.
 *
 * The protection is the CLASSIFIER, not a counter: only the permanent auth
 * family — HTTP 400/401/403, API_KEY_INVALID, "API key not valid",
 * PERMISSION_DENIED; the same errors gemini-transcribe tags `permanent` —
 * counts as evidence of a broken key. An auth failure is by definition not
 * transient, so ONE occurrence where the whole free chain failed with it is
 * already conclusive: the caller marks the free key unusable FOR THAT JOB
 * and continues on paid immediately. (The earlier 3-strike streak existed
 * only because its trigger included transients; once the trigger was
 * narrowed, the counter had two failure modes of its own — concurrent
 * chunks tripping it on 503 bursts, and the job-start reset making
 * single-call short videos unable to ever reach the bound.)
 *
 * A 503 overload, a socket reset, a deadline abort or an empty/unusable
 * result is NEVER evidence: those surface as the real errors they are and
 * the paid path stays closed. Both phase launchers clear the verdict at job
 * start, so a Retry after the key is fixed always begins on free. Scope is
 * per-job (videoId) and in-memory by design: a cron re-kick in a fresh
 * process simply re-proves the breakage with one free attempt before
 * paying.
 */

const brokenKeyJobs = new Set<string>();

/**
 * Evidence of a BROKEN/REVOKED free key: the permanent auth family only.
 * Transcription tags these errors `permanent` upstream, but both phases'
 * messages carry the status, so the message is the shared signal.
 *
 * Narrowed in round-14 — this classifier is the ONLY thing protecting the
 * money, so every arm must be auth-specific:
 *  - HTTP 401/403 are auth by definition: broad match.
 *  - HTTP 400 is ALSO Gemini's INVALID_ARGUMENT / FAILED_PRECONDITION
 *    (oversized request, unsupported param/region), so 400 counts ONLY
 *    together with an explicit auth token.
 *  - A bare number is NEVER evidence: the old digit arm let a JSON parse
 *    offset ("Unterminated string in JSON at position 400") masquerade as a
 *    revoked key.
 * Everything else — 5xx overloads, socket errors, deadline aborts, empty or
 * unusable output — is NOT evidence and must never open the paid path.
 */
export function isBrokenFreeKeyError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	if (/HTTP (401|403)\b/i.test(message)) return true;
	return (
		/\b400\b/.test(message) &&
		/API[_ ]?KEY[_ ]?INVALID|API key not valid|PERMISSION_DENIED|UNAUTHENTICATED/i.test(
			message,
		)
	);
}

/** True when this job's free key has been judged broken (conclusively). */
export function isFreeTierUnusable(videoId: string): boolean {
	return brokenKeyJobs.has(videoId);
}

/** One full-chain permanent auth failure is conclusive — mark the free key
 * unusable for this job. The CALLER classifies; this only records. */
export function markFreeKeyBrokenForJob(videoId: string): void {
	brokenKeyJobs.add(videoId);
}

/** Job-start reset: a fresh start (the owner's Retry, a cron re-kick) must
 * give a possibly-fixed free key its chance again instead of inheriting a
 * stale verdict from a previous run. */
export function clearFreeTierVerdict(videoId: string): void {
	brokenKeyJobs.delete(videoId);
}

/** Test seam: clear all per-job state between tests. */
export function resetFreeTierHealth(): void {
	brokenKeyJobs.clear();
}
