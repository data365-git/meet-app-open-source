import { beforeEach, describe, expect, it, vi } from "vitest";

// Free-tier-first transcription (single behaviour): when GEMINI_API_KEY_FREE
// is set, transcribeAudio tries the free key first under a bounded probe; a
// quota answer or the probe deadline continues on paid immediately; any other
// free failure is a REAL error and never bills the paid path.

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
import { clearFreeTierVerdict, resetFreeTierHealth } from "@/lib/free-tier-health";

const CTX = { userId: "u1", orgId: "o1", videoId: "v1" };
const FREE_RESULT = { transcriptVtt: "WEBVTT\n\nFREE", inputTokens: 10, outputTokens: 5, audioInTokens: 3 };
const PAID_RESULT = { transcriptVtt: "WEBVTT\n\nPAID", inputTokens: 20, outputTokens: 8, audioInTokens: 6 };

type GuardOpt = { model?: string; free?: boolean; fn: () => Promise<unknown> };
type GeminiOpt = { apiKey?: string; models?: readonly string[] };
type FreeProbeOpt = GeminiOpt & {
	signal?: AbortSignal;
	maxAttempts?: number;
};

describe("transcribeAudio free-tier-first", () => {
	beforeEach(() => {
		resetFreeTierHealth();
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
		// (2026-07-29) The free attempt now carries a CHAIN of free models —
		// their daily quotas are separate (verified live), so the second model
		// doubles the free headroom before any paid fallback.
		expect(geminiOpt.models).toEqual([
			"gemini-3.5-flash",
			"gemini-3-flash-preview",
		]);
		const guardOpt = H.withCostGuard.mock.calls[0]?.[0] as GuardOpt;
		expect(guardOpt.free).toBe(true);
		expect(guardOpt.model).toBe("gemini-3.5-flash");
	});

	it("free quota failure: falls back to the paid key/model", async () => {
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

	it("NON-quota, NON-auth free failure (bad response): rethrows as a REAL error — the paid call is NEVER made", async () => {
		// A revoked free key or a malformed response is NOT exhaustion. The
		// round-8 shape treated ANY free failure as exhaustion, which would
		// silently bill every cheap chunk on the paid path with free quota
		// fully intact — the owner's original defect in a new shape. The error
		// must surface so the chunk retry machinery (retry → gap) handles it.
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key", GEMINI_API_KEY_FREE: "free-key" });
		H.transcribeWithGemini
			.mockRejectedValueOnce(new Error("Invalid response shape from Gemini"))
			.mockResolvedValueOnce(PAID_RESULT);

		const err = await transcribeAudio(
			"https://a/x.mp3",
			300,
			null,
			CTX,
		).catch((e) => e);

		expect((err as Error).message).toContain("Invalid response shape");
		// Exactly ONE call — the free attempt. No paid fallback happened.
		expect(H.transcribeWithGemini).toHaveBeenCalledTimes(1);
		expect((H.transcribeWithGemini.mock.calls[0]?.[1] as GeminiOpt).apiKey).toBe("free-key");
	});

	it("owner key + NO server key + no free key: runs on the OWNER'S OWN key — the only paid path that exists (round-7 #3)", async () => {
		// Without a server key the discounted Batch route cannot exist, so
		// parking would burn the ladder for a day and die. The owner's saved
		// personal key is his deliberate configuration — use it.
		H.serverEnv.mockReturnValue({});
		H.transcribeWithGemini.mockResolvedValue(PAID_RESULT);

		const out = await transcribeAudio(
			"https://a/x.mp3",
			300,
			"encrypted-owner-key",
			CTX,
		);

		expect(out).toBe("WEBVTT\n\nPAID");
		expect(H.transcribeWithGemini).toHaveBeenCalledTimes(1);
		expect(
			(H.transcribeWithGemini.mock.calls[0]?.[1] as GeminiOpt).apiKey,
		).toBe("decrypted-key");
	});

	it("owner key + NO server key + free FAILS: falls back to the owner's key, not the ladder (round-7 #3)", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY_FREE: "free-key" });
		H.transcribeWithGemini
			.mockRejectedValueOnce(new Error("429 RESOURCE_EXHAUSTED"))
			.mockResolvedValueOnce(PAID_RESULT);

		const out = await transcribeAudio(
			"https://a/x.mp3",
			300,
			"encrypted-owner-key",
			CTX,
		);

		expect(out).toBe("WEBVTT\n\nPAID");
		expect(H.transcribeWithGemini).toHaveBeenCalledTimes(2);
		expect(
			(H.transcribeWithGemini.mock.calls[1]?.[1] as GeminiOpt).apiKey,
		).toBe("decrypted-key");
	});

	it("server key AND owner key: the owner's saved key is preferred on the paid fallback (pre-existing precedence)", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key", GEMINI_API_KEY_FREE: "free-key" });
		H.transcribeWithGemini
			.mockRejectedValueOnce(new Error("429 RESOURCE_EXHAUSTED"))
			.mockResolvedValueOnce(PAID_RESULT);

		const out = await transcribeAudio(
			"https://a/x.mp3",
			300,
			"encrypted-owner-key",
			CTX,
		);

		expect(out).toBe("WEBVTT\n\nPAID");
		expect(
			(H.transcribeWithGemini.mock.calls[1]?.[1] as GeminiOpt).apiKey,
		).toBe("decrypted-key");
	});

	it("the free probe is bounded: single attempt (maxAttempts=1) with an abort signal", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key", GEMINI_API_KEY_FREE: "free-key" });
		H.transcribeWithGemini.mockResolvedValue(FREE_RESULT);

		await transcribeAudio("https://a/x.mp3", 300, null, CTX);

		const opt = H.transcribeWithGemini.mock.calls[0]?.[1] as FreeProbeOpt;
		expect(opt.maxAttempts).toBe(1);
		expect(opt.signal).toBeInstanceOf(AbortSignal);
	});

	it("probe deadline: aborts the free attempt and falls back to paid exactly once", async () => {
		vi.useFakeTimers();
		try {
			H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key", GEMINI_API_KEY_FREE: "free-key" });
			// Free hangs until its abort signal fires (the probe deadline), proving
			// the deadline — not a mock rejection — is what triggers the fallback.
			H.transcribeWithGemini.mockImplementationOnce(
				(_u: string, o: FreeProbeOpt) =>
					new Promise((_resolve, reject) => {
						o.signal?.addEventListener("abort", () =>
							reject(o.signal?.reason ?? new Error("aborted")),
						);
					}),
			);
			H.transcribeWithGemini.mockResolvedValueOnce(PAID_RESULT);

			const promise = transcribeAudio("https://a/x.mp3", 300, null, CTX);
			await vi.advanceTimersByTimeAsync(31_000);
			const out = await promise;

			expect(out).toBe("WEBVTT\n\nPAID");
			// One free attempt (aborted), then exactly one paid fallback — never two.
			expect(H.transcribeWithGemini).toHaveBeenCalledTimes(2);
			expect((H.transcribeWithGemini.mock.calls[0]?.[1] as FreeProbeOpt).apiKey).toBe("free-key");
			expect((H.transcribeWithGemini.mock.calls[1]?.[1] as FreeProbeOpt).apiKey).toBe("paid-key");
		} finally {
			vi.useRealTimers();
		}
	});

	it("a broken free key does NOT deadlock the job: ONE full-chain auth failure is conclusive — the SAME call continues on paid (round-13 #2)", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key", GEMINI_API_KEY_FREE: "free-key" });
		// Call 1: the free chain answers with the invalid-key family; the call
		// completes on paid immediately — no counter, no third strike, no
		// dependence on how many chunks the video has (the round-12 counter
		// made SHORT videos unrecoverable: one signal per job start, reset at
		// every retry, bound of 3 never reached).
		H.transcribeWithGemini
			.mockRejectedValueOnce(new Error("400 API_KEY_INVALID"))
			.mockResolvedValueOnce(PAID_RESULT);
		const out = await transcribeAudio("https://a/x.mp3", 300, null, CTX);
		expect(out).toBe("WEBVTT\n\nPAID");
		expect(H.transcribeWithGemini).toHaveBeenCalledTimes(2);
		expect((H.transcribeWithGemini.mock.calls[0]?.[1] as GeminiOpt).apiKey).toBe("free-key");
		expect((H.transcribeWithGemini.mock.calls[1]?.[1] as GeminiOpt).apiKey).toBe("paid-key");

		// Call 2, same job: the verdict stands — free is skipped, straight to
		// paid, no wasted probe.
		H.transcribeWithGemini.mockResolvedValueOnce(PAID_RESULT);
		const out2 = await transcribeAudio("https://a/x.mp3", 300, null, CTX);
		expect(out2).toBe("WEBVTT\n\nPAID");
		expect(H.transcribeWithGemini).toHaveBeenCalledTimes(3);
		expect((H.transcribeWithGemini.mock.calls[2]?.[1] as GeminiOpt).apiKey).toBe("paid-key");
	});

	it("clearFreeTierVerdict (the job-start reset) restores free attempts after the key is fixed", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key", GEMINI_API_KEY_FREE: "free-key" });
		H.transcribeWithGemini
			.mockRejectedValueOnce(new Error("400 API_KEY_INVALID"))
			.mockResolvedValueOnce(PAID_RESULT);
		expect(await transcribeAudio("https://a/x.mp3", 300, null, CTX)).toBe(
			"WEBVTT\n\nPAID",
		);

		// A NEW job start (the owner's Retry after fixing the key) clears the
		// verdict, so the free tier gets its chance again.
		clearFreeTierVerdict("v1");
		H.transcribeWithGemini.mockResolvedValueOnce(FREE_RESULT);
		expect(await transcribeAudio("https://a/x.mp3", 300, null, CTX)).toBe(
			"WEBVTT\n\nFREE",
		);
		const lastCall = H.transcribeWithGemini.mock.calls.at(-1);
		expect((lastCall?.[1] as GeminiOpt).apiKey).toBe("free-key");
	});

	it("freeOnly (silence gap-fill span): a free failure rethrows — the paid path is NEVER entered", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key", GEMINI_API_KEY_FREE: "free-key" });
		H.transcribeWithGemini.mockRejectedValue(new Error("429 RESOURCE_EXHAUSTED"));

		const err = await transcribeAudio("https://a/x.mp3", 300, null, {
			...CTX,
			freeOnly: true,
		}).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect(H.transcribeWithGemini).toHaveBeenCalledTimes(1);
		expect((H.transcribeWithGemini.mock.calls[0]?.[1] as GeminiOpt).apiKey).toBe("free-key");
	});

	it("freeOnly + NO free key: throws without any API call — a silence span never spends", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key" });

		const err = await transcribeAudio("https://a/x.mp3", 300, null, {
			...CTX,
			freeOnly: true,
		}).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect(H.transcribeWithGemini).not.toHaveBeenCalled();
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
