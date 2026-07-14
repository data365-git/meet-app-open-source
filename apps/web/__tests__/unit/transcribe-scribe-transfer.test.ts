import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
	serverEnv: vi.fn(),
	fetchScribeWordTimes: vi.fn(),
	transferVttTimingWithStats: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => H.serverEnv() }));
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
vi.mock("@/lib/gemini-batch-transcribe", () => ({
	BatchFallbackError: class BatchFallbackError extends Error {},
	transcribeChunkWithBatch: vi.fn(),
}));
vi.mock("@/lib/gemini-transcribe", () => ({
	transcribeWithGemini: vi.fn(),
	extractSpeakerLabels: () => [],
	mergeChunkedWebVtt: (chunks: Array<{ vtt: string }>) =>
		chunks.map((chunk) => chunk.vtt).join(""),
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/transcription-settings", () => ({
	isTranscriptionDisabled: vi.fn(),
}));
vi.mock("@/lib/restore-russian-script", () => ({ restoreRussianScript: (s: string) => s }));
vi.mock("@/lib/eleven-scribe", () => ({
	fetchScribeWordTimes: (...args: unknown[]) => H.fetchScribeWordTimes(...args),
}));
vi.mock("@/lib/vtt-timing-transfer", () => ({
	transferVttTimingWithStats: (...args: unknown[]) =>
		H.transferVttTimingWithStats(...args),
}));
vi.mock("server-only", () => ({}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {
		readonly _tag = "FatalError";
	},
}));

import { applyScribeTimingTransfer, type ExtractedAudio } from "@/workflows/transcribe";

const ORIGINAL = "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\nold\n\n";
const CORRECTED = "WEBVTT\n\n1\n00:00:05.000 --> 00:00:07.000\nold\n\n";

function audio(chunkCount: number): ExtractedAudio {
	return {
		chunks: Array.from({ length: chunkCount }, (_, i) => ({
			key: `k${i}`,
			url: `https://example.com/${i}.mp3`,
			startSec: i * 360,
			durationSec: 360,
		})),
		totalDurationSec: chunkCount * 360,
	};
}

describe("applyScribeTimingTransfer", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		H.serverEnv.mockReset();
		H.fetchScribeWordTimes.mockReset();
		H.transferVttTimingWithStats.mockReset();
		logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
	});

	afterEach(() => {
		logSpy.mockRestore();
	});

	it("key set + Scribe succeeds: replaces final VTT timing", async () => {
		const words = [{ word: "hello", start: 5, end: 5.2 }];
		H.serverEnv.mockReturnValue({ ELEVENLABS_API_KEY: "scribe-key" });
		H.fetchScribeWordTimes.mockResolvedValue(words);
		H.transferVttTimingWithStats.mockReturnValue({
			vtt: CORRECTED,
			stats: {
				shiftedCueCount: 1,
				meanShiftSec: 5,
				denseMatches: 42,
				skeletonAnchors: 10,
				identity: false,
			},
		});

		const out = await applyScribeTimingTransfer(audio(2), ORIGINAL, "v1");

		expect(out).toMatchObject({ applied: true, vtt: CORRECTED });
		expect(H.fetchScribeWordTimes).toHaveBeenCalledTimes(1);
		expect(H.fetchScribeWordTimes).toHaveBeenCalledWith(audio(2).chunks);
		expect(H.transferVttTimingWithStats).toHaveBeenCalledWith(ORIGINAL, words);
		expect(logSpy).toHaveBeenCalledWith(
			"[transcribe] scribe-transfer: 1 cues shifted, mean 5.0s, 42 dense matches",
		);
	});

	it("Scribe throws: keeps Gemini-timed VTT and does not fail the workflow step", async () => {
		H.serverEnv.mockReturnValue({ ELEVENLABS_API_KEY: "scribe-key" });
		H.fetchScribeWordTimes.mockRejectedValue(new Error("429"));

		const out = await applyScribeTimingTransfer(audio(2), ORIGINAL, "v1");

		expect(out).toEqual({
			applied: false,
			vtt: ORIGINAL,
			reason: "failed",
		});
		expect(H.transferVttTimingWithStats).not.toHaveBeenCalled();
		expect(logSpy.mock.calls[0]?.[0]).toContain("scribe-transfer failed");
	});

	it("single chunk: refines on explicit request", async () => {
		H.serverEnv.mockReturnValue({ ELEVENLABS_API_KEY: "scribe-key" });
		H.fetchScribeWordTimes.mockResolvedValue([
			{ word: "hello", start: 5, end: 5.2 },
		]);
		H.transferVttTimingWithStats.mockReturnValue({
			vtt: CORRECTED,
			stats: {
				shiftedCueCount: 1,
				meanShiftSec: 5,
				denseMatches: 42,
				skeletonAnchors: 10,
				identity: false,
			},
		});

		const out = await applyScribeTimingTransfer(audio(1), ORIGINAL, "v1");

		expect(out).toMatchObject({ applied: true, vtt: CORRECTED });
		expect(H.fetchScribeWordTimes).toHaveBeenCalledOnce();
	});

	it("no key: does not call Scribe", async () => {
		H.serverEnv.mockReturnValue({});

		const out = await applyScribeTimingTransfer(audio(2), ORIGINAL, "v1");

		expect(out).toEqual({
			applied: false,
			vtt: ORIGINAL,
			reason: "missing_key",
		});
		expect(H.fetchScribeWordTimes).not.toHaveBeenCalled();
	});

	it("low-confidence alignment keeps the latest transcript unchanged", async () => {
		H.serverEnv.mockReturnValue({ ELEVENLABS_API_KEY: "scribe-key" });
		H.fetchScribeWordTimes.mockResolvedValue([
			{ word: "hello", start: 5, end: 5.2 },
		]);
		H.transferVttTimingWithStats.mockReturnValue({
			vtt: ORIGINAL,
			stats: {
				shiftedCueCount: 0,
				meanShiftSec: 0,
				denseMatches: 0,
				skeletonAnchors: 2,
				identity: true,
			},
		});

		const out = await applyScribeTimingTransfer(audio(1), ORIGINAL, "v1");

		expect(out).toEqual({
			applied: false,
			vtt: ORIGINAL,
			reason: "low_confidence",
		});
	});
});
