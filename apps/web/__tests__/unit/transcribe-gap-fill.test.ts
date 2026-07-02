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
import { fillTranscriptGaps, findVttGaps } from "../../workflows/transcribe";

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
					requestedSpans.push(...spans);
					return spans.map((s, i) => ({
						key: `k${i}`, url: `u${i}`,
						startSec: s.startSec, durationSec: s.durationSec,
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
					})),
				transcribeFn: async () => vtt([[0, 5, "ok"]]),
				cleanupFn: async (keys) => { cleaned.push(...keys); },
			},
		);
		expect(cleaned.length).toBeGreaterThan(0);
		expect(cleaned.every((k) => k.startsWith("gap-key-"))).toBe(true);
	});
});
