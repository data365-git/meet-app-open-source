import { beforeEach, describe, expect, it, vi } from "vitest";

// Bulk "replace with audio" — the batch wrapper around the single-video
// DATA-LOSS action. These tests pin the three properties that make a batch of
// an irreversible operation safe to offer at all:
//   1. it REUSES the single-video action (so the verify-before-delete gate
//      cannot rot in a bulk-shaped copy);
//   2. one failure does NOT abort the rest of the batch;
//   3. it runs SEQUENTIALLY (ffmpeg decodes each video fully into memory).

const H = vi.hoisted(() => ({
	replaceVideoWithAudio: vi.fn(),
	/** Records enter/exit per id so overlap is detectable, not assumed. */
	timeline: [] as string[],
	inFlight: 0,
	maxConcurrent: 0,
}));

vi.mock("@/actions/video/replace-with-audio", () => ({
	replaceVideoWithAudio: H.replaceVideoWithAudio,
}));

import { replaceVideosWithAudio } from "@/actions/video/replace-videos-with-audio";

beforeEach(() => {
	H.replaceVideoWithAudio.mockReset();
	H.timeline = [];
	H.inFlight = 0;
	H.maxConcurrent = 0;
});

/** Resolves after a turn of the event loop, so a parallel impl would overlap. */
function tracked(result: unknown) {
	return async (videoId: string) => {
		H.inFlight += 1;
		H.maxConcurrent = Math.max(H.maxConcurrent, H.inFlight);
		H.timeline.push(`start:${videoId}`);
		await new Promise((resolve) => setTimeout(resolve, 1));
		H.timeline.push(`end:${videoId}`);
		H.inFlight -= 1;
		return result;
	};
}

describe("replaceVideosWithAudio", () => {
	it("delegates to the single-video action once per id", async () => {
		H.replaceVideoWithAudio.mockResolvedValue({ ok: true, reclaimedFrom: [] });

		const result = await replaceVideosWithAudio(["a", "b", "c"]);

		expect(H.replaceVideoWithAudio).toHaveBeenCalledTimes(3);
		expect(H.replaceVideoWithAudio.mock.calls.map((c) => c[0])).toEqual([
			"a",
			"b",
			"c",
		]);
		expect(result.replaced).toEqual(["a", "b", "c"]);
		expect(result.failed).toEqual([]);
	});

	it("keeps going after a failure and reports it per id", async () => {
		H.replaceVideoWithAudio.mockImplementation(async (id: string) => {
			if (id === "b") return { ok: false, reason: "unsupported_source" };
			return { ok: true, reclaimedFrom: [] };
		});

		const result = await replaceVideosWithAudio(["a", "b", "c"]);

		expect(result.replaced).toEqual(["a", "c"]);
		expect(result.failed).toEqual([{ id: "b", reason: "unsupported_source" }]);
	});

	it("keeps going after an unexpected throw", async () => {
		H.replaceVideoWithAudio.mockImplementation(async (id: string) => {
			if (id === "b") throw new Error("boom");
			return { ok: true, reclaimedFrom: [] };
		});

		const result = await replaceVideosWithAudio(["a", "b", "c"]);

		expect(result.replaced).toEqual(["a", "c"]);
		expect(result.failed).toEqual([{ id: "b", reason: "unexpected_error" }]);
	});

	it("reports an already-audio video as skipped, not failed", async () => {
		H.replaceVideoWithAudio.mockImplementation(async (id: string) => {
			if (id === "b") return { ok: false, reason: "already_audio" };
			return { ok: true, reclaimedFrom: [] };
		});

		const result = await replaceVideosWithAudio(["a", "b"]);

		expect(result.skipped).toEqual(["b"]);
		expect(result.failed).toEqual([]);
	});

	it("runs sequentially — never two extractions at once", async () => {
		H.replaceVideoWithAudio.mockImplementation(
			tracked({ ok: true, reclaimedFrom: [] }),
		);

		await replaceVideosWithAudio(["a", "b", "c"]);

		expect(H.maxConcurrent).toBe(1);
		expect(H.timeline).toEqual([
			"start:a",
			"end:a",
			"start:b",
			"end:b",
			"start:c",
			"end:c",
		]);
	});

	it("does nothing when the selection is empty", async () => {
		const result = await replaceVideosWithAudio([]);

		expect(H.replaceVideoWithAudio).not.toHaveBeenCalled();
		expect(result).toEqual({ replaced: [], failed: [], skipped: [] });
	});
});
