/**
 * Smallest shared deadline helper for the Tez (fast) free-first probes
 * (transcription + summary/refine). Runs `fn` with an AbortController that
 * aborts once at `deadlineMs`, always clears its timer, and exposes a
 * recognizable deadline error. It NEVER invokes the fallback itself — the
 * caller catches and decides. The signal must be threaded into every fetch the
 * probe performs so an abort actually cancels in-flight work (a bare
 * Promise.race would leave fetches running).
 */

export class DeadlineError extends Error {
	readonly deadlineMs: number;
	constructor(deadlineMs: number) {
		super(`Free probe aborted after ${deadlineMs}ms deadline`);
		this.name = "DeadlineError";
		this.deadlineMs = deadlineMs;
	}
}

export function isDeadlineError(error: unknown): boolean {
	if (error instanceof DeadlineError) return true;
	// A fetch aborted via our controller rejects with either our DeadlineError
	// (abort reason) or a DOMException named "AbortError", depending on runtime.
	return (
		typeof error === "object" &&
		error !== null &&
		"name" in error &&
		(error as { name?: unknown }).name === "AbortError"
	);
}

/**
 * Run `fn(signal)` and abort the signal at `deadlineMs`. The abort reason is a
 * `DeadlineError` so callers can distinguish a deadline from an ordinary
 * failure. The timer is always cleared in `finally`.
 */
export async function withDeadline<T>(
	deadlineMs: number,
	fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	const timer = setTimeout(() => {
		controller.abort(new DeadlineError(deadlineMs));
	}, deadlineMs);
	try {
		return await fn(controller.signal);
	} finally {
		clearTimeout(timer);
	}
}
