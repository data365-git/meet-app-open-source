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

	it("a WRAPPED message (the real TranscriptionQuotaFailureError shape) still loses the body (round-17 #1)", () => {
		// The exact composition at workflows/transcribe.ts: the wrapper adds a
		// colon, which the old anchored regex could not cross — ~95 chars of
		// Google's JSON body then reached a PUBLIC share page's RSC payload.
		const raw =
			'Transcription quota/credits exhausted for vid-123: Gemini generateContent failed (HTTP 429): {"error":{"code":429,"message":"Quota exceeded for quota metric generate_content_free_tier_requests","status":"RESOURCE_EXHAUSTED","details":[{"reason":"RATE_LIMIT_EXCEEDED","metadata":{"consumer":"projects/763029500123"}}]}}';
		const out = sanitizeAiErrorMessageForUi(raw);
		expect(out).toBe(
			"Transcription quota/credits exhausted for vid-123: Gemini generateContent failed (HTTP 429)",
		);
		expect(out).not.toContain("{");
		expect(out).not.toContain("763029500123");
	});

	it("the no-HTTP fallback also stops at a body brace", () => {
		const out = sanitizeAiErrorMessageForUi(
			'Gemini upload response missing file info: {"file":null,"internal":"detail"}',
		);
		expect(out).not.toContain("{");
		expect(out).toContain("missing file info");
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
