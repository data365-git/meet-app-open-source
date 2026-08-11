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
export type PaidGeminiUse = {
	operation:
		| "transcription"
		| "generation"
		| "translation"
		| "chat"
		/** The owner's explicit "continue on paid" click — his money, his call. */
		| "owner-continue-paid"
		/** Operator-run verification/maintenance scripts (never a request path). */
		| "ops-script";
	mode: AiSpeedMode;
	route: "sync" | "batch";
	/** REQUIRED TRUE for cheap synchronous calls: the free chain has actually
	 * been tried and exhausted (or no free key exists) for this call. */
	freeExhausted?: boolean;
};

export class CheapPaidWhileFreeAvailableError extends Error {
	constructor() {
		super(
			"INVARIANT VIOLATION: a cheap job must not call a paid Gemini API while free quota is available — the caller did not declare freeExhausted (owner rule 2026-08-11: free first, paid only when free is out)",
		);
		this.name = "CheapPaidWhileFreeAvailableError";
	}
}

export function getPaidGeminiKey(use: PaidGeminiUse): string | undefined {
	if (use.mode === "cheap" && use.route === "sync" && use.freeExhausted !== true) {
		throw new CheapPaidWhileFreeAvailableError();
	}
	return serverEnv().GEMINI_API_KEY;
}

/** Existence check for gating/availability UI — never hands out the value. */
export function hasPaidGeminiKey(): boolean {
	return Boolean(serverEnv().GEMINI_API_KEY);
}
