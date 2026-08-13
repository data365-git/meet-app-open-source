import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Free-tier-first summary/refine: when GEMINI_API_KEY_FREE is set, callAiApi
// tries gemini-3.5-flash at $0 and falls back to the paid model chain on failure.

const H = vi.hoisted(() => ({
	serverEnv: vi.fn(),
	withCostGuard: vi.fn(),
	withGeminiRetry: vi.fn(),
	fetch: vi.fn(),
}));

vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => H.serverEnv() }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@/lib/ai-cost-guard", () => ({
	BudgetExceededError: class BudgetExceededError extends Error {},
	withCostGuard: (o: unknown) => H.withCostGuard(o),
}));
vi.mock("@/lib/concurrency", () => ({
	AI_CHUNK_CONCURRENCY: 1,
	mapWithConcurrency: async <T, R>(
		items: T[],
		_concurrency: number,
		fn: (item: T, index: number) => Promise<R>,
	) => Promise.all(items.map((item, index) => fn(item, index))),
}));
vi.mock("@/lib/gemini-retry", () => ({
	withGeminiRetry: (fn: () => Promise<unknown>) => H.withGeminiRetry(fn),
}));
vi.mock("@/lib/gemini-transcribe", () => ({
	stripRunawayRepetition: (text: string) => ({ text, runaway: false }),
}));
vi.mock("@/lib/prompt-rules", () => ({ MIXED_LANGUAGE_PRESERVATION_RULES: "" }));
vi.mock("@/lib/restore-russian-script", () => ({
	restoreRussianScriptDeep: (value: unknown) => value,
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/transcript-vtt", () => ({
	normalizeWebVttVoiceText: (text: string) => text,
}));
vi.mock("@/lib/video-metadata", () => ({ patchVideoMetadata: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({ getStorageAccessForVideo: vi.fn() }));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));
vi.mock("server-only", () => ({}));

import { callAiApi } from "@/workflows/generate-ai";
import { resetFreeTierHealth } from "@/lib/free-tier-health";

const CTX = { userId: "u1", orgId: "o1", videoId: "v1" };

type GuardOpt = { model?: string; free?: boolean; fn: () => Promise<unknown> };

function geminiOk(content: string, inputTokens = 10, outputTokens = 5): Response {
	return {
		ok: true,
		status: 200,
		json: vi.fn(async () => ({
			candidates: [
				{
					content: { parts: [{ text: content }] },
					finishReason: "STOP",
				},
			],
			usageMetadata: {
				promptTokenCount: inputTokens,
				candidatesTokenCount: outputTokens,
			},
		})),
	} as unknown as Response;
}

function geminiError(status: number, message: string): Response {
	return {
		ok: false,
		status,
		json: vi.fn(async () => ({ error: { message } })),
	} as unknown as Response;
}

function fetchUrl(callIndex: number): string {
	return String(H.fetch.mock.calls[callIndex]?.[0] ?? "");
}

describe("callAiApi free-tier-first", () => {
	beforeEach(() => {
		resetFreeTierHealth();
		H.serverEnv.mockReset();
		H.withCostGuard.mockReset();
		H.withGeminiRetry.mockReset();
		H.fetch.mockReset();
		H.withCostGuard.mockImplementation(async (o: GuardOpt) => o.fn());
		H.withGeminiRetry.mockImplementation((fn: () => Promise<unknown>) => fn());
		vi.stubGlobal("fetch", H.fetch);
		vi.spyOn(console, "warn").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("free key set + free succeeds: uses free model, records free:true, no paid call", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch.mockResolvedValueOnce(geminiOk('{"ok":true}', 11, 7));

		const out = await callAiApi("prompt", {}, CTX);

		expect(out).toEqual({
			content: '{"ok":true}',
			model: "gemini-3.5-flash",
			inputTokens: 11,
			outputTokens: 7,
		});
		expect(H.fetch).toHaveBeenCalledTimes(1);
		expect(fetchUrl(0)).toContain("/models/gemini-3.5-flash:generateContent");
		expect(fetchUrl(0)).toContain("key=free-key");
		const guardOpt = H.withCostGuard.mock.calls[0]?.[0] as GuardOpt;
		expect(guardOpt.model).toBe("gemini-3.5-flash");
		expect(guardOpt.free).toBe(true);
	});

	it("free key set + non-json refine succeeds with plain text", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch.mockResolvedValueOnce(geminiOk("Clean readable transcript.", 12, 9));

		const out = await callAiApi("prompt", { json: false }, CTX);

		expect(out).toEqual({
			content: "Clean readable transcript.",
			model: "gemini-3.5-flash",
			inputTokens: 12,
			outputTokens: 9,
		});
		expect(H.fetch).toHaveBeenCalledTimes(1);
		expect(fetchUrl(0)).toContain("key=free-key");
		expect((H.withCostGuard.mock.calls[0]?.[0] as GuardOpt).free).toBe(true);
	});

	// (2026-07-29) The free tier is now a CHAIN of two models on the free key —
	// verified live that their daily quotas are separate. A single free failure
	// therefore tries the second free model before any paid call.
	it("free key set + malformed free JSON: SECOND free model rescues at $0, accumulates tokens", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch
			.mockResolvedValueOnce(geminiOk('{"bad":', 11, 7))
			.mockResolvedValueOnce(geminiOk('{"free2":true}', 20, 8));

		const out = await callAiApi("prompt", {}, CTX);

		expect(out.content).toBe('{"free2":true}');
		expect(out.model).toBe("gemini-3-flash-preview");
		expect(H.fetch).toHaveBeenCalledTimes(2);
		expect(fetchUrl(0)).toContain("key=free-key");
		expect(fetchUrl(1)).toContain("key=free-key");
		expect(fetchUrl(1)).toContain("/models/gemini-3-flash-preview:generateContent");
		expect((H.withCostGuard.mock.calls[0]?.[0] as GuardOpt).free).toBe(true);
		expect((H.withCostGuard.mock.calls[1]?.[0] as GuardOpt).free).toBe(true);
	});

	it("first free model 429: second FREE model rescues before any paid call", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch
			.mockResolvedValueOnce(geminiError(429, "RESOURCE_EXHAUSTED"))
			.mockResolvedValueOnce(geminiOk('{"free2":true}', 20, 8));

		const out = await callAiApi("prompt", {}, CTX);

		expect(out.content).toBe('{"free2":true}');
		expect(out.model).toBe("gemini-3-flash-preview");
		expect(H.fetch).toHaveBeenCalledTimes(2);
		expect(fetchUrl(0)).toContain("/models/gemini-3.5-flash:generateContent");
		expect(fetchUrl(0)).toContain("key=free-key");
		expect(fetchUrl(1)).toContain("/models/gemini-3-flash-preview:generateContent");
		expect(fetchUrl(1)).toContain("key=free-key");
	});

	it("BOTH free models 429: genuine exhaustion — pays INLINE and carries on, no waiting", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch
			.mockResolvedValueOnce(geminiError(429, "RESOURCE_EXHAUSTED"))
			.mockResolvedValueOnce(geminiError(429, "RESOURCE_EXHAUSTED"))
			.mockResolvedValueOnce(geminiOk('{"paid":true}', 20, 8));

		const out = await callAiApi("prompt", {}, CTX);

		expect(out.content).toBe('{"paid":true}');
		expect(H.fetch).toHaveBeenCalledTimes(3);
		expect(fetchUrl(0)).toContain("/models/gemini-3.5-flash:generateContent");
		expect(fetchUrl(1)).toContain("/models/gemini-3-flash-preview:generateContent");
		expect(fetchUrl(2)).toContain("key=paid-key");
	});

	it("one quota error and one REAL error: the real error surfaces — paid is NOT billed with free quota intact", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch
			.mockResolvedValueOnce(geminiError(429, "RESOURCE_EXHAUSTED"))
			.mockResolvedValueOnce(geminiOk('{"bad":', 9, 3))
			.mockResolvedValueOnce(geminiOk('{"paid":true}', 20, 8));

		await expect(callAiApi("prompt", {}, CTX)).rejects.toBeInstanceOf(
			Error,
		);
		// Both free attempts ran; the paid call never did.
		expect(H.fetch).toHaveBeenCalledTimes(2);
	});

	it("non-quota errors on BOTH free models (e.g. revoked key): real error, ZERO paid calls", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch
			.mockResolvedValueOnce(geminiOk('{"bad":', 11, 7))
			.mockResolvedValueOnce(geminiOk('{"still bad":', 4, 2))
			.mockResolvedValueOnce(geminiOk('{"paid":true}', 20, 8));

		await expect(callAiApi("prompt", {}, CTX)).rejects.toBeInstanceOf(
			Error,
		);
		expect(H.fetch).toHaveBeenCalledTimes(2);
		for (const call of H.fetch.mock.calls) {
			expect(String(call[0])).toContain("key=free-key");
		}
	});

	it("the free probe always threads an abort signal into the free call (bounded, never patient)", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch.mockResolvedValue(geminiOk('{"ok":true}', 11, 7));

		await callAiApi("prompt", {}, CTX);
		const probeOpt = H.fetch.mock.calls[0]?.[1] as { signal?: AbortSignal };
		expect(probeOpt.signal).toBeInstanceOf(AbortSignal);
	});

	it("probe deadline: aborts the free probe and falls back to paid once", async () => {
		vi.useFakeTimers();
		try {
			H.serverEnv.mockReturnValue({
				GEMINI_API_KEY: "paid-key",
				GEMINI_API_KEY_FREE: "free-key",
			});
			// Free fetch hangs until its abort signal fires (the 8s probe deadline).
			H.fetch.mockImplementationOnce(
				(_url: string, opts: { signal?: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						opts.signal?.addEventListener("abort", () =>
							reject(opts.signal?.reason ?? new Error("aborted")),
						);
					}),
			);
			H.fetch.mockResolvedValueOnce(geminiOk('{"paid":true}', 20, 8));

			const promise = callAiApi("prompt", {}, CTX);
			await vi.advanceTimersByTimeAsync(8_100);
			const out = await promise;

			expect(out.content).toBe('{"paid":true}');
			expect(out.model).toBe("gemini-3-flash-preview");
			expect(H.fetch).toHaveBeenCalledTimes(2);
			expect(fetchUrl(1)).toContain("key=paid-key");
		} finally {
			vi.useRealTimers();
		}
	});

	it("a broken free key does NOT deadlock generation: ONE full-chain auth failure is conclusive — the SAME call completes on paid (round-13 #2)", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});

		// Call 1: both free models answer with the invalid-key family; the call
		// continues on paid immediately — critical for SHORT videos, whose
		// single summary call was permanently unrecoverable under a 3-strike
		// counter that reset at every job start (round-13 #2).
		H.fetch
			.mockResolvedValueOnce(geminiError(400, "API key not valid. Please pass a valid API key."))
			.mockResolvedValueOnce(geminiError(400, "API key not valid. Please pass a valid API key."))
			.mockResolvedValueOnce(geminiOk('{"paid":true}', 20, 8));
		const out = await callAiApi("prompt", {}, CTX);
		expect(out.content).toBe('{"paid":true}');
		expect(H.fetch).toHaveBeenCalledTimes(3);
		expect(String(H.fetch.mock.calls[2]?.[0])).toContain("key=paid-key");

		// Call 2, same job: free is skipped entirely — the verdict stands.
		H.fetch.mockClear();
		H.fetch.mockResolvedValueOnce(geminiOk('{"paid":true}', 20, 8));
		const out2 = await callAiApi("prompt", {}, CTX);
		expect(out2.content).toBe('{"paid":true}');
		expect(H.fetch).toHaveBeenCalledTimes(1);
		expect(String(H.fetch.mock.calls[0]?.[0])).toContain("key=paid-key");
	});

	it("a burst of transient 503s NEVER opens the paid path — overload is not a broken key (round-12 #1)", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		for (let i = 0; i < 3; i++) {
			H.fetch
				.mockResolvedValueOnce(geminiError(503, "The model is overloaded"))
				.mockResolvedValueOnce(geminiError(503, "The model is overloaded"));
			await expect(callAiApi("prompt", {}, CTX)).rejects.toBeInstanceOf(Error);
		}
		for (const call of H.fetch.mock.calls) {
			expect(String(call[0])).toContain("key=free-key");
		}
	});

	it("repeated UNUSABLE free output never opens the paid path — a bad result is not a broken key (round-12 #1)", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		for (let i = 0; i < 3; i++) {
			H.fetch
				.mockResolvedValueOnce(geminiOk('{"bad":', 1, 1))
				.mockResolvedValueOnce(geminiOk('{"bad":', 1, 1));
			await expect(callAiApi("prompt", {}, CTX)).rejects.toBeInstanceOf(Error);
		}
		for (const call of H.fetch.mock.calls) {
			expect(String(call[0])).toContain("key=free-key");
		}
	});

	it("a free-model-specific 400 (INVALID_ARGUMENT) plus a 503 never routes the job to paid (round-14 #1)", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		// The exact scenario: the free chain leads with a model the paid list
		// does not use; a 400 specific to it + a 503 on the fallback.
		for (let i = 0; i < 2; i++) {
			H.fetch
				.mockResolvedValueOnce(geminiError(400, "Request contains an invalid argument."))
				.mockResolvedValueOnce(geminiError(503, "The model is overloaded"));
			await expect(callAiApi("prompt", {}, CTX)).rejects.toBeInstanceOf(Error);
		}
		for (const call of H.fetch.mock.calls) {
			expect(String(call[0])).toContain("key=free-key");
		}
	});

	it("a mixed set where the QUOTA error carries a 403 token stays quota-classified — zero paid calls (round-14 #2)", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		// Quota-shaped 429 whose body happens to mention HTTP 403, plus a 503:
		// quota must be classified FIRST, exactly like the other two call
		// sites, so the auth branch never sees it.
		H.fetch
			.mockResolvedValueOnce(
				geminiError(429, "RESOURCE_EXHAUSTED: quota exceeded (upstream HTTP 403)"),
			)
			.mockResolvedValueOnce(geminiError(503, "The model is overloaded"));
		await expect(callAiApi("prompt", {}, CTX)).rejects.toBeInstanceOf(Error);
		for (const call of H.fetch.mock.calls) {
			expect(String(call[0])).toContain("key=free-key");
		}
	});

	it("free CONTENT that merely quotes 'HTTP 403' is unusable output, not a revoked key — zero paid calls (round-15 #2)", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		// JSON.parse of this content produces a V8 message that QUOTES the
		// content's first characters ("Unexpected token 'H', \"HTTP 403 F\"...")
		// — a content-parse failure must be tagged at the throw site and never
		// reach the classifier at all.
		H.fetch
			.mockResolvedValueOnce(geminiOk("HTTP 403 Forbidden by upstream proxy", 5, 2))
			.mockResolvedValueOnce(geminiOk("HTTP 403 Forbidden by upstream proxy", 5, 2));
		await expect(callAiApi("prompt", {}, CTX)).rejects.toBeInstanceOf(Error);
		for (const call of H.fetch.mock.calls) {
			expect(String(call[0])).toContain("key=free-key");
		}
	});

	it("no free key: paid path only, exactly one call", async () => {
		H.serverEnv.mockReturnValue({ GEMINI_API_KEY: "paid-key" });
		H.fetch.mockResolvedValueOnce(geminiOk('{"paid":true}', 20, 8));

		const out = await callAiApi("prompt", {}, CTX);

		expect(out).toEqual({
			content: '{"paid":true}',
			model: "gemini-3-flash-preview",
			inputTokens: 20,
			outputTokens: 8,
		});
		expect(H.fetch).toHaveBeenCalledTimes(1);
		expect(fetchUrl(0)).toContain("/models/gemini-3-flash-preview:generateContent");
		expect(fetchUrl(0)).toContain("key=paid-key");
		expect((H.withCostGuard.mock.calls[0]?.[0] as GuardOpt).free).toBeFalsy();
	});
});
