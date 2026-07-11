import { describe, expect, it } from "vitest";
import { clearAiJobClock, resolveAiJobStartedAt } from "@/lib/ai-job-clock";

describe("resolveAiJobStartedAt", () => {
	const now = "2026-07-11T12:00:00.000Z";

	it("preserves an existing start (a retry / re-kick / paid continuation)", () => {
		const original = "2026-07-11T08:00:00.000Z";
		expect(resolveAiJobStartedAt(original, now)).toBe(original);
	});

	it("starts fresh when there is no existing start (a genuinely new job)", () => {
		expect(resolveAiJobStartedAt(undefined, now)).toBe(now);
	});
});

describe("clearAiJobClock", () => {
	it("drops aiJobStartedAt so the next new analysis cannot inherit it (bug #8)", () => {
		const cleared = clearAiJobClock({
			aiJobStartedAt: "2026-07-11T08:00:00.000Z",
			aiMode: "cheap",
			aiQuotaWaiting: true,
		});
		expect(cleared.aiJobStartedAt).toBeUndefined();
		// Unrelated metadata survives.
		expect(cleared.aiMode).toBe("cheap");
		expect(cleared.aiQuotaWaiting).toBe(true);
	});

	it("a cleared clock + resolve yields a fresh start (new job does NOT flip)", () => {
		const now = "2026-07-11T12:00:00.000Z";
		const cleared = clearAiJobClock({ aiJobStartedAt: "old" });
		// After a terminal clear, a new job resolves to `now`, not the stale value.
		expect(resolveAiJobStartedAt(cleared.aiJobStartedAt, now)).toBe(now);
	});
});
