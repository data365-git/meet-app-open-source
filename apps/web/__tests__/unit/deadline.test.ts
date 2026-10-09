import { afterEach, describe, expect, it, vi } from "vitest";
import { DeadlineError, isDeadlineError, withDeadline } from "@/lib/deadline";

describe("withDeadline", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("returns the result when fn completes before the deadline", async () => {
		const out = await withDeadline(1000, async () => "done");
		expect(out).toBe("done");
	});

	it("passes an un-aborted signal to fn on the success path", async () => {
		const out = await withDeadline(1000, async (signal) => {
			expect(signal.aborted).toBe(false);
			return 42;
		});
		expect(out).toBe(42);
	});

	it("aborts the signal with a DeadlineError when fn outlives the deadline", async () => {
		vi.useFakeTimers();
		let abortReason: unknown;
		const promise = withDeadline(
			5000,
			(signal) =>
				new Promise<never>((_resolve, reject) => {
					signal.addEventListener("abort", () => {
						abortReason = signal.reason;
						reject(signal.reason);
					});
				}),
		);
		// Attach the rejection handler BEFORE advancing timers so the settled
		// rejection is never briefly unhandled.
		const expectation = expect(promise).rejects.toBeInstanceOf(DeadlineError);
		await vi.advanceTimersByTimeAsync(5000);
		await expectation;
		expect(abortReason).toBeInstanceOf(DeadlineError);
	});

	it("clears its timer on the success path (no abort fires afterwards)", async () => {
		vi.useFakeTimers();
		let abortedAfter = false;
		const signalRef = await withDeadline(5000, async (signal) => {
			signal.addEventListener("abort", () => {
				abortedAfter = true;
			});
			return signal;
		});
		// Advance well past the deadline; a cleared timer must not abort.
		await vi.advanceTimersByTimeAsync(10_000);
		expect(signalRef.aborted).toBe(false);
		expect(abortedAfter).toBe(false);
	});
});

describe("isDeadlineError", () => {
	it("recognizes a DeadlineError", () => {
		expect(isDeadlineError(new DeadlineError(8000))).toBe(true);
	});

	it("recognizes a DOMException-style AbortError by name", () => {
		const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
		expect(isDeadlineError(abort)).toBe(true);
	});

	it("rejects unrelated errors", () => {
		expect(isDeadlineError(new Error("429 RESOURCE_EXHAUSTED"))).toBe(false);
		expect(isDeadlineError(null)).toBe(false);
	});
});
