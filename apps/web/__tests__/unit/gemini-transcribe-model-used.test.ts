import { afterEach, describe, expect, it, vi } from "vitest";
import { transcribeWithGemini } from "@/lib/gemini-transcribe";

// A2 — transcribeWithGemini can fall back through GEMINI_TRANSCRIBE_MODELS on
// overload (gemini-3-flash-preview -> gemini-2.5-flash -> gemini-flash-latest),
// but the result previously carried no record of WHICH model actually produced
// it, so withCostGuard priced/recorded the hardcoded primary-model literal even
// when a cheaper/different fallback model did the work. This verifies the fix:
// `modelUsed` reflects the model that actually succeeded, not the one requested.

const UPLOAD_URL = "https://upload.example/session";

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>) {
	return new Response(JSON.stringify(body), { status, headers });
}

describe("transcribeWithGemini — modelUsed reflects the model that actually ran (A2)", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("reports the fallback model when the primary model is overloaded", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";

			if (url === "https://audio.example/file.mp3") {
				return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
			}
			if (url.includes("/upload/v1beta/files") && method === "POST") {
				return jsonResponse({}, 200, { "x-goog-upload-url": UPLOAD_URL });
			}
			if (url === UPLOAD_URL && method === "PUT") {
				return jsonResponse({
					file: { name: "files/abc", uri: "https://files.example/abc", state: "ACTIVE" },
				});
			}
			if (url.includes(":generateContent")) {
				if (url.includes("gemini-3-flash-preview")) {
					// Primary model overloaded — transient, should fall back.
					return jsonResponse({ error: { message: "model is overloaded" } }, 503);
				}
				if (url.includes("gemini-2.5-flash")) {
					return jsonResponse({
						candidates: [
							{
								content: { parts: [{ text: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhello\n\n" }] },
								finishReason: "STOP",
							},
						],
						usageMetadata: {
							promptTokenCount: 10,
							candidatesTokenCount: 5,
							promptTokensDetails: [{ modality: "AUDIO", tokenCount: 8 }],
						},
					});
				}
			}
			if (method === "DELETE") {
				return new Response(null, { status: 200 });
			}
			throw new Error(`Unexpected fetch in test: ${method} ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await transcribeWithGemini("https://audio.example/file.mp3", {
			apiKey: "test-key",
			audioDurationSec: 5,
			maxAttempts: 1,
		});

		expect(result.modelUsed).toBe("gemini-2.5-flash");
		expect(result.transcriptVtt).toContain("hello");
	});

	it("reports the primary model when it succeeds on the first try", async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";

			if (url === "https://audio.example/file2.mp3") {
				return new Response(new Uint8Array([1, 2, 3]).buffer, { status: 200 });
			}
			if (url.includes("/upload/v1beta/files") && method === "POST") {
				return jsonResponse({}, 200, { "x-goog-upload-url": UPLOAD_URL });
			}
			if (url === UPLOAD_URL && method === "PUT") {
				return jsonResponse({
					file: { name: "files/xyz", uri: "https://files.example/xyz", state: "ACTIVE" },
				});
			}
			if (url.includes(":generateContent") && url.includes("gemini-3-flash-preview")) {
				return jsonResponse({
					candidates: [
						{
							content: { parts: [{ text: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nhi\n\n" }] },
							finishReason: "STOP",
						},
					],
					usageMetadata: {
						promptTokenCount: 10,
						candidatesTokenCount: 5,
						promptTokensDetails: [{ modality: "AUDIO", tokenCount: 8 }],
					},
				});
			}
			if (method === "DELETE") {
				return new Response(null, { status: 200 });
			}
			throw new Error(`Unexpected fetch in test: ${method} ${url}`);
		});
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await transcribeWithGemini("https://audio.example/file2.mp3", {
			apiKey: "test-key",
			audioDurationSec: 5,
			maxAttempts: 1,
		});

		expect(result.modelUsed).toBe("gemini-3-flash-preview");
	});
});
