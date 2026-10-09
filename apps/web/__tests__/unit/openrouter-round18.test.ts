/**
 * Round-18 pins. Each test below fails if its fix is reverted.
 *
 * #2 availability gate · #4 credit-exhaustion classification · #5 zero-cost
 * hole · #6 structured JSON output + graceful parse · #7 cost attribution.
 * (#1 and the withCostGuard half of #5 live with their own subjects, in
 * transcribe-gap-fill.test.ts and ai-cost-guard-model-used.test.ts.)
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// lib/translate-ai.ts is a server module; the pure helper under test needs none
// of that machinery, so the marker and the DB handle are stubbed out.
vi.mock("server-only", () => ({}));
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/database/schema", () => ({ videos: {} }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
	buildEnv: { NEXT_PUBLIC_WEB_URL: "http://localhost:3000" },
	clientEnv: {},
}));

import { isCreditExhaustedAiError, isQuotaLikeAiError } from "@/lib/ai-quota-wait";
import { markUnusableAiOutput } from "@/lib/free-tier-health";
import { buildOpenRouterBody, costUsdToMicros } from "@/lib/openrouter";
import { parseTranslationJson } from "@/lib/translate-ai";

const WEB_ROOT = join(__dirname, "..", "..");
const src = (relativePath: string) =>
	readFileSync(join(WEB_ROOT, relativePath), "utf8");

// ─── #2 — the availability gate twins must agree ─────────────────────────────
describe("#2 an OpenRouter key satisfies the AI availability gate on BOTH paths", () => {
	it("lib/transcribe.ts accepts an OpenRouter-only instance, exactly like its lib/generate-ai.ts twin", () => {
		// Behaviourally this gate sits behind a DB query and a decrypt; the
		// defect is the gate EXPRESSION itself, and the twin drifting apart is
		// what shipped it, so both twins are asserted together and identically.
		expect(src("lib/transcribe.ts")).toContain(
			"hasPaidGeminiKey() || hasOpenRouterKey()",
		);
		expect(src("lib/generate-ai.ts")).toContain(
			"hasPaidGeminiKey() || hasOpenRouterKey()",
		);
	});
});

// ─── #4 — OpenRouter's 402 is exhaustion, not a mystery failure ───────────────
describe("#4 credit exhaustion is classified", () => {
	it("HTTP 402 from OpenRouter reads as credit exhaustion AND as quota-like", () => {
		const err = new Error(
			"OpenRouter completion failed (HTTP 402): insufficient credits",
		);
		expect(isCreditExhaustedAiError(err)).toBe(true);
		expect(isQuotaLikeAiError(err)).toBe(true);
	});

	it("a credit message without the status still classifies", () => {
		expect(
			isCreditExhaustedAiError(new Error("Not enough credits on this account")),
		).toBe(true);
	});

	it("a BARE 402 is never evidence — a parse offset must not read as an empty wallet", () => {
		expect(
			isCreditExhaustedAiError(
				new Error("Unterminated string in JSON at position 402"),
			),
		).toBe(false);
	});

	it("an unusable-OUTPUT failure is excluded structurally, like every other classifier here", () => {
		expect(
			isCreditExhaustedAiError(
				markUnusableAiOutput(
					new Error('summary content is not valid JSON: "... HTTP 402 insufficient credits ..."'),
				),
			),
		).toBe(false);
	});

	it("ordinary quota classification is untouched", () => {
		expect(isQuotaLikeAiError(new Error("429 RESOURCE_EXHAUSTED"))).toBe(true);
		expect(isQuotaLikeAiError(new Error("HTTP 503 overloaded"))).toBe(false);
	});
});

// ─── #5 — a paid call reporting $0 must not record $0 ────────────────────────
describe("#5 an exact zero provider cost falls back to the pricing table", () => {
	it("costUsdToMicros(0) is undefined, so the caller prices from the table", () => {
		expect(costUsdToMicros(0)).toBeUndefined();
	});

	it("the surrounding cases are unchanged", () => {
		expect(costUsdToMicros(0.0000215)).toBe(22);
		expect(costUsdToMicros(undefined)).toBeUndefined();
		expect(costUsdToMicros(Number.NaN)).toBeUndefined();
		expect(costUsdToMicros(-1)).toBeUndefined();
	});
});

// ─── #6 — structured output on both OpenRouter JSON legs ─────────────────────
describe("#6 the OpenRouter JSON legs ask for JSON", () => {
	it("buildOpenRouterBody emits response_format only when asked", () => {
		const withJson = buildOpenRouterBody({
			messages: [{ role: "user", content: "x" }],
			maxTokens: 10,
			temperature: 0.2,
			responseFormat: "json_object",
		});
		expect(withJson.response_format).toEqual({ type: "json_object" });

		const withoutJson = buildOpenRouterBody({
			messages: [{ role: "user", content: "x" }],
			maxTokens: 10,
			temperature: 0.2,
		});
		expect(withoutJson).not.toHaveProperty("response_format");
	});

	it("the translate leg always asks for it; the summary leg asks whenever the prompt is a JSON prompt", () => {
		expect(src("lib/translate-ai.ts")).toMatch(
			/responseFormat: "json_object"/,
		);
		expect(src("workflows/generate-ai.ts")).toMatch(
			/json \? \{ responseFormat: "json_object" as const \} : \{\}/,
		);
	});

	it("a prose preamble fails with the module's OWN error, never a raw parser throw", () => {
		let thrown: unknown;
		try {
			parseTranslationJson(
				'Sure! Here is the translation:\n{"lines": ["a"]}',
				"batch translation",
			);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		const message = (thrown as Error).message;
		expect(message).toContain("[translate-ai]");
		expect(message).toContain("batch translation");
		// The model's own content never travels in the message: it reaches the
		// money classifiers, which read text like "HTTP 403" as evidence.
		expect(message).not.toContain("Sure!");
		expect(message).not.toMatch(/Unexpected token/);
	});

	it("valid JSON (fenced or bare) still parses", () => {
		expect(parseTranslationJson('```json\n{"a":1}\n```', "t")).toEqual({ a: 1 });
		expect(parseTranslationJson('{"a":1}', "t")).toEqual({ a: 1 });
	});

	it("no bare JSON.parse of a model reply is left in the translate module", () => {
		expect(src("lib/translate-ai.ts")).not.toMatch(
			/JSON\.parse\(cleanJsonResponse/,
		);
	});
});

// ─── #7 — the cost row names the leg that actually answered ──────────────────
describe("#7 chat spend is attributed to the provider that answered", () => {
	it("the recorded model comes from chatFetcher.provider(), not from key presence", () => {
		const route = src("app/api/video/ai/chat/route.ts");
		expect(route).toMatch(
			/chatModelUsed =\s*chatFetcher\.provider\(\) === "openrouter"/,
		);
		// Both return shapes (free-key answer and billed answer) carry it, or
		// withCostGuard falls back to the key-presence literal for one of them.
		expect(route.match(/modelUsed: chatModelUsed/g)?.length).toBe(2);
	});
});
