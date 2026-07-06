import { beforeEach, describe, expect, it, vi } from "vitest";

// Free-tier-first transcription: when GEMINI_API_KEY_FREE is set, transcribeAudio
// tries the free key (gemini-3.5-flash, recorded at $0) and falls back to the paid
// key/model on ANY failure. Mocks mirror transcribe-batch-mode.test.ts.

const H = vi.hoisted(() => ({
	serverEnv: vi.fn(),
	withCostGuard: vi.fn(),
	transcribeWithGemini: vi.fn(),
	transcribeChunkWithBatch: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => H.serverEnv() }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@cap/database/crypto", () => ({ decrypt: vi.fn(async () => "decrypted-key") }));
vi.mock("@cap/utils", () => ({ userIsPro: vi.fn() }));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({ getStorageAccessForVideo: vi.fn() }));
vi.mock("@/lib/ai-generation-request", () => ({ shouldStartAiAfterTranscription: vi.fn() }));
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
vi.mock("@/lib/transcription-settings", () => ({ isTranscriptionDisabled: vi.fn() }));
vi.mock("@/lib/restore-russian-script", () => ({ restoreRussianScript: (s: string) => s }));
vi.mock("server-only", () => ({}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {
		readonly _tag = "FatalError";
	},
}));
vi.mock("@/lib/ai-cost-guard", () => ({ withCostGuard: (o: unknown) => H.withCostGuard(o) }));
vi.mock("@/lib/gemini-batch-transcribe", () => ({
	BatchFallbackError: class extends Error {},
	transcribeChunkWithBatch: (u: string, o: unknown) => H.transcribeChunkWithBatch(u, o),
}));
vi.mock("@/lib/gemini-transcribe", () => ({
	transcribeWithGemini: (u: string, o: unknown) => H.transcribeWithGemini(u, o),
	extractSpeakerLabels: () => [],
	mergeChunkedWebVtt: (chunks: Array<{ vtt: string }>) => chunks.map((c) => c.vtt).join(""),
}));

import { transcribeAudio } from "@/workflows/transcribe";

const CTX = { userId: "u1", orgId: "o1", videoId: "v1", aiSpeedMode: "fast" as const };
const FREE_RESULT = { transcriptVtt: "WEBVTT\n\nFREE", inputTokens: 10, outputTokens: 5, audioInTokens: 3 };
const PAID_RESULT = { transcriptVtt: "WEBVTT\n\nPAID", inputTokens: 20, outputTokens: 8, audioInTokens: 6 };

type GuardOpt = { model?: string; free?: boolean; fn: () => Promise<unknown> };
type GeminiOpt = { apiKey?: string; models?: readonly string[] };

describe("transcribeAudio free-tier-first", () => {
	beforeEach(() => {
		H.serverEnv.mockReset();
		H.withCostGuard.mockReset();
		H.transcribeWithGemini.mockReset();
		// cost guard just runs fn() (its real contract)
		H.withCostGuard.mockImplementation(async (o: GuardOpt) => o.fn());
	});

	it("free key set + free succeeds: uses free key (gemini-3.5-flash), records free:true, no paid call", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key", GEMINI_API_KEY_FREE: "free-key" });
		H.transcribeWithGemini.mockResolvedValue(FREE_RESULT);

		const out = await transcribeAudio("https://a/x.mp3", 300, null, CTX);

		expect(out).toBe("WEBVTT\n\nFREE");
		expect(H.transcribeWithGemini).toHaveBeenCalledTimes(1);
		const geminiOpt = H.transcribeWithGemini.mock.calls[0]?.[1] as GeminiOpt;
		expect(geminiOpt.apiKey).toBe("free-key");
		expect(geminiOpt.models).toEqual(["gemini-3.5-flash"]);
		const guardOpt = H.withCostGuard.mock.calls[0]?.[0] as GuardOpt;
		expect(guardOpt.free).toBe(true);
		expect(guardOpt.model).toBe("gemini-3.5-flash");
	});

	it("free key set + free FAILS: falls back to the paid key/model", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key", GEMINI_API_KEY_FREE: "free-key" });
		H.transcribeWithGemini
			.mockRejectedValueOnce(new Error("429 RESOURCE_EXHAUSTED"))
			.mockResolvedValueOnce(PAID_RESULT);

		const out = await transcribeAudio("https://a/x.mp3", 300, null, CTX);

		expect(out).toBe("WEBVTT\n\nPAID");
		expect(H.transcribeWithGemini).toHaveBeenCalledTimes(2);
		// 2nd (paid) attempt uses the server key and no model override.
		const paidOpt = H.transcribeWithGemini.mock.calls[1]?.[1] as GeminiOpt;
		expect(paidOpt.apiKey).toBe("paid-key");
		expect(paidOpt.models).toBeUndefined();
		expect((H.withCostGuard.mock.calls[0]?.[0] as GuardOpt).free).toBe(true);
		expect((H.withCostGuard.mock.calls[1]?.[0] as GuardOpt).free).toBeFalsy();
	});

	it("no free key: paid path only, never a free attempt (regression)", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key" });
		H.transcribeWithGemini.mockResolvedValue(PAID_RESULT);

		const out = await transcribeAudio("https://a/x.mp3", 300, null, CTX);

		expect(out).toBe("WEBVTT\n\nPAID");
		expect(H.transcribeWithGemini).toHaveBeenCalledTimes(1);
		expect((H.transcribeWithGemini.mock.calls[0]?.[1] as GeminiOpt).apiKey).toBe("paid-key");
		expect((H.withCostGuard.mock.calls[0]?.[0] as GuardOpt).free).toBeFalsy();
	});
});
