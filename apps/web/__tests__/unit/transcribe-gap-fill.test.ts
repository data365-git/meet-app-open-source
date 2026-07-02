import { describe, expect, it, vi } from "vitest";

// ─── Mock heavy production dependencies that transcribe.ts imports ────────────
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@cap/database/crypto", () => ({ decrypt: vi.fn() }));
vi.mock("@cap/utils", () => ({ userIsPro: vi.fn() }));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({ getStorageAccessForVideo: vi.fn() }));
vi.mock("@/lib/ai-cost-guard", () => ({ withCostGuard: vi.fn() }));
vi.mock("@/lib/ai-generation-request", () => ({
	shouldStartAiAfterTranscription: vi.fn(),
}));
vi.mock("@/lib/audio-enhance", () => ({
	ENHANCED_AUDIO_CONTENT_TYPE: "audio/wav",
	ENHANCED_AUDIO_EXTENSION: "wav",
	enhanceAudioFromUrl: vi.fn(),
}));
vi.mock("@/lib/audio-extract", () => ({
	checkHasAudioTrack: vi.fn(),
	extractAudioChunksFromUrl: vi.fn(),
	extractAudioFromUrl: vi.fn(),
	extractAudioSpanFromUrl: vi.fn(),
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/transcription-settings", () => ({
	isTranscriptionDisabled: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {
		readonly _tag = "FatalError";
	},
}));

// ─── Import AFTER mocks ───────────────────────────────────────────────────────
import {
	fillTranscriptGaps,
	filterVttCuesByAbsoluteStart,
	findVttGaps,
} from "../../workflows/transcribe";

const fakeVideo = {} as never; // deps are injected; the video row is never touched

function ctx() {
	return { userId: "u1", orgId: "o1", videoId: "v1" };
}

function vtt(cues: Array<[number, number, string]>): string {
	const ts = (s: number) => {
		const h = String(Math.floor(s / 3600)).padStart(2, "0");
		const m = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
		const sec = String(Math.floor(s % 60)).padStart(2, "0");
		return `${h}:${m}:${sec}.000`;
	};
	let out = "WEBVTT\n\n";
	cues.forEach(([start, end, text], i) => {
		out += `${i + 1}\n${ts(start)} --> ${ts(end)}\n${text}\n\n`;
	});
	return out;
}

describe("findVttGaps", () => {
	it("returns no gaps for a well-covered transcript", () => {
		const v = vtt([[0, 50, "a"], [60, 110, "b"], [170, 220, "c"], [280, 300, "d"]]);
		expect(findVttGaps(v, 310)).toEqual([]);
	});

	it("detects a leading gap (the 'first 14 minutes missing' bug)", () => {
		const v = vtt([[854, 860, "late"], [900, 910, "more"]]);
		const gaps = findVttGaps(v, 950);
		expect(gaps).toEqual([{ startSec: 0, endSec: 854 }]);
	});

	it("detects an internal gap between cue starts", () => {
		const v = vtt([[0, 10, "a"], [30, 40, "b"], [900, 910, "c"]]);
		expect(findVttGaps(v, 950)).toEqual([{ startSec: 30, endSec: 900 }]);
	});

	it("detects a trailing gap when duration is known", () => {
		const v = vtt([[0, 10, "a"], [60, 70, "b"]]);
		expect(findVttGaps(v, 900)).toEqual([{ startSec: 60, endSec: 900 }]);
	});

	it("ignores the trailing hole when duration is unknown", () => {
		const v = vtt([[0, 10, "a"], [60, 70, "b"]]);
		expect(findVttGaps(v, null)).toEqual([]);
	});

	it("treats an empty VTT as one whole-duration gap", () => {
		expect(findVttGaps("WEBVTT\n\n", 600)).toEqual([{ startSec: 0, endSec: 600 }]);
	});

	it("returns multiple gaps in order", () => {
		const v = vtt([[400, 410, "a"], [420, 430, "b"], [1000, 1010, "c"]]);
		expect(findVttGaps(v, 1600)).toEqual([
			{ startSec: 0, endSec: 400 },
			{ startSec: 420, endSec: 1000 },
			{ startSec: 1000, endSec: 1600 },
		]);
	});

	it("respects a custom minGapSec", () => {
		const v = vtt([[0, 5, "a"], [100, 105, "b"]]);
		expect(findVttGaps(v, 110, 200)).toEqual([]);
		expect(findVttGaps(v, 110, 60)).toEqual([{ startSec: 0, endSec: 100 }]);
	});
});

describe("fillTranscriptGaps", () => {
	it("returns the input unchanged when there are no gaps", async () => {
		const v = vtt([[0, 50, "a"], [60, 110, "b"]]);
		let extractCalled = false;
		const out = await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: v, totalDurationSec: 120,
			},
			{
				extractSpans: async () => { extractCalled = true; return []; },
				transcribeFn: async () => "WEBVTT\n\n",
				cleanupFn: async () => {},
			},
		);
		expect(out.transcription).toBe(v);
		expect(out.remainingGaps).toEqual([]);
		expect(extractCalled).toBe(false);
	});

	it("fills a leading gap from re-transcribed spans", async () => {
		// Cues only from 854s; gap 0-854 must be filled by span transcription.
		const holey = vtt([[854, 860, "late"], [900, 906, "tail"]]);
		const requestedSpans: Array<{ startSec: number; durationSec: number }> = [];
		const out = await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: holey, totalDurationSec: 910,
			},
			{
				extractSpans: async (_v, _u, _vid, spans) => {
					requestedSpans.push(...spans.map((s) => ({ startSec: s.startSec, durationSec: s.durationSec })));
					return spans.map((s, i) => ({
						key: `k${i}`, url: `u${i}`,
						startSec: s.startSec, durationSec: s.durationSec,
						gapStartSec: s.gapStartSec, gapEndSec: s.gapEndSec,
					}));
				},
				// Each span returns a cue every 60s so the hole disappears. Text is
				// unique per cue so the degenerate-run collapser (collapseRepeatedVttCues)
				// doesn't merge them away — real transcripts have varied text.
				transcribeFn: async (_url, durationSec) => {
					const cues: Array<[number, number, string]> = [];
					for (let t = 0; t < (durationSec ?? 0); t += 60) {
						cues.push([t, Math.min(t + 5, (durationSec ?? 0)), `filled ${t}`]);
					}
					return vtt(cues);
				},
				cleanupFn: async () => {},
			},
		);
		// 854s gap → ceil(854/300) = 3 spans of ≤300s
		expect(requestedSpans.length).toBe(3);
		expect(requestedSpans[0]).toEqual({ startSec: 0, durationSec: 300 });
		expect(out.remainingGaps).toEqual([]);
		expect(out.transcription).toContain("filled");
		expect(out.transcription).toContain("late");
	});

	it("keeps the gap in remainingGaps when span transcription fails (silence)", async () => {
		const holey = vtt([[854, 860, "late"]]);
		const out = await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: holey, totalDurationSec: 900,
			},
			{
				extractSpans: async (_v, _u, _vid, spans) =>
					spans.map((s, i) => ({
						key: `k${i}`, url: `u${i}`,
						startSec: s.startSec, durationSec: s.durationSec,
						gapStartSec: s.gapStartSec, gapEndSec: s.gapEndSec,
					})),
				transcribeFn: async () => {
					throw new Error("empty transcript from Gemini");
				},
				cleanupFn: async () => {},
			},
		);
		expect(out.remainingGaps).toEqual([{ startSec: 0, endSec: 854 }]);
		expect(out.transcription).toContain("late");
	});

	it("survives a wholesale extraction failure (returns original + gaps)", async () => {
		const holey = vtt([[854, 860, "late"]]);
		const out = await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: holey, totalDurationSec: 900,
			},
			{
				extractSpans: async () => { throw new Error("ffmpeg died"); },
				transcribeFn: async () => "WEBVTT\n\n",
				cleanupFn: async () => {},
			},
		);
		expect(out.transcription).toBe(holey);
		expect(out.remainingGaps).toEqual([{ startSec: 0, endSec: 854 }]);
	});

	it("cleans up every uploaded span key", async () => {
		const holey = vtt([[400, 410, "x"]]);
		const cleaned: string[] = [];
		await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: holey, totalDurationSec: 420,
			},
			{
				extractSpans: async (_v, _u, _vid, spans) =>
					spans.map((s, i) => ({
						key: `gap-key-${i}`, url: `u${i}`,
						startSec: s.startSec, durationSec: s.durationSec,
						gapStartSec: s.gapStartSec, gapEndSec: s.gapEndSec,
					})),
				transcribeFn: async () => vtt([[0, 5, "ok"]]),
				cleanupFn: async (keys) => { cleaned.push(...keys); },
			},
		);
		expect(cleaned.length).toBeGreaterThan(0);
		expect(cleaned.every((k) => k.startsWith("gap-key-"))).toBe(true);
	});
});

describe("filterVttCuesByAbsoluteStart", () => {
	it("drops a cue at relative 0 landing on an internal gap's boundary cue", () => {
		// offset === gapStart (300); minAbs = 301 (internal-gap convention: gapStartSec + 1)
		const v = vtt([[0, 5, "boundary"]]);
		const out = filterVttCuesByAbsoluteStart(v, 300, 301, 900);
		expect(out).not.toContain("boundary");
	});

	it("keeps a cue at relative 5 (comfortably inside the gap)", () => {
		const v = vtt([[5, 10, "inside"]]);
		const out = filterVttCuesByAbsoluteStart(v, 300, 301, 900);
		expect(out).toContain("inside");
	});

	it("drops a cue beyond maxAbsStartSec", () => {
		const v = vtt([[650, 655, "toolate"]]);
		const out = filterVttCuesByAbsoluteStart(v, 300, 301, 900);
		expect(out).not.toContain("toolate");
	});
});

describe("fillTranscriptGaps — boundary cue protection (Finding 1)", () => {
	it("does not clamp a good cue's end when the internal gap's recovered span emits a cue at relative 0", async () => {
		// A leading cue within minGapSec (120s) of both 0 and "good" avoids any
		// unintended gap before it. Existing good cue 300..306. Internal gap 300
		// -> 900 (start-to-start measure: gap.startSec === the good cue's own
		// start), split into 2 spans (300-600, 600-900). The FIRST span's
		// transcription returns a cue at relative 0 (== absolute 300, landing ON
		// the good cue's start) AND a cue at relative 60 (== absolute 360,
		// safely inside the gap). The relative-0 cue must be dropped so
		// mergeChunkedWebVtt never clamps the good cue's end down to 300.x; the
		// relative-60 cue must survive.
		const merged = vtt([[100, 106, "opening"], [200, 206, "opening2"], [300, 306, "good"], [900, 906, "next-good"]]);
		const out = await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: merged, totalDurationSec: 910,
			},
			{
				extractSpans: async (_v, _u, _vid, spans) =>
					spans.map((s, i) => ({
						key: `k${i}`, url: `u${i}`,
						startSec: s.startSec, durationSec: s.durationSec,
						gapStartSec: s.gapStartSec, gapEndSec: s.gapEndSec,
					})),
				transcribeFn: async (url) =>
					url === "u0"
						? vtt([[0, 4, "recovered-at-zero"], [60, 64, "recovered-at-60"]])
						: "WEBVTT\n\n",
				cleanupFn: async () => {},
			},
		);

		// The recovered cue at relative 0 (landing on the boundary) must be gone.
		expect(out.transcription).not.toContain("recovered-at-zero");
		// The recovered cue safely inside the gap must survive.
		expect(out.transcription).toContain("recovered-at-60");
		// The original good cue must still be present with an end that was NOT
		// clamped down to ~300.x by the dropped boundary cue.
		const goodCueMatch = out.transcription.match(
			/00:05:00\.000 --> (00:0\d:\d\d\.\d\d\d)\n(?:\r?\n)?good/,
		);
		expect(goodCueMatch).not.toBeNull();
		const endTimestamp = goodCueMatch?.[1] ?? "";
		const endSec =
			Number(endTimestamp.slice(3, 5)) * 60 + Number(endTimestamp.slice(6, 8));
		expect(endSec).toBeGreaterThanOrEqual(305);
	});

	it("keeps a recovered cue at absolute 0 for a leading gap (gapStartSec === 0)", async () => {
		// Leading gap: no preceding cue to protect, so a cue at absolute 0 must
		// be kept (minAbs = -1 when gapStartSec === 0).
		const merged = vtt([[400, 406, "late"]]);
		const out = await fillTranscriptGaps(
			{
				videoId: "v1", userId: "u1", video: fakeVideo,
				ownerEncryptedGeminiKey: null, context: ctx(),
				mergedVtt: merged, totalDurationSec: 410,
			},
			{
				extractSpans: async (_v, _u, _vid, spans) =>
					spans.map((s, i) => ({
						key: `k${i}`, url: `u${i}`,
						startSec: s.startSec, durationSec: s.durationSec,
						gapStartSec: s.gapStartSec, gapEndSec: s.gapEndSec,
					})),
				transcribeFn: async () => vtt([[0, 4, "recovered-at-abs-zero"]]),
				cleanupFn: async () => {},
			},
		);

		expect(out.transcription).toContain("recovered-at-abs-zero");
	});
});

describe("findVttGaps — unknown-duration blind spot (Finding 2)", () => {
	it("returns no gaps for a short VTT when duration is null (documents the blind spot transcriptionCoverageUnknown covers)", () => {
		const v = vtt([[0, 5, "only"]]);
		expect(findVttGaps(v, null)).toEqual([]);
	});
});
