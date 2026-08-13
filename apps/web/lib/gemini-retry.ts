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
 * Calls `fn` up to `maxAttempts` times, retrying only on transient Gemini
 * errors (HTTP 429/500/501/503, "overloaded", "high demand", "UNAVAILABLE").
 * Delays: 1s → 2s → 4s → 8s → 8s (capped) + up to 500ms random jitter.
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
			// backoff on the paid leg.
			const isTransient =
				/\b(429|500|501|503)\b|overloaded|high demand|unavailable/i.test(
					message,
				);
			if (
				permanent ||
				!isTransient ||
				attempt === maxAttempts - 1 ||
				signal?.aborted
			)
				throw err;
			const baseDelay = Math.min(1000 * Math.pow(2, attempt), 8000);
			const jitter = Math.floor(Math.random() * 500);
			await sleepWithAbort(baseDelay + jitter, signal);
		}
	}
	throw lastError;
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
