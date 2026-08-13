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
});
