import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock every heavy dependency workflows/transcribe.ts imports ──────────────
// Mirrors transcribe-quota-failure.test.ts; only the pieces this suite
// exercises are given real behaviour.
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [{ metadata: {} }] }),
			}),
		}),
	}),
}));
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

const FatalErrorHoisted = vi.hoisted(
	() =>
		class FatalError extends Error {
			readonly _tag = "FatalError";
		},
);
vi.mock("workflow", () => ({ FatalError: FatalErrorHoisted }));

const DELETED = vi.hoisted(() => ({ value: false }));
const assertVideoNotDeletedMock = vi.hoisted(() =>
	vi.fn(async () => {
		if (DELETED.value) {
			throw new FatalErrorHoisted("Video was deleted");
		}
	}),
);
vi.mock("@/lib/video-alive", () => ({
	assertVideoNotDeleted: assertVideoNotDeletedMock,
}));

const H = vi.hoisted(() => ({
	withCostGuard: vi.fn(),
	transcribeWithGemini: vi.fn(),
	submitChunkBatch: vi.fn(),
	patchVideoMetadata: vi.fn(),
}));

vi.mock("@/lib/ai-cost-guard", () => ({
	withCostGuard: (opts: unknown) => H.withCostGuard(opts),
}));

vi.mock("@/lib/gemini-batch-transcribe", () => ({
	BatchFallbackError: class BatchFallbackError extends Error {},
	transcribeChunkWithBatch: vi.fn(),
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

// ─── Import AFTER mocks ───────────────────────────────────────────────────────
import { transcribeAudioChunks } from "@/workflows/transcribe";

const CTX = { userId: "u1", orgId: "o1", videoId: "v1" };

function chunk(startSec: number) {
	return {
		key: `k-${startSec}`,
		url: `https://a/${startSec}.mp3`,
		startSec,
		durationSec: 600,
	};
}

const THREE_CHUNKS = {
	chunks: [chunk(0), chunk(600), chunk(1200)],
	totalDurationSec: 1800,
};

describe("transcribeAudioChunks aborts when the video is deleted mid-run (test 6)", () => {
	beforeEach(() => {
		DELETED.value = false;
		assertVideoNotDeletedMock.mockClear();
		H.withCostGuard.mockReset();
		H.withCostGuard.mockImplementation(
			async (opts: { fn: () => Promise<unknown> }) => opts.fn(),
		);
	});

	it("stops within roughly one chunk and never completes when the video is deleted mid-transcription", async () => {
		let callCount = 0;
		const fn = vi.fn(async ({ chunk: c }: { chunk: { startSec: number } }) => {
			callCount++;
			// The video is deleted right after the first chunk starts processing —
			// simulates a delete landing mid-run.
			if (c.startSec === 0) DELETED.value = true;
			return "WEBVTT\n\nOK";
		});

		const err = await transcribeAudioChunks(
			THREE_CHUNKS,
			null,
			CTX,
			fn,
		).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("deleted");
		// The job must abort promptly — it must not run every chunk to
		// completion once the video is gone.
		expect(callCount).toBeLessThan(THREE_CHUNKS.chunks.length);
		expect(assertVideoNotDeletedMock).toHaveBeenCalled();
	});

	it("does not check per completed chunk from inside the try/catch — a normal run only checks once per loop iteration, never after every chunk succeeds silently", async () => {
		const fn = vi.fn(async () => "WEBVTT\n\nOK");

		const out = await transcribeAudioChunks(THREE_CHUNKS, null, CTX, fn);

		expect(out).toContain("OK");
		// One call per chunk in the loop (first chunk + the rest via
		// mapWithConcurrency) — proves the check runs in the loop, not zero
		// times and not swallowed.
		expect(assertVideoNotDeletedMock.mock.calls.length).toBe(
			THREE_CHUNKS.chunks.length,
		);
	});
});
