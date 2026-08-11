import { serverEnv } from "@cap/env";
import type { AiSpeedMode } from "@/lib/ai-speed-mode";

/**
 * THE single owner of the PAID Gemini credential on the AI path.
 *
 * The boundary is the structural fix (judge, 2026-08-11): with the key
 * ambiently in scope, every error path's default was a paid call. Every use
 * must name WHAT it is — operation, mode AND route, no unchecked escape
 * hatch — and a source-scan test fails the build if any AI-path file reads
 * the env var directly.
 *
 * THE INVARIANT, corrected in round 8 to the owner's ACTUAL rule ("imkon
 * qadar bepuldan foydalanadi, u tugasa qaytguncha pullikdan foydalanadi"):
 * a cheap job never calls a paid API WHILE FREE QUOTA IS AVAILABLE. Paying —
 * on whatever the cheapest available route is — once free is exhausted is
 * the REQUESTED behaviour, not a defect. So a cheap synchronous paid call
 * must declare `freeExhausted: true`, meaning the free chain was actually
 * tried (or does not exist) for THIS call. The earlier absolute form
 * ("cheap never bills full price") was the coordinator's extrapolation, not
 * the owner's rule, and drove seven rounds of park/collector complexity.
 */
export type PaidGeminiUse =
	/** Job-bound operations: the mode MUST be derived from the job's own
	 * resolved aiSpeedMode, never invented at the call site. */
	| {
			operation: "transcription" | "generation";
			mode: AiSpeedMode;
			route: "sync" | "batch";
			/** REQUIRED TRUE for cheap synchronous calls, and it must be a FACT:
			 * only a genuine quota/rate-limit signal from the free chain (or the
			 * absence of any free key) counts as exhaustion. A broken key, a
			 * safety block or a malformed response is a real ERROR, not
			 * exhaustion — billing paid on those is the owner's original defect
			 * in a new shape (round-9 #1). */
			freeExhausted?: boolean;
	  }
	/** Job-less operations: there is no cheap notion here, so there is no
	 * mode field to falsify — the round-8 shape let these self-declare
	 * mode:"fast", the exact value that disables the check (round-9 #3). */
	| {
			operation:
				| "translation"
				| "chat"
				/** The owner's explicit "continue on paid" click — his money, his
				 * call; the click itself is the authorization. */
				| "owner-continue-paid"
				/** Operator-run verification/maintenance scripts (never a request
				 * path). */
				| "ops-script";
			route: "sync" | "batch";
	  };

/** The authorization check, separated from the key handout so call sites
 * that resolve their key elsewhere (the video owner's personal key) still
 * MUST pass the same gate — round 9 #1 closed the `ownerApiKey ?? gate`
 * short-circuit that skipped the check entirely. */
export function authorizePaidGeminiUse(use: PaidGeminiUse): void {
	if (
		"mode" in use &&
		use.mode === "cheap" &&
		use.route === "sync" &&
		use.freeExhausted !== true
	) {
		throw new CheapPaidWhileFreeAvailableError();
	}
}

export class CheapPaidWhileFreeAvailableError extends Error {
	constructor() {
		super(
			"INVARIANT VIOLATION: a cheap job must not call a paid Gemini API while free quota is available — the caller did not declare freeExhausted (owner rule 2026-08-11: free first, paid only when free is out)",
		);
		this.name = "CheapPaidWhileFreeAvailableError";
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
