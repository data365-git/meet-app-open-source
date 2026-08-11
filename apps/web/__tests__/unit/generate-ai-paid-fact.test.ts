/**
 * Round-10 pins for the GENERATION phase — the copy-pasted twin the round-9
 * blast-radius sweep missed.
 *
 *  #1 freeExhausted must be the classified FACT in callAiApi too, never a
 *     hardcoded literal: a revoked free key / permission error / unparseable
 *     free response is a REAL error and must surface — not silently bill
 *     summary/chapters/title on the paid API with free daily quota intact.
 *  #2 No automatic paid flip remains anywhere: cheap generation pays INLINE
 *     when its free chain is genuinely exhausted (same shape as
 *     transcription), so nothing parks and the park writer is gone.
 *  #3 The generation recovery budget is refunded on fresh starts and on
 *     success, and cron re-kicks mark themselves isRetry.
 *  #4 A partial transcription completion is VISIBLE (ops alert), not silent.
 *
 * Source-shape pins (same technique as transcribe-substep-honesty.test.ts):
 * each fails against the pre-round-10 tree.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const GEN_WORKFLOW = read("../../workflows/generate-ai.ts");
const GEN_LIB = read("../../lib/generate-ai.ts");
const CRON = read("../../app/api/cron/recover-stale-ai-jobs/route.ts");
const HELPERS = read(
	"../../app/api/cron/recover-stale-ai-jobs/stale-job-helpers.ts",
);
const TRANSCRIBE_WORKFLOW = read("../../workflows/transcribe.ts");

describe("round-10 #1 — generation freeExhausted is a classified fact", () => {
	it("callAiApi passes the computed fact, never the literal", () => {
		expect(GEN_WORKFLOW).toContain("freeExhausted: freeQuotaExhausted");
		expect(GEN_WORKFLOW).not.toContain("freeExhausted: true");
	});

	it("a NON-quota free failure surfaces instead of falling through to paid", () => {
		// The rethrow of the first non-quota free error, keyed on the classifier.
		expect(GEN_WORKFLOW).toMatch(
			/freeErrors\.find\(\(e\) => !isQuotaLikeAiError\(e\)\)/,
		);
	});
});

describe("round-10 #2 — nothing parks, no flip anywhere", () => {
	it("generation no longer produces AiQuotaWaitError and the park writer is gone", () => {
		expect(GEN_WORKFLOW).not.toContain("new AiQuotaWaitError(");
		expect(GEN_LIB).not.toContain("aiQuotaWaiting: true");
	});

	it("the 4h flip helper and both cron flip branches are deleted", () => {
		expect(HELPERS).not.toContain("shouldAutoFlipCheapJobToPaid");
		expect(CRON).not.toContain("shouldAutoFlipCheapJobToPaid");
		expect(CRON).not.toContain("continueAiJobOnPaid");
	});
});

describe("round-10 #3 — the generation recovery budget is refundable", () => {
	it("a fresh owner start refunds autoRecoverAttempts; a cron retry does not", () => {
		expect(GEN_LIB).toMatch(
			/opts\?\.isRetry \? \{\} : \{ autoRecoverAttempts: undefined \}/,
		);
		// The cron's generation re-kick marks itself as a retry.
		expect(CRON).toMatch(/startAiGeneration\([\s\S]{0,120}isRetry: true/);
	});

	it("a successful generation clears the budget", () => {
		expect(GEN_WORKFLOW).toMatch(
			/finalUsable \? \{ autoRecoverAttempts: undefined \} : \{\}/,
		);
	});
});

describe("round-10 #4 — a partial completion is visible", () => {
	it("completing with failed chunks fires an ops alert", () => {
		expect(TRANSCRIBE_WORKFLOW).toMatch(
			/failedChunkCount > 0\)[\s\S]{0,900}sendOpsAlert\(/,
		);
	});
});
