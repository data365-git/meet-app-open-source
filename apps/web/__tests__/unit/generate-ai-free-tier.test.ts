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
