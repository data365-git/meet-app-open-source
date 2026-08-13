/**
 * Free-first connect for the meeting-chat stream.
 *
 * Chat was the last AI path still pinned to the paid key, so every question
 * billed even while the shared free key's daily quota sat untouched. Two free
 * models are tried because the free key's quota is per-MODEL and separate
 * (verified live 2026-07-29: one 429s while the other still answers 200 on the
 * same key).
 *
 * WHY THIS IS SAFE HERE, and only here: the fallback happens at CONNECT time. A
 * quota rejection arrives before a single token has been streamed, so swapping
 * keys is invisible to the reader. Nothing may switch keys once tokens have
 * started flowing — that would splice two different answers together.
 *
 * Two properties are load-bearing and are pinned by tests, because both were
 * defects in the first version of this code:
 *
 *  1. The free chain is walked AT MOST ONCE per request. The caller wraps this
 *     in a retry helper; without the latch, five retry rounds × three keys is
 *     fifteen upstream calls for one question, ten of them burning the very
 *     quota this exists to save. A free key that says 429 now will say 429 four
 *     seconds later.
 *  2. The FINAL (paid) response is returned UNREAD. Draining it here to "tidy
 *     up" left the caller unable to read the real Gemini error, so every outage
 *     reported itself as a bare status code.
 */

import {
	OPENROUTER_COMPLETIONS_URL,
	openRouterHeaders,
} from "@/lib/openrouter";

export type ChatProvider = "gemini-free" | "gemini-paid" | "openrouter";

export type GeminiChatFetcher = {
	/** Connects, free models first. Resolves with the response to stream from.
	 * `openRouterInit` is the SAME question expressed in OpenRouter's request
	 * shape; it is used only if the paid leg is an OpenRouter leg, and the two
	 * bodies are built together at the call site so they can never drift apart.
	 */
	fetch: (
		init: RequestInit,
		openRouterInit?: RequestInit,
	) => Promise<Response>;
	/** True when the response came from the free key — such a call costs nothing. */
	usedFreeKey: () => boolean;
	/** Which leg actually answered — the caller needs it to parse the stream,
	 * since Gemini SSE and OpenRouter SSE are different wire formats. */
	provider: () => ChatProvider;
};

const FREE_CHAT_MODELS = ["gemini-3.5-flash", "gemini-3-flash-preview"] as const;
const PAID_CHAT_MODEL = "gemini-2.5-flash";

function endpoint(model: string, key: string): string {
	return `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;
}

export function createGeminiChatFetcher(opts: {
	paidKey: string;
	/** Omit when the video owner supplied their own key — see the route. */
	freeKey?: string;
	/** When present the PAID leg goes to OpenRouter instead of paid Gemini. The
	 * free chain above it is untouched: OpenRouter is the same paid step with a
	 * different vendor, never an extra one. */
	openRouterKey?: string;
	/** Injected for tests. */
	fetchImpl?: typeof fetch;
}): GeminiChatFetcher {
	const doFetch = opts.fetchImpl ?? fetch;
	const freeAttempts = opts.freeKey
		? FREE_CHAT_MODELS.map((model) => ({
				key: opts.freeKey as string,
				model,
			}))
		: [];

	let usedFree = false;
	let freeChainSpent = false;
	let usedProvider: ChatProvider = "gemini-paid";

	return {
		usedFreeKey: () => usedFree,
		provider: () => usedProvider,
		fetch: async (init: RequestInit, openRouterInit?: RequestInit) => {
			if (!freeChainSpent) {
				for (const attempt of freeAttempts) {
					let res: Response;
					try {
						res = await doFetch(endpoint(attempt.model, attempt.key), init);
					} catch {
						// A network failure on the free key is not the reader's problem;
						// fall through to paid instead of surfacing it.
						continue;
					}
					if (res.ok) {
						usedFree = true;
						usedProvider = "gemini-free";
						return res;
					}
					// Safe to drain: we are definitely moving on from this one, and
					// releasing the connection matters more than its body.
					await res.text().catch(() => "");
				}
				freeChainSpent = true;
			}

			usedFree = false;
			// Deliberately NOT read here — the caller needs the body to report the
			// real error.
			if (opts.openRouterKey && openRouterInit) {
				usedProvider = "openrouter";
				return doFetch(OPENROUTER_COMPLETIONS_URL, {
					...openRouterInit,
					headers: {
						...(openRouterInit.headers as Record<string, string> | undefined),
						...openRouterHeaders(opts.openRouterKey),
					},
				});
			}
			usedProvider = "gemini-paid";
			return doFetch(endpoint(PAID_CHAT_MODEL, opts.paidKey), init);
		},
	};
}
