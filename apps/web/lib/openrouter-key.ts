import { serverEnv } from "@cap/env";

/**
 * THE single owner of the OpenRouter credential.
 *
 * Deliberately a byte-for-byte MIRROR of lib/gemini-paid-key.ts, because
 * OpenRouter is not a second, softer way to spend: it is the SAME paid leg,
 * moved to a different vendor. The boundary that stopped ~20 money defects on
 * the Gemini credential (judge, 2026-08-11) is the boundary this file re-erects
 * for the new one — with the key ambiently in scope, every error path's default
 * becomes a paid call. Every use must name WHAT it is (operation and route, no
 * unchecked escape hatch), and a source-scan test fails the build if any file
 * outside this module reads `OPENROUTER_API_KEY` directly.
 *
 * THE INVARIANT (owner): a job never calls a paid API while free quota is still
 * available. OpenRouter has NO free tier here — the free chain is Google's and
 * is untouched — so every job-bound synchronous OpenRouter call must declare
 * `freeAttempted: true`, and it must be a FACT about THIS call computed after
 * the free chain ran, never a literal at the call site. A broken key, a safety
 * block or a malformed response is a real ERROR, not exhaustion.
 */
export type OpenRouterUse =
	/** Job-bound operations: `freeAttempted` MUST be the classified fact
	 * computed after the free chain ran, never a literal at the call site. */
	| {
			operation: "transcription" | "generation";
			route: "sync";
			freeAttempted: boolean;
	  }
	/** Job-less operations: no free tier applies, so there is no fact to
	 * declare. */
	| {
			operation:
				| "translation"
				| "chat"
				/** Operator-run verification/maintenance scripts (never a request
				 * path). */
				| "ops-script";
			route: "sync";
	  };

/** The authorization check, separated from the key handout so call sites
 * that resolve their key elsewhere still MUST pass the same gate. */
export function authorizeOpenRouterUse(use: OpenRouterUse): void {
	if ("freeAttempted" in use && use.freeAttempted !== true) {
		throw new OpenRouterWhileFreeAvailableError();
	}
}

export class OpenRouterWhileFreeAvailableError extends Error {
	constructor() {
		super(
			"INVARIANT VIOLATION: a job must not call the paid OpenRouter API while free quota is still available — the caller did not declare freeAttempted (owner rule: free first, paid only when free is out or too slow)",
		);
		this.name = "OpenRouterWhileFreeAvailableError";
	}
}

export function getOpenRouterKey(use: OpenRouterUse): string | undefined {
	authorizeOpenRouterUse(use);
	return serverEnv().OPENROUTER_API_KEY;
}

/** Existence check for gating/availability UI — never hands out the value.
 * This is also the switch that decides whether the paid leg goes to OpenRouter
 * at all: no key configured means the paid Gemini path stays exactly as it is
 * today. */
export function hasOpenRouterKey(): boolean {
	return Boolean(serverEnv().OPENROUTER_API_KEY);
}

/** Read-only balance lookup for the admin status badge (openrouter-balance.ts).
 * Generates nothing and spends nothing — the only thing it unlocks is
 * GET /api/v1/credits — so there is no `freeAttempted` fact to declare. The
 * key still never leaves the server module boundary. */
export function getOpenRouterBalanceKey(): string | undefined {
	return serverEnv().OPENROUTER_API_KEY;
}
