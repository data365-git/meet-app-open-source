import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Round-12 #3: generation needs a liveness heartbeat (same shape as
// transcription's) so the recovery cron can tell a stalled generation from a
// healthy long one — the owner's requirement is "restart the stalled, leave
// the healthy alone".
const H = vi.hoisted(() => ({
	patch: vi.fn(
		async (_id: string, fn: (m: Record<string, unknown>) => Record<string, unknown>) => fn({}),
	),
}));
vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: (id: string, fn: (m: Record<string, unknown>) => Record<string, unknown>) =>
		H.patch(id, fn),
}));

import { startAiJobHeartbeat } from "@/lib/ai-job-heartbeat";

describe("startAiJobHeartbeat", () => {
	beforeEach(() => {
		H.patch.mockClear();
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stamps aiProgressAt every 5 minutes, preserves other metadata, and stops cleanly", async () => {
		const stop = startAiJobHeartbeat("v1");
		expect(H.patch).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(H.patch).toHaveBeenCalledTimes(1);
		expect(H.patch.mock.calls[0]?.[0]).toBe("v1");
		const updater = H.patch.mock.calls[0]?.[1] as (
			m: Record<string, unknown>,
		) => Record<string, unknown>;
		const out = updater({ keep: 1 });
		expect(typeof out.aiProgressAt).toBe("string");
		expect(out.keep).toBe(1);

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(H.patch).toHaveBeenCalledTimes(3);

		stop();
		await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
		expect(H.patch).toHaveBeenCalledTimes(3);
	});
});
