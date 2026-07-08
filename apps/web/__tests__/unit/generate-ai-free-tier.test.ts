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
const CHEAP_CTX = { ...CTX, aiSpeedMode: "cheap" as const };

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

	it("free key set + malformed free JSON: records free usage, falls back to paid, accumulates tokens", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch
			.mockResolvedValueOnce(geminiOk('{"bad":', 11, 7))
			.mockResolvedValueOnce(geminiOk('{"paid":true}', 20, 8));

		const out = await callAiApi("prompt", {}, CTX);

		expect(out.content).toBe('{"paid":true}');
		expect(out.model).toBe("gemini-3-flash-preview");
		expect(out.inputTokens).toBe(31);
		expect(out.outputTokens).toBe(15);
		expect(H.fetch).toHaveBeenCalledTimes(2);
		expect(fetchUrl(0)).toContain("key=free-key");
		expect(fetchUrl(1)).toContain("key=paid-key");
		expect((H.withCostGuard.mock.calls[0]?.[0] as GuardOpt).free).toBe(true);
		expect((H.withCostGuard.mock.calls[1]?.[0] as GuardOpt).free).toBeFalsy();
	});

	it("fast mode + free HTTP 429: falls back to the paid model chain", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch
			.mockResolvedValueOnce(geminiError(429, "RESOURCE_EXHAUSTED"))
			.mockResolvedValueOnce(geminiOk('{"paid":true}', 20, 8));

		const out = await callAiApi("prompt", {}, CTX);

		expect(out.content).toBe('{"paid":true}');
		expect(out.model).toBe("gemini-3-flash-preview");
		expect(H.fetch).toHaveBeenCalledTimes(2);
		expect(fetchUrl(0)).toContain("/models/gemini-3.5-flash:generateContent");
		expect(fetchUrl(1)).toContain("/models/gemini-3-flash-preview:generateContent");
	});

	it("cheap mode + free HTTP 429: throws instead of falling back to paid", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch.mockResolvedValueOnce(geminiError(429, "RESOURCE_EXHAUSTED"));

		await expect(callAiApi("prompt", {}, CHEAP_CTX)).rejects.toMatchObject({
			name: "AiQuotaWaitError",
		});

		expect(H.fetch).toHaveBeenCalledTimes(1);
		expect(fetchUrl(0)).toContain("/models/gemini-3.5-flash:generateContent");
	});

	it("cheap mode + non-quota free error: falls back to paid", async () => {
		H.serverEnv.mockReturnValue({
			GEMINI_API_KEY: "paid-key",
			GEMINI_API_KEY_FREE: "free-key",
		});
		H.fetch
			.mockResolvedValueOnce(geminiOk('{"bad":', 11, 7))
			.mockResolvedValueOnce(geminiOk('{"paid":true}', 20, 8));

		const out = await callAiApi("prompt", {}, CHEAP_CTX);

		expect(out.content).toBe('{"paid":true}');
		expect(out.model).toBe("gemini-3-flash-preview");
		expect(H.fetch).toHaveBeenCalledTimes(2);
		expect(fetchUrl(1)).toContain("key=paid-key");
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
