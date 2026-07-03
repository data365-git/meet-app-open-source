import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock every heavy dependency workflows/transcribe.ts imports ──────────────
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ GEMINI_API_KEY: "server-key" }),
}));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@cap/database/crypto", () => ({
	decrypt: vi.fn(async () => "decrypted-key"),
}));
vi.mock("@cap/utils", () => ({ userIsPro: vi.fn() }));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({ getStorageAccessForVideo: vi.fn() }));
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
vi.mock("@/lib/restore-russian-script", () => ({
	restoreRussianScript: (s: string) => s,
}));
vi.mock("server-only", () => ({}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {
		readonly _tag = "FatalError";
	},
}));

// vi.mock factories are hoisted above all top-level code, so anything they
// reference must live in a vi.hoisted() block (which is hoisted with them).
// BatchFallbackError is shared between the mock and the test assertions.
const H = vi.hoisted(() => {
	class BatchFallbackError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "BatchFallbackError";
		}
	}
	return {
		BatchFallbackError,
		withCostGuard: vi.fn(),
		transcribeChunkWithBatch: vi.fn(),
		transcribeWithGemini: vi.fn(),
	};
});

vi.mock("@/lib/ai-cost-guard", () => ({
	withCostGuard: (opts: unknown) => H.withCostGuard(opts),
}));

vi.mock("@/lib/gemini-batch-transcribe", () => ({
	BatchFallbackError: H.BatchFallbackError,
	transcribeChunkWithBatch: (url: string, opts: unknown) =>
		H.transcribeChunkWithBatch(url, opts),
}));

vi.mock("@/lib/gemini-transcribe", () => ({
	transcribeWithGemini: (url: string, opts: unknown) =>
		H.transcribeWithGemini(url, opts),
	// pass-throughs used elsewhere in the module
	extractSpeakerLabels: () => [],
	mergeChunkedWebVtt: (chunks: Array<{ vtt: string }>) =>
		chunks.map((c) => c.vtt).join(""),
}));

const { BatchFallbackError, withCostGuard, transcribeChunkWithBatch, transcribeWithGemini } = H;

// ─── Import AFTER mocks ───────────────────────────────────────────────────────
import { transcribeAudio } from "@/workflows/transcribe";

const CTX_BASE = { userId: "u1", orgId: "o1", videoId: "v1" };
const SYNC_RESULT = {
	transcriptVtt: "WEBVTT\n\nSYNC",
	inputTokens: 10,
	outputTokens: 5,
	audioInTokens: 3,
};
const BATCH_RESULT = {
	transcriptVtt: "WEBVTT\n\nBATCH",
	inputTokens: 100,
	outputTokens: 50,
	audioInTokens: 30,
};

// withCostGuard normally runs fn() and returns its value plus token fields; the
// stub reproduces that contract so the code under test behaves realistically.
function costGuardRunsFn() {
	withCostGuard.mockImplementation(async (opts: { fn: () => Promise<unknown> }) => {
		return opts.fn();
	});
}

/** The options object passed to the nth withCostGuard call (asserts it exists). */
function costGuardCall(n: number): { batch?: boolean } {
	const call = withCostGuard.mock.calls[n];
	if (!call) throw new Error(`withCostGuard was not called ${n + 1} time(s)`);
	return call[0] as { batch?: boolean };
}

describe("transcribeAudio speed-mode routing", () => {
	beforeEach(() => {
		withCostGuard.mockReset();
		transcribeChunkWithBatch.mockReset();
		transcribeWithGemini.mockReset();
	});

	it("mode=fast (default): uses the SYNC path and does NOT pass batch:true", async () => {
		costGuardRunsFn();
		transcribeWithGemini.mockResolvedValue(SYNC_RESULT);

		const out = await transcribeAudio("https://a/x.mp3?sig=1", 300, null, {
			...CTX_BASE,
			aiSpeedMode: "fast",
		});

		expect(out).toBe("WEBVTT\n\nSYNC");
		expect(transcribeWithGemini).toHaveBeenCalledTimes(1);
		expect(transcribeChunkWithBatch).not.toHaveBeenCalled();
		// The single cost-guard call must be a NON-batch call.
		expect(withCostGuard).toHaveBeenCalledTimes(1);
		expect(costGuardCall(0).batch).toBeFalsy();
	});

	it("mode absent (undefined): behaves exactly like fast (regression guard)", async () => {
		costGuardRunsFn();
		transcribeWithGemini.mockResolvedValue(SYNC_RESULT);

		const out = await transcribeAudio("https://a/x.mp3", 300, null, CTX_BASE);

		expect(out).toBe("WEBVTT\n\nSYNC");
		expect(transcribeChunkWithBatch).not.toHaveBeenCalled();
		expect(costGuardCall(0).batch).toBeFalsy();
	});

	it("mode=cheap: uses the BATCH path and passes batch:true to the cost guard", async () => {
		costGuardRunsFn();
		transcribeChunkWithBatch.mockResolvedValue(BATCH_RESULT);

		const out = await transcribeAudio("https://a/x.mp3", 300, null, {
			...CTX_BASE,
			aiSpeedMode: "cheap",
		});

		expect(out).toBe("WEBVTT\n\nBATCH");
		expect(transcribeChunkWithBatch).toHaveBeenCalledTimes(1);
		expect(transcribeWithGemini).not.toHaveBeenCalled();
		expect(withCostGuard).toHaveBeenCalledTimes(1);
		expect(costGuardCall(0).batch).toBe(true);
	});

	it("mode=cheap + BatchFallbackError: falls back to SYNC for that chunk (video not failed)", async () => {
		costGuardRunsFn();
		transcribeChunkWithBatch.mockRejectedValue(
			new BatchFallbackError("timed out"),
		);
		transcribeWithGemini.mockResolvedValue(SYNC_RESULT);

		const out = await transcribeAudio("https://a/x.mp3", 300, null, {
			...CTX_BASE,
			aiSpeedMode: "cheap",
		});

		// Fell back to sync output rather than throwing.
		expect(out).toBe("WEBVTT\n\nSYNC");
		expect(transcribeChunkWithBatch).toHaveBeenCalledTimes(1);
		expect(transcribeWithGemini).toHaveBeenCalledTimes(1);
		// Two cost-guard calls: the batch attempt (batch:true) then the sync
		// fallback (batch falsy). The recorded fallback cost uses SYNC rates.
		expect(withCostGuard).toHaveBeenCalledTimes(2);
		expect(costGuardCall(0).batch).toBe(true);
		expect(costGuardCall(1).batch).toBeFalsy();
	});

	it("mode=cheap + inline/plain error: propagates (NOT swallowed) into the retry path", async () => {
		costGuardRunsFn();
		// A non-fallback error (e.g. inline RESOURCE_EXHAUSTED surfaced by unwrap).
		transcribeChunkWithBatch.mockRejectedValue(
			new Error("Batch inline request error: RESOURCE_EXHAUSTED"),
		);

		await expect(
			transcribeAudio("https://a/x.mp3", 300, null, {
				...CTX_BASE,
				aiSpeedMode: "cheap",
			}),
		).rejects.toThrow(/RESOURCE_EXHAUSTED/);

		// Did NOT silently fall back to sync for a plain (retryable) error.
		expect(transcribeWithGemini).not.toHaveBeenCalled();
	});
});
