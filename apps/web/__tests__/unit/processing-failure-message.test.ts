import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Round-20 #1: the DB stores allowlist TOKENS ("Upload interrupted",
// "Upload stalled", "Processing stalled") for ops and retry classification —
// but a share-page viewer must NEVER see a token raw. Rendering
// `errorMessage || t(...)` showed bare untranslated English for the most
// common failure class while only the rare unknown case got the localized,
// actionable sentence. The mapper below is the single translation point:
// known token -> its localized key; anything else -> the localized fallback.
import { processingFailureMessageKey } from "@/app/s/[videoId]/_components/processing-failure-message";

const read = (rel: string) =>
	readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("processingFailureMessageKey — tokens are detail, the viewer gets localized copy", () => {
	it("maps each known token to its own localized key", () => {
		expect(processingFailureMessageKey("Upload interrupted", false)).toBe(
			"progressUploadInterrupted",
		);
		expect(processingFailureMessageKey("Upload stalled", false)).toBe(
			"progressUploadStalledError",
		);
		expect(processingFailureMessageKey("Processing stalled", false)).toBe(
			"progressProcessingStalled",
		);
	});

	it("NEVER passes an unknown stored value through: ops tokens and legacy raw text fall back to the localized sentence", () => {
		for (const stored of [
			"Mux failed: 503",
			"fetch failed",
			"legacy raw error text",
		]) {
			expect(processingFailureMessageKey(stored, false)).toBe(
				"progressProcessingFailedOwner",
			);
			expect(processingFailureMessageKey(stored, true)).toBe(
				"progressProcessingFailed",
			);
		}
	});

	it("empty/null keeps the existing fallback behaviour", () => {
		expect(processingFailureMessageKey("", false)).toBe(
			"progressProcessingFailedOwner",
		);
		expect(processingFailureMessageKey(null, true)).toBe(
			"progressProcessingFailed",
		);
	});

	it("every key the mapper can return exists in ALL THREE locales", () => {
		const keys = [
			"progressUploadInterrupted",
			"progressUploadStalledError",
			"progressProcessingStalled",
			"progressProcessingFailed",
			"progressProcessingFailedOwner",
		];
		for (const locale of ["uz", "ru", "en"]) {
			const messages = JSON.parse(read(`../../messages/${locale}.json`)) as {
				share: Record<string, string>;
			};
			for (const key of keys) {
				expect(messages.share[key], `${locale}:${key}`).toBeTruthy();
			}
		}
	});
});

describe("render + sweep pins", () => {
	it("ProgressCircle renders through the mapper — never `errorMessage || ...` raw", () => {
		const src = read("../../app/s/[videoId]/_components/ProgressCircle.tsx");
		expect(src).toMatch(/processingFailureMessageKey\(/);
		expect(src).not.toMatch(/errorMessage \|\|/);
	});

	it("the reconcile sweep derives stage and token from the row's ACTUAL phase and preserves accurate stage text (round-20 #2)", () => {
		const src = read("../../app/api/cron/reconcile-storage/route.ts");
		// Two distinct tokens, chosen per phase group — not one blind label.
		expect(src).toMatch(/Upload stalled/);
		expect(src).toMatch(/Processing stalled/);
		// The true stage text already on the row must survive (COALESCE fill,
		// not overwrite).
		expect(src).toMatch(/COALESCE\(/);
	});
});
