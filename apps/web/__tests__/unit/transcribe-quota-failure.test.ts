import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock every heavy dependency workflows/transcribe.ts imports ──────────────
// Mirrors transcribe-batch-mode.test.ts; only the pieces this suite exercises
// are given real behaviour.
vi.mock("@cap/database", () => ({
	// submitCheapChunkBatch reads the row's aiBatchJobs before submitting.
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [{ metadata: {} }] }),
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
	});

	// ─── OWNER DECISION + INVARIANT (round-6): cheap never bills full price ──

	it("cheap + NO free key: goes STRAIGHT to the discounted Batch — the full-price sync call is never made", async () => {
		// The full-price call would show up as a transcribeWithGemini invocation
		// with the paid server key; there must be ZERO calls.
		const err = await transcribeAudioChunks(
			{ chunks: [chunk(0)], totalDurationSec: 600 },
			null,
			{ ...CTX, aiSpeedMode: "cheap" },
		).catch((e) => e);

		expect(isAiQuotaWaitError(err)).toBe(true);
		expect(transcribeWithGemini).not.toHaveBeenCalled();
		expect(submitChunkBatch).toHaveBeenCalledTimes(1);
	});

	it("cheap + free fails NON-quota (transient error): continues on Batch, never falls through to full price", async () => {
		// Pre-round-6, this was the last live path from cheap to the full-price
		// sync call: any non-quota free failure fell straight through to paid.
		ENV.value = {
			GEMINI_API_KEY: "server-key",
			GEMINI_API_KEY_FREE: "free-key",
		};
		transcribeWithGemini.mockRejectedValue(genuineError());

		const err = await transcribeAudioChunks(
			{ chunks: [chunk(0)], totalDurationSec: 600 },
			null,
			{ ...CTX, aiSpeedMode: "cheap" },
		).catch((e) => e);

		expect(isAiQuotaWaitError(err)).toBe(true);
		// Exactly ONE call — the free attempt. A second call would be the
		// full-price fallback the owner forbade.
		expect(transcribeWithGemini).toHaveBeenCalledTimes(1);
		expect(submitChunkBatch).toHaveBeenCalledTimes(1);
	});

	it("fast + EVERY chunk 429s: throws a QUOTA-classified error", async () => {
		const fn = chunkFn(async () => {
			throw quotaError();
		});

		const err = await transcribeAudioChunks(
			TWO_CHUNKS,
			null,
			{ ...CTX, aiSpeedMode: "fast" },
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
			{ ...CTX, aiSpeedMode: "fast" },
			fn,
		).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect(isTranscriptionQuotaFailureError(err)).toBe(false);
		expect((err as Error).message).toContain("transcription chunks failed");
	});

	it("fast + MIXED (one chunk ok, one 429): does not fail the job at all", async () => {
		// A partial transcript is usable, so this must NOT be recorded as a quota
		// death — otherwise the cron would re-run an already-saved video.
		const fn = chunkFn(async (startSec) => {
			if (startSec === 0) return "WEBVTT\n\nOK";
			throw quotaError();
		});

		const out = await transcribeAudioChunks(
			TWO_CHUNKS,
			null,
			{ ...CTX, aiSpeedMode: "fast" },
			fn,
		);

		expect(out).toContain("OK");
	});

	it("fast + SINGLE chunk 429: still QUOTA-classified (single-chunk path bypasses the chunk loop)", async () => {
		// Videos under ~8 min take the chunks.length === 1 branch, which never
		// reaches the per-chunk catch or the all-failed throw.
		transcribeWithGemini.mockRejectedValue(quotaError());

		const err = await transcribeAudioChunks(
			{ chunks: [chunk(0)], totalDurationSec: 600 },
			null,
			{ ...CTX, aiSpeedMode: "fast" },
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
			{ ...CTX, aiSpeedMode: "fast" },
			fn,
		).catch(() => {});

		expect(submitChunkBatch).not.toHaveBeenCalled();
	});
});
