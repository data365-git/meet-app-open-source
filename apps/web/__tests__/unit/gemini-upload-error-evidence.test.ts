import { afterEach, describe, expect, it, vi } from "vitest";

// Round-15 #1 (ship-blocker): with a revoked free key, the FIRST answer of
// every transcription job comes from the Files API upload init — NOT from
// generateContent — so the thrown message must carry the response BODY.
// `Gemini upload init failed (HTTP 400)` alone hides the API_KEY_INVALID
// evidence from the broken-key classifier, and the job dies as a gap-only
// transcript with the paid key never touched. This pin sits at the REAL
// boundary (mocked fetch, real transcribeWithGemini) precisely because the
// workflow-level pins mock transcribeWithGemini and can only assert strings
// the tests themselves authored.

import { isBrokenFreeKeyError } from "@/lib/free-tier-health";
import { transcribeWithGemini } from "@/lib/gemini-transcribe";

const INVALID_KEY_BODY = JSON.stringify({
	error: {
		code: 400,
		message: "API key not valid. Please pass a valid API key.",
		status: "INVALID_ARGUMENT",
		details: [
			{
				"@type": "type.googleapis.com/google.rpc.ErrorInfo",
				reason: "API_KEY_INVALID",
				domain: "googleapis.com",
			},
		],
	},
});

describe("upload-leg errors carry the response body as evidence", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("a revoked key at upload INIT throws a message the broken-key classifier recognizes", async () => {
		const fetchMock = vi
			.fn()
			// 1st fetch: the audio download succeeds.
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				arrayBuffer: async () => new ArrayBuffer(8),
			})
			// 2nd fetch: the Files API upload init answers Google's REAL
			// invalid-key shape — HTTP 400 with the evidence in the body.
			.mockResolvedValue({
				ok: false,
				status: 400,
				text: async () => INVALID_KEY_BODY,
				headers: { get: () => null },
			});
		vi.stubGlobal("fetch", fetchMock);

		const err = await transcribeWithGemini("https://a/x.mp3", {
			apiKey: "revoked-free-key",
			maxAttempts: 1,
		}).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		const message = (err as Error).message;
		// Prefix preserved for anything that greps on it…
		expect(message).toContain("Gemini upload init failed (HTTP 400)");
		// …and the body evidence is now in the message…
		expect(message).toContain("API_KEY_INVALID");
		// …so the classifier sees a genuinely broken key without widening.
		expect(isBrokenFreeKeyError(err)).toBe(true);
	});

	it("a NON-auth 400 at upload init stays unclassified — the body is the discriminator", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				arrayBuffer: async () => new ArrayBuffer(8),
			})
			.mockResolvedValue({
				ok: false,
				status: 400,
				text: async () => '{"error":{"message":"Request contains an invalid argument.","status":"INVALID_ARGUMENT"}}',
				headers: { get: () => null },
			});
		vi.stubGlobal("fetch", fetchMock);

		const err = await transcribeWithGemini("https://a/x.mp3", {
			apiKey: "free-key",
			maxAttempts: 1,
		}).catch((e) => e);

		expect(err).toBeInstanceOf(Error);
		expect((err as Error).message).toContain("Gemini upload init failed (HTTP 400)");
		expect(isBrokenFreeKeyError(err)).toBe(false);
	});
});
