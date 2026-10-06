/**
 * Pins the flex-tier routing: the body bytes, the bounded fallback, and the
 * fact that the interactive legs' default body is untouched.
 *
 * Every assertion reads what the production code actually put on the wire
 * (via a fake fetchImpl) or actually returned — nothing is re-declared at the
 * test boundary.
 */
import { describe, expect, it, vi } from "vitest";
import {
	buildOpenRouterBody,
	OPENROUTER_FLEX_PROVIDER_ORDER,
	openRouterCompletion,
} from "@/lib/openrouter";

const MESSAGES = [{ role: "user" as const, content: "ping" }];

const okPayload = (text: string) => ({
	choices: [{ message: { content: text }, finish_reason: "stop" }],
	usage: { prompt_tokens: 3, completion_tokens: 2, cost: 0.000004 },
});

const okResponse = (text: string) =>
	new Response(JSON.stringify(okPayload(text)), {
		status: 200,
		headers: { "content-type": "application/json" },
	});

/** A fetch that never resolves on its own — it only ends when the attempt's
 * signal aborts (exactly how the real fetch behaves). */
const hangingFetch =
	() =>
	async (_url: unknown, init?: RequestInit): Promise<Response> =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => {
				reject(init.signal?.reason ?? new Error("aborted"));
			});
		});

const lastBodyOf = (calls: Array<[unknown, RequestInit | undefined]>, i: number) =>
	JSON.parse(String(calls[i]?.[1]?.body)) as Record<string, unknown>;

describe("buildOpenRouterBody flex", () => {
	it("(a) default body has NO provider field — chat/translate bytes unchanged", () => {
		const body = buildOpenRouterBody({
			messages: MESSAGES,
			maxTokens: 100,
			temperature: 0.2,
		});
		expect("provider" in body).toBe(false);
	});

	it("(b) flex body carries the exact measured provider object", () => {
		const body = buildOpenRouterBody({
			messages: MESSAGES,
			maxTokens: 100,
			temperature: 0.2,
			flex: true,
		});
		expect(body.provider).toEqual({
			order: OPENROUTER_FLEX_PROVIDER_ORDER,
			allow_fallbacks: true,
		});
	});
});

describe("openRouterCompletion flex", () => {
	it("(c) flex attempt that never resolves: after OUR deadline exactly one standard retry, whose result is returned", async () => {
		const calls: Array<[unknown, RequestInit | undefined]> = [];
		const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
			calls.push([url, init]);
			if (calls.length === 1) return hangingFetch()(url, init);
			return okResponse("standard-fallback-text");
		});

		const result = await openRouterCompletion({
			apiKey: "sk-or-v1-test",
			messages: MESSAGES,
			maxTokens: 100,
			temperature: 0.2,
			flex: true,
			flexTimeoutMs: 25,
			fetchImpl,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(lastBodyOf(calls, 0).provider).toEqual({
			order: OPENROUTER_FLEX_PROVIDER_ORDER,
			allow_fallbacks: true,
		});
		// The retry is the STANDARD body: no provider routing.
		expect("provider" in lastBodyOf(calls, 1)).toBe(false);
		expect(result.text).toBe("standard-fallback-text");
	});

	it("(d) the CALLER's abort during a flex attempt: rejects immediately, NO second fetch", async () => {
		const calls: Array<[unknown, RequestInit | undefined]> = [];
		const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
			calls.push([url, init]);
			return hangingFetch()(url, init);
		});
		const caller = new AbortController();
		setTimeout(() => caller.abort(), 15);

		await expect(
			openRouterCompletion({
				apiKey: "sk-or-v1-test",
				messages: MESSAGES,
				maxTokens: 100,
				temperature: 0.2,
				flex: true,
				flexTimeoutMs: 10_000,
				signal: caller.signal,
				fetchImpl,
			}),
		).rejects.toThrow();

		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it("(e) flex attempt that succeeds (HTTP 200): exactly one fetch, flex body on the wire", async () => {
		const calls: Array<[unknown, RequestInit | undefined]> = [];
		const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit) => {
			calls.push([url, init]);
			return okResponse("flex-text");
		});

		const result = await openRouterCompletion({
			apiKey: "sk-or-v1-test",
			messages: MESSAGES,
			maxTokens: 100,
			temperature: 0.2,
			flex: true,
			flexTimeoutMs: 10_000,
			fetchImpl,
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		expect(lastBodyOf(calls, 0).provider).toEqual({
			order: OPENROUTER_FLEX_PROVIDER_ORDER,
			allow_fallbacks: true,
		});
		expect(result.text).toBe("flex-text");
	});
});
