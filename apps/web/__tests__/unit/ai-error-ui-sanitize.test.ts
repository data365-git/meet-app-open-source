import { describe, expect, it } from "vitest";

// Round-16 #2: Google's raw response body is appended to thrown messages for
// the CLASSIFIER's benefit, but what markError persists reaches every share
// page viewer (public links included) via the RSC payload. The full body
// belongs in the server LOG; the DATABASE field gets a short sanitized
// reason.
import { sanitizeAiErrorMessageForUi } from "@/lib/ai-error-message";

describe("sanitizeAiErrorMessageForUi", () => {
	it("keeps the stable prefix and drops the appended upstream body", () => {
		const raw =
			'Gemini upload init failed (HTTP 400): {"error":{"message":"API key not valid","details":[{"reason":"API_KEY_INVALID","project":"763029500123","service":"generativelanguage.googleapis.com"}]}}';
		const out = sanitizeAiErrorMessageForUi(raw);
		expect(out).toBe("Gemini upload init failed (HTTP 400)");
		expect(out).not.toContain("{");
		expect(out).not.toContain("763029500123");
	});

	it("keeps a generateContent failure's prefix without the body", () => {
		const raw =
			"Gemini generateContent failed (HTTP 403): Permission denied on project 763029500123 by service generativelanguage.googleapis.com";
		expect(sanitizeAiErrorMessageForUi(raw)).toBe(
			"Gemini generateContent failed (HTTP 403)",
		);
	});

	it("falls back to a bounded first line for messages without an HTTP prefix", () => {
		expect(sanitizeAiErrorMessageForUi("empty transcript from Gemini")).toBe(
			"empty transcript from Gemini",
		);
		const long = "x".repeat(500) + "\nsecond line";
		const out = sanitizeAiErrorMessageForUi(long);
		expect(out.length).toBeLessThanOrEqual(200);
		expect(out).not.toContain("second line");
	});
});
