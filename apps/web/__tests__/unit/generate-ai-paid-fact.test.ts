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
const TRANSCRIBE_LIB = read("../../lib/transcribe.ts");

describe("round-10 #1 — generation freeAttempted is a classified fact", () => {
	it("callAiApi passes the computed fact, never the literal", () => {
		expect(GEN_WORKFLOW).toContain("freeAttempted,");
		expect(GEN_WORKFLOW).not.toContain("freeAttempted: true");
	});

	it("transcription passes the computed fact too — no literal at its paid call site (round-11 #3)", () => {
		expect(TRANSCRIBE_WORKFLOW).toContain("freeAttempted,");
		expect(TRANSCRIBE_WORKFLOW).not.toContain("freeAttempted: true");
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

describe("round-13 #2 — the broken-key verdict is per-job, reset at every job start", () => {
	it("both phase launchers clear the verdict so a Retry after a fixed key starts on free", () => {
		expect(TRANSCRIBE_LIB).toContain("clearFreeTierVerdict(");
		expect(GEN_LIB).toContain("clearFreeTierVerdict(");
	});

	it("the streak counter is DELETED, not tuned — one conclusive auth failure marks the job", () => {
		const HEALTH = read("../../lib/free-tier-health.ts");
		expect(HEALTH).not.toMatch(/MAX_CONSECUTIVE|Map</);
		expect(HEALTH).toContain("markFreeKeyBrokenForJob");
	});
});

describe("round-12 #3 — generation liveness is a heartbeat, not the start time", () => {
	it("the generation workflow runs the shared job heartbeat", () => {
		expect(GEN_WORKFLOW).toContain("startAiJobHeartbeat(");
	});

	it("BOTH generation claims stamp aiProgressAt, so a stale transcription stamp cannot mark a fresh generation stale (round-13 #1)", () => {
		expect(GEN_LIB).toContain("aiProgressAt");
		expect(GEN_WORKFLOW).toMatch(/aiProcessingStartedAt: now,[\s\S]{0,600}aiProgressAt: now,|aiProgressAt: now,[\s\S]{0,600}aiProcessingStartedAt: now,/);
	});

	it("the cron judges generation staleness by time since last PROGRESS", () => {
		expect(CRON).toMatch(
			/IN \('PROCESSING', 'QUEUED'\)`,[\s\S]{0,900}\$\.aiProgressAt/,
		);
	});
});

describe("round-16 #2 — the DB error field is sanitized; the body stays in the log", () => {
	it("markError persists sanitizeAiErrorMessageForUi(...), never the raw message", () => {
		expect(TRANSCRIBE_WORKFLOW).toMatch(
			/message: sanitizeAiErrorMessageForUi\(/,
		);
		expect(TRANSCRIBE_WORKFLOW).not.toMatch(
			/message: reason\.message\.slice/,
		);
	});

	it("the SIBLING persist site — aiGenerationError — is sanitized too (round-17 #2)", () => {
		expect(GEN_LIB).toMatch(
			/aiGenerationError: sanitizeAiErrorMessageForUi\(/,
		);
		expect(GEN_LIB).not.toMatch(/aiGenerationError:\s+err instanceof Error/);
	});
});

describe("round-10 #4 — a partial completion is visible", () => {
	it("completing with failed chunks fires an ops alert", () => {
		expect(TRANSCRIBE_WORKFLOW).toMatch(
			/failedChunkCount > 0\)[\s\S]{0,900}sendOpsAlert\(/,
		);
	});
});

describe("free-key alias — a paid Gemini leg on the free project records $0 on BOTH legs", () => {
	it("transcription's runPaidSync declares free from the alias check", () => {
		expect(TRANSCRIBE_WORKFLOW).toContain(
			"free: !ownerApiKey && isServerPaidGeminiKeyFree()",
		);
	});

	it("generation's callAiApiWithModel call declares free from the alias check", () => {
		expect(GEN_WORKFLOW).toContain("free: isServerPaidGeminiKeyFree()");
	});

	it("translation and chat — the other two server-Gemini legs — declare it too", () => {
		const TRANSLATE_LIB = read("../../lib/translate-ai.ts");
		const CHAT_ROUTE = read("../../app/api/video/ai/chat/route.ts");
		expect(TRANSLATE_LIB).toContain("free: isServerPaidGeminiKeyFree()");
		expect(CHAT_ROUTE).toMatch(
			/free:\s*!chatOpenRouterKey &&\s*!owner\?\.geminiApiKey &&\s*isServerPaidGeminiKeyFree\(\)/,
		);
	});
});
