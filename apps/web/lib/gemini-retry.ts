/** Returns true for transient Gemini overload / rate-limit errors that are safe to retry. */
export function isTransientGeminiError(status: number, body: string): boolean {
	if (status === 429 || status === 500 || status === 501 || status === 503)
		return true;
	const lower = body.toLowerCase();
	return (
		lower.includes("overloaded") ||
		lower.includes("high demand") ||
		lower.includes("unavailable")
	);
}

/**
 * The ONE message-level transient pattern (word boundaries on the digits so a
 * project number like 763029500123 does not look transient — round-16 #3).
 * Exported so the share-page classifier and the ERROR write-site flag reuse
 * this copy instead of growing a second one.
 */
const TRANSIENT_GEMINI_MESSAGE_RE =
	/\b(429|500|501|503)\b|overloaded|high demand|unavailable/i;

/** True when a raw or sanitized error MESSAGE carries transient evidence. */
export function isTransientGeminiMessage(message: string): boolean {
	return TRANSIENT_GEMINI_MESSAGE_RE.test(message);
}

/**
 * Per-call opt-in knobs. Default behaviour (no options passed) is byte-for-byte
 * the old 8s-capped exponential backoff, so `gemini-batch-transcribe.ts` and
 * every other existing caller is unaffected.
 */
export interface GeminiRetryOptions {
	/** Honour the `RetryInfo.retryDelay` a 429 body carries (e.g. `"34s"`)
	 * instead of the exponential-backoff ceiling. Opt-in per call site. */
	honorRetryDelay?: boolean;
	/** Overrides the 8s backoff ceiling used when no retryDelay is honoured. */
	maxDelayMs?: number;
}

/**
 * Calls `fn` up to `maxAttempts` times, retrying only on transient Gemini
 * errors (HTTP 429/500/501/503, "overloaded", "high demand", "UNAVAILABLE").
 * Delays: 1s → 2s → 4s → 8s → 8s (capped) + up to 500ms random jitter, unless
 * `options.maxDelayMs` raises the ceiling or `options.honorRetryDelay` finds a
 * `retryDelay` in the error body, in which case that wait is used instead.
 *
 * Pass `maxAttempts = 1` for a single bounded probe (no backoff). An optional
 * `signal` short-circuits the loop and wakes the backoff sleep immediately when
 * aborted (the Tez free-probe deadline), so an aborted probe never sits in a
 * retry delay.
 */
export async function withGeminiRetry<T>(
	fn: () => Promise<T>,
	maxAttempts = 5,
	signal?: AbortSignal,
	options?: GeminiRetryOptions,
): Promise<T> {
	let lastError: unknown;
	for (let attempt = 0; attempt < maxAttempts; attempt++) {
		if (signal?.aborted) throw signal.reason ?? new Error("aborted");
		try {
			return await fn();
		} catch (err) {
			lastError = err;
			const message = err instanceof Error ? err.message : String(err);
			const permanent = (err as { permanent?: boolean })?.permanent === true;
			// Word boundaries on the digits (round-16 #3): messages now carry the
			// upstream response body, and a project number like 763029500123
			// contains "500" — a permanent 403 must not look transient and burn
			// backoff on the paid leg. Same single pattern the share-page
			// classifier reuses (isTransientGeminiMessage).
			const isTransient = isTransientGeminiMessage(message);
			if (
				permanent ||
				!isTransient ||
				attempt === maxAttempts - 1 ||
				signal?.aborted
			)
				throw err;
			const ceiling = options?.maxDelayMs ?? 8000;
			let baseDelay = Math.min(1000 * Math.pow(2, attempt), ceiling);
			if (options?.honorRetryDelay) {
				const retryDelayMs = parseRetryDelay(message);
				// Clamp to the same ceiling as the exponential base: an honored
				// body can carry a multi-hour retryDelay (e.g. "35994s"), and
				// without this clamp that sleeps for hours inside a chat request.
				if (retryDelayMs !== null) baseDelay = Math.min(retryDelayMs, ceiling);
			}
			const jitter = Math.floor(Math.random() * 500);
			await sleepWithAbort(baseDelay + jitter, signal);
		}
	}
	throw lastError;
}

/** Extracts the seconds from a `"retryDelay": "34s"` RetryInfo detail, if present. */
function parseRetryDelay(message: string): number | null {
	const match = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/);
	const seconds = match?.[1];
	if (!seconds) return null;
	return Math.round(parseFloat(seconds) * 1000);
}

/** Sleep that resolves after `ms` or as soon as `signal` aborts (so a bounded
 * probe never blocks in a backoff delay past its deadline). */
function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			signal?.removeEventListener?.("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timer);
				resolve();
				return;
			}
			signal.addEventListener?.("abort", onAbort, { once: true });
		}
	});
}
