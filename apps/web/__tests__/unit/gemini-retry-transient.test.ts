import { afterEach, describe, expect, it, vi } from "vitest";

// Round-16 #3: the transient regex reads the (newly appended) response body,
// and without word boundaries a project number like 763029500123 contains
// "500" — a PERMANENT 403 then looks transient and burns ~15s of backoff on
// the paid leg.
import { withGeminiRetry } from "@/lib/gemini-retry";

describe("withGeminiRetry transient detection", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("a permanent 403 whose body contains a project NUMBER is not retried", async () => {
		const fn = vi.fn(async () => {
			throw new Error(
				"Gemini upload init failed (HTTP 403): Permission denied on project 763029500123.",
			);
		});
		await expect(withGeminiRetry(fn, 3)).rejects.toThrow("Permission denied");
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("a genuine 503/overload is still retried", async () => {
		vi.useFakeTimers();
		const fn = vi.fn(async () => {
			throw new Error("Gemini generateContent failed (HTTP 503): overloaded");
		});
		const promise = withGeminiRetry(fn, 2).catch((e) => e);
		await vi.advanceTimersByTimeAsync(3000);
		const err = await promise;
		expect((err as Error).message).toContain("503");
		expect(fn).toHaveBeenCalledTimes(2);
	});

	// FINDING 2: an honored 429 retryDelay is not clamped to `maxDelayMs`, so a
	// body carrying "retryDelay": "35994s" sleeps for hours inside a chat
	// request. Advancing fake timers only to the ceiling must be enough for
	// the retry to fire — if the real sleep were hours, it would not.
	it("an honored retryDelay is clamped to maxDelayMs, not honored verbatim", async () => {
		vi.useFakeTimers();
		const fn = vi
			.fn()
			.mockRejectedValueOnce(
				new Error(
					'Gemini chat failed (HTTP 429): {"retryDelay": "35994s"}',
				),
			)
			.mockResolvedValueOnce("ok");
		const promise = withGeminiRetry(fn, 2, undefined, {
			honorRetryDelay: true,
			maxDelayMs: 5000,
		});
		// The unclamped retryDelay (35994s) would never resolve within this
		// advance; the clamp-to-5000ms ceiling (+ up to 500ms jitter) must.
		await vi.advanceTimersByTimeAsync(5500);
		await expect(promise).resolves.toBe("ok");
		expect(fn).toHaveBeenCalledTimes(2);
	});
});
