import { describe, expect, it, vi } from "vitest";

// S3.3: the summary path must apply the SAME runaway-repetition guard the
// transcription path has, without turning a legitimate (repetitive-looking)
// JSON summary into a parse failure.

vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: vi.fn() }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@/lib/ai-cost-guard", () => ({
	BudgetExceededError: class BudgetExceededError extends Error {},
	withCostGuard: vi.fn(),
}));
vi.mock("@/lib/concurrency", () => ({
	AI_CHUNK_CONCURRENCY: 1,
	mapWithConcurrency: vi.fn(),
}));
vi.mock("@/lib/gemini-retry", () => ({ withGeminiRetry: vi.fn() }));
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
vi.mock("workflow", () => ({ FatalError: class FatalError extends Error {} }));
vi.mock("server-only", () => ({}));

import {
	BOUNDED_SUMMARY_MAX_OUTPUT_TOKENS,
	guardRunawaySummaryContent,
	SUMMARY_MAX_OUTPUT_TOKENS,
} from "@/workflows/generate-ai";

const RUNAWAY_LINE = "Rahmat, keyingi savolga o'tamiz.";

describe("guardRunawaySummaryContent", () => {
	it("truncates a repetition-loop runaway in a text (refine) response", () => {
		const clean = ["Birinchi fikr shu yerda.", "Ikkinchi fikr esa boshqa."];
		const loop = Array.from({ length: 40 }, () => RUNAWAY_LINE);
		const out = guardRunawaySummaryContent([...clean, ...loop].join("\n"), false);

		expect(out.runaway).toBe(true);
		expect(out.content.length).toBeLessThan([...clean, ...loop].join("\n").length);
		expect(out.content).toContain("Birinchi fikr shu yerda.");
		// The garbage tail is gone (at most the couple of kept context copies).
		expect(out.content.split(RUNAWAY_LINE).length - 1).toBeLessThanOrEqual(2);
	});

	it("leaves a healthy response untouched", () => {
		const text = "Yig'ilishda uch mavzu ko'rildi.\nBirinchisi narx edi.";
		const out = guardRunawaySummaryContent(text, false);
		expect(out).toEqual({ content: text, runaway: false });
	});

	it("never breaks a valid JSON summary that repeats scaffolding lines", () => {
		// Pretty-printed summary JSON legitimately repeats `"done": false,` once
		// per task — a blind line-repetition cut here would corrupt GOOD output.
		const tasks = Array.from({ length: 20 }, (_, i) => ({
			title: `Vazifa ${i + 1}`,
			assignee: "",
			priority: "medium",
			deadline: "",
			done: false,
			category: "Boshqa",
		}));
		const json = JSON.stringify({ title: "Yig'ilish", tasks }, null, 2);

		const out = guardRunawaySummaryContent(json, true);

		// Whatever the detector thought, the content handed back must still parse.
		expect(() => JSON.parse(out.content)).not.toThrow();
		expect(JSON.parse(out.content).tasks).toHaveLength(20);
	});

	it("keeps the bounded cap well below the default output cap", () => {
		expect(BOUNDED_SUMMARY_MAX_OUTPUT_TOKENS).toBeLessThan(
			SUMMARY_MAX_OUTPUT_TOKENS,
		);
		expect(SUMMARY_MAX_OUTPUT_TOKENS).toBe(65536);
	});
});
