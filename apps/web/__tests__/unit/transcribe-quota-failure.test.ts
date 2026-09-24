import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock every heavy dependency workflows/transcribe.ts imports ──────────────
// Mirrors transcribe-batch-mode.test.ts; only the pieces this suite exercises
// are given real behaviour.
const ROW = vi.hoisted(() => ({
	metadata: {} as Record<string, unknown>,
}));
vi.mock("@cap/database", () => ({
	// submitCheapChunkBatch reads the row's aiBatchJobs + cycle counters
	// before submitting.
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [{ metadata: ROW.metadata }] }),
			}),
		}),
	}),
}));
const ENV = vi.hoisted(() => ({
	value: { GEMINI_API_KEY: "server-key" } as Record<string, string | undefined>,
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ENV.value,
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
		submitChunkBatch: vi.fn(),
		patchVideoMetadata: vi.fn(),
	};
});

vi.mock("@/lib/ai-cost-guard", () => ({
	withCostGuard: (opts: unknown) => H.withCostGuard(opts),
}));

vi.mock("@/lib/gemini-batch-transcribe", () => ({
	BatchFallbackError: H.BatchFallbackError,
	transcribeChunkWithBatch: (url: string, opts: unknown) =>
		H.transcribeChunkWithBatch(url, opts),
	submitChunkBatch: (...args: unknown[]) => H.submitChunkBatch(...args),
}));

vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: (...args: unknown[]) => H.patchVideoMetadata(...args),
}));

vi.mock("@/lib/gemini-transcribe", () => ({
	transcribeWithGemini: (url: string, opts: unknown) =>
		H.transcribeWithGemini(url, opts),
	extractSpeakerLabels: () => [],
	mergeChunkedWebVtt: (chunks: Array<{ vtt: string }>) =>
		chunks.map((c) => c.vtt).join(""),
	rescaleChunkVtt: (vtt: string) => ({
		vtt,
		applied: false,
		reason: "test",
		factor: 1,
	}),
	setRescaleAnchorProbe: vi.fn(),
}));

const { withCostGuard, transcribeWithGemini, submitChunkBatch } = H;

// ─── Import AFTER mocks ───────────────────────────────────────────────────────
import { transcribeAudioChunks } from "@/workflows/transcribe";
import {
	isAiQuotaWaitError,
	isTranscriptionQuotaFailureError,
} from "@/lib/ai-quota-wait";

const CTX = { userId: "u1", orgId: "o1", videoId: "v1" };

function chunk(startSec: number) {
	return {
		key: `k-${startSec}`,
		url: `https://a/${startSec}.mp3`,
		startSec,
		durationSec: 600,
	};
}

/** The real 429 the account produced during the 2026-07-20 incident. */
function quotaError() {
	return new Error(
		"429 RESOURCE_EXHAUSTED: Your prepayment credits are depleted",
	);
}

function genuineError() {
	return new Error("Invalid audio format: could not decode stream");
}

/** Stand-in for the injectable per-chunk transcriber. */
function chunkFn(impl: (startSec: number) => Promise<string>) {
	return vi.fn(async ({ chunk: c }: { chunk: { startSec: number } }) =>
		impl(c.startSec),
	) as never;
}

const TWO_CHUNKS = { chunks: [chunk(0), chunk(600)], totalDurationSec: 1200 };

describe("transcribeAudioChunks — quota vs genuine failure classification", () => {
	beforeEach(() => {
		withCostGuard.mockReset();
		transcribeWithGemini.mockReset();
		submitChunkBatch.mockReset();
		withCostGuard.mockImplementation(
			async (opts: { fn: () => Promise<unknown> }) => opts.fn(),
		);
		submitChunkBatch.mockResolvedValue({
			batchName: "batches/test",
			fileName: "files/test",
		});
		ENV.value = { GEMINI_API_KEY: "server-key" };
		ROW.metadata = {};
		H.patchVideoMetadata.mockReset();
	});

	// ─── ROUND-8 (deletion round): cheap = free first, then the SAME sync ───
	// ─── paid path, no parking, no Batch, no collector ──────────────────────

	it("cheap + free quota exhausted: falls back to the PAID sync call immediately — no park, no Batch submit", async () => {
		ENV.value = {
			GEMINI_API_KEY: "server-key",
			GEMINI_API_KEY_FREE: "free-key",
		};
		transcribeWithGemini
			.mockRejectedValueOnce(quotaError())
			.mockResolvedValueOnce({
				transcriptVtt: "WEBVTT\n\nPAID",
				inputTokens: 1,
				outputTokens: 1,
				audioInTokens: 1,
			});

		const out = await transcribeAudioChunks(
			{ chunks: [chunk(0)], totalDurationSec: 600 },
			null,
			CTX,
		);

		expect(out).toContain("PAID");
		expect(transcribeWithGemini).toHaveBeenCalledTimes(2);
		expect(submitChunkBatch).not.toHaveBeenCalled();
	});

	it("cheap + NO free key: free is exhausted by definition — the paid sync call runs directly", async () => {
		ENV.value = { GEMINI_API_KEY: "server-key" };
		transcribeWithGemini.mockResolvedValue({
			transcriptVtt: "WEBVTT\n\nPAID",
			inputTokens: 1,
			outputTokens: 1,
			audioInTokens: 1,
		});

		const out = await transcribeAudioChunks(
			{ chunks: [chunk(0)], totalDurationSec: 600 },
			null,
			CTX,
		);

		expect(out).toContain("PAID");
		expect(transcribeWithGemini).toHaveBeenCalledTimes(1);
		expect(submitChunkBatch).not.toHaveBeenCalled();
	});

	it("cheap + free key BROKEN (non-quota): fails as a REAL error — zero paid calls while free quota is intact (round-9 #1)", async () => {
		ENV.value = {
			GEMINI_API_KEY: "server-key",
			GEMINI_API_KEY_FREE: "free-key",
		};
		transcribeWithGemini.mockRejectedValue(genuineError());

		const err = await transcribeAudioChunks(
			{ chunks: [chunk(0)], totalDurationSec: 600 },
			null,
			CTX,
		).catch((e) => e);

		expect((err as Error).message).toContain("could not decode");
		// Every call was the FREE attempt; the paid server key was never used.
		expect(transcribeWithGemini.mock.calls.length).toBeGreaterThanOrEqual(1);
		for (const call of transcribeWithGemini.mock.calls) {
			expect((call[1] as { apiKey?: string }).apiKey).toBe("free-key");
		}
	});

	it("cheap + BOTH free and paid exhausted (credits depleted): QUOTA-classified terminal error, still no parking", async () => {
		ENV.value = {
			GEMINI_API_KEY: "server-key",
			GEMINI_API_KEY_FREE: "free-key",
		};
		transcribeWithGemini.mockRejectedValue(quotaError());

		const err = await transcribeAudioChunks(
			{ chunks: [chunk(0)], totalDurationSec: 600 },
			null,
			CTX,
		).catch((e) => e);

		expect(isTranscriptionQuotaFailureError(err)).toBe(true);
		expect(isAiQuotaWaitError(err)).toBe(false);
		expect(submitChunkBatch).not.toHaveBeenCalled();
	});

	it("fast + EVERY chunk 429s: throws a QUOTA-classified error", async () => {
		const fn = chunkFn(async () => {
			throw quotaError();
		});

		const err = await transcribeAudioChunks(
			TWO_CHUNKS,
			null,
			CTX,
			fn,
		).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect(isTranscriptionQuotaFailureError(err)).toBe(true);
	});

	it("fast + EVERY chunk fails for a GENUINE reason: NOT classified as quota", async () => {
		const fn = chunkFn(async () => {
			throw genuineError();
		});

		const err = await transcribeAudioChunks(
			TWO_CHUNKS,
			null,
			CTX,
			fn,
		).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect(isTranscriptionQuotaFailureError(err)).toBe(false);
		expect((err as Error).message).toContain("transcription chunks failed");
	});

	it("fast + MIXED (one chunk ok, one 429): QUOTA-classified (2026-09-24 reversal) — the cron resumes and fills the gap", async () => {
		// Until 2026-09-24 a quota-partial was saved as COMPLETE to keep the cron
		// from re-running a saved video. Production proved terminal-COMPLETE is
		// the worse evil (dars3 `060m9ty4kqqspxp`: free 429 + paid 402 left
		// 22/34 chunks missing, the transcript silently stopped at 72 min of
		// 204, and a COMPLETE row is invisible to the recovery cron FOREVER —
		// the owner's "3-hour audios come out half-done" complaint). Now
		// every-failed-chunk-quota => TranscriptionQuotaFailureError, and the
		// cron's re-kick resumes from the partial checkpoint, re-transcribing
		// ONLY the uncovered chunks — so the re-run the old comment feared is
		// near-free and the user never sees a fake-finished transcript.
		const fn = chunkFn(async (startSec) => {
			if (startSec === 0) return "WEBVTT\n\nOK";
			throw quotaError();
		});

		const err = await transcribeAudioChunks(
			TWO_CHUNKS,
			null,
			CTX,
			fn,
		).catch((e) => e);

		expect(isTranscriptionQuotaFailureError(err)).toBe(true);
	});

	it("fast + SINGLE chunk 429: still QUOTA-classified (single-chunk path bypasses the chunk loop)", async () => {
		// Videos under ~8 min take the chunks.length === 1 branch, which never
		// reaches the per-chunk catch or the all-failed throw.
		transcribeWithGemini.mockRejectedValue(quotaError());

		const err = await transcribeAudioChunks(
			{ chunks: [chunk(0)], totalDurationSec: 600 },
			null,
			CTX,
		).catch((e) => e);

		expect(isTranscriptionQuotaFailureError(err)).toBe(true);
	});

	it("fast + quota: never parks via the durable Batch (fast has no collector)", async () => {
		// Regression guard for the rejected design. Parking a fast job in
		// PROCESSING would strand it forever — nothing resumes it.
		const fn = chunkFn(async () => {
			throw quotaError();
		});

		await transcribeAudioChunks(
			TWO_CHUNKS,
			null,
			CTX,
			fn,
		).catch(() => {});

		expect(submitChunkBatch).not.toHaveBeenCalled();
	});
});
