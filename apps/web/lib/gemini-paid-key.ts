import { serverEnv } from "@cap/env";

/**
 * THE single owner of the PAID Gemini credential on the AI path.
 *
 * The boundary is the structural fix (judge, 2026-08-11): with the key
 * ambiently in scope, every error path's default was a paid call. Every use
 * must name WHAT it is — operation and route, no unchecked escape hatch —
 * and a source-scan test fails the build if any AI-path file reads the env
 * var directly.
 *
 * THE INVARIANT (owner, 2026-08-13 — the speed-mode chooser is deleted, one
 * behaviour remains): a job never calls a paid API while free quota is still
 * available. Every job-bound synchronous paid call must declare
 * `freeAttempted: true`, and it must be a FACT about THIS call: the free
 * chain was genuinely given its chance first — it answered with a real
 * quota/rate-limit signal, it blew the bounded probe deadline (the owner
 * chose time over waiting), or no free key is configured at all. A broken
 * key, a safety block or a malformed response is a real ERROR, not
 * exhaustion — billing paid on those is the owner's original defect.
 */
export type PaidGeminiUse =
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
				/** poll-batch-jobs cron draining LEGACY durable Batch jobs
				 * (nothing submits new ones — collection/cancellation only). */
				| "legacy-batch-admin"
				/** Operator-run verification/maintenance scripts (never a request
				 * path). */
				| "ops-script";
			route: "sync" | "batch";
	  };

/** The authorization check, separated from the key handout so call sites
 * that resolve their key elsewhere (the video owner's personal key) still
 * MUST pass the same gate. */
export function authorizePaidGeminiUse(use: PaidGeminiUse): void {
	if ("freeAttempted" in use && use.freeAttempted !== true) {
		throw new PaidWhileFreeAvailableError();
	}
}

export class PaidWhileFreeAvailableError extends Error {
	constructor() {
		super(
			"INVARIANT VIOLATION: a job must not call a paid Gemini API while free quota is still available — the caller did not declare freeAttempted (owner rule: free first, paid only when free is out or too slow)",
		);
		this.name = "PaidWhileFreeAvailableError";
	}
}

export function getPaidGeminiKey(use: PaidGeminiUse): string | undefined {
	authorizePaidGeminiUse(use);
	return serverEnv().GEMINI_API_KEY;
}

/** Existence check for gating/availability UI — never hands out the value. */
export function hasPaidGeminiKey(): boolean {
	return Boolean(serverEnv().GEMINI_API_KEY);
}

/** The server's "paid" key is literally the free-project key — a call on it is free quota, not spend. */
export function isServerPaidGeminiKeyFree(): boolean {
	const env = serverEnv();
	return Boolean(env.GEMINI_API_KEY) && env.GEMINI_API_KEY === env.GEMINI_API_KEY_FREE;
}
