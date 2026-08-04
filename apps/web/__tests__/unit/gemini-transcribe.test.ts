import { afterEach, describe, expect, it, vi } from "vitest";
import {
	TRANSCRIPTION_INSTRUCTION_PREFIX,
	buildTranscriptionParts,
	transcribeWithGemini,
} from "@/lib/gemini-transcribe";

// S3.1 — the Files API audio upload must happen exactly ONCE per
// transcribeWithGemini call, no matter how many times anything downstream is
// retried. Before the hoist, the multi-MB byte transfer sat inside a retried
// closure, so a transient Gemini error re-sent the whole chunk's audio up to
// `maxAttempts` (5) times. These tests pin the byte transfer at one.

const UPLOAD_URL = "https://upload.example/session";
const AUDIO_URL = "https://audio.example/chunk.mp3";
const AUDIO_BYTES = new Uint8Array(4096).fill(7);

function jsonResponse(
	body: unknown,
	status = 200,
	headers?: Record<string, string>,
) {
	return new Response(JSON.stringify(body), { status, headers });
}

const FILE_BODY = {
	file: {
		name: "files/abc",
		uri: "https://files.example/abc",
		state: "ACTIVE",
	},
};

function transcriptResponse() {
	return jsonResponse({
		candidates: [
			{
				content: {
					parts: [
						{
							text: "WEBVTT\n\n1\n00:00:00.000 --> 00:00:01.000\nsalom\n\n",
						},
					],
				},
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

/** How many bytes an intercepted request body carries. */
function bodyByteLength(init?: RequestInit): number {
	const body = init?.body;
	if (!body) return 0;
	if (body instanceof Uint8Array) return body.byteLength;
	if (body instanceof ArrayBuffer) return body.byteLength;
	return String(body).length;
}

describe("transcribeWithGemini — the audio upload is hoisted out of the retried closure (S3.1)", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("uploads the audio exactly once even when generateContent is retried N times", async () => {
		let generateCalls = 0;
		const uploads: number[] = [];

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";

				if (url === AUDIO_URL) {
					return new Response(AUDIO_BYTES.buffer.slice(0), { status: 200 });
				}
				if (url.includes("/upload/v1beta/files") && method === "POST") {
					return jsonResponse({}, 200, { "x-goog-upload-url": UPLOAD_URL });
				}
				if (url === UPLOAD_URL && method === "PUT") {
					uploads.push(bodyByteLength(init));
					return jsonResponse(FILE_BODY);
				}
				if (url.includes(":generateContent")) {
					generateCalls++;
					// Two transient failures, then success — the retry loop runs 3x.
					if (generateCalls <= 2) {
						return jsonResponse({ error: { message: "model is overloaded" } }, 503);
					}
					return transcriptResponse();
				}
				if (method === "DELETE") return new Response(null, { status: 200 });
				throw new Error(`Unexpected fetch in test: ${method} ${url}`);
			},
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await transcribeWithGemini(AUDIO_URL, {
			apiKey: "test-key",
			audioDurationSec: 5,
			maxAttempts: 3,
		});

		expect(generateCalls).toBe(3);
		expect(uploads).toHaveLength(1);
		expect(uploads[0]).toBe(AUDIO_BYTES.byteLength);
		expect(result.transcriptVtt).toContain("salom");
	}, 20_000);

	it("does not re-send the audio when the upload fails transiently after the server already has it", async () => {
		const uploads: number[] = [];
		let queries = 0;
		let putAttempts = 0;

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				const headers = (init?.headers ?? {}) as Record<string, string>;

				if (url === AUDIO_URL) {
					return new Response(AUDIO_BYTES.buffer.slice(0), { status: 200 });
				}
				if (url.includes("/upload/v1beta/files") && method === "POST") {
					return jsonResponse({}, 200, { "x-goog-upload-url": UPLOAD_URL });
				}
				if (url === UPLOAD_URL && headers["X-Goog-Upload-Command"] === "query") {
					queries++;
					// The bytes DID land before the connection blew up — the session is
					// already finalized, so there is nothing left to send.
					return jsonResponse(FILE_BODY, 200, {
						"x-goog-upload-status": "final",
					});
				}
				if (url === UPLOAD_URL && method === "PUT") {
					putAttempts++;
					uploads.push(bodyByteLength(init));
					// First (and only) real transfer: server received everything, then
					// the response failed transiently.
					return jsonResponse({ error: { message: "unavailable" } }, 503);
				}
				if (url.includes(":generateContent")) return transcriptResponse();
				if (method === "DELETE") return new Response(null, { status: 200 });
				throw new Error(`Unexpected fetch in test: ${method} ${url}`);
			},
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await transcribeWithGemini(AUDIO_URL, {
			apiKey: "test-key",
			audioDurationSec: 5,
			maxAttempts: 3,
		});

		expect(queries).toBeGreaterThanOrEqual(1);
		expect(putAttempts).toBe(1);
		expect(uploads).toEqual([AUDIO_BYTES.byteLength]);
		expect(result.transcriptVtt).toContain("salom");
	}, 20_000);

	it("resumes from the byte offset the server already received instead of re-uploading the whole file", async () => {
		const RECEIVED = 3000;
		const uploads: Array<{ offset: string; bytes: number }> = [];

		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = String(input);
				const method = init?.method ?? "GET";
				const headers = (init?.headers ?? {}) as Record<string, string>;

				if (url === AUDIO_URL) {
					return new Response(AUDIO_BYTES.buffer.slice(0), { status: 200 });
				}
				if (url.includes("/upload/v1beta/files") && method === "POST") {
					return jsonResponse({}, 200, { "x-goog-upload-url": UPLOAD_URL });
				}
				if (url === UPLOAD_URL && headers["X-Goog-Upload-Command"] === "query") {
					return new Response(null, {
						status: 200,
						headers: {
							"x-goog-upload-status": "active",
							"x-goog-upload-size-received": String(RECEIVED),
						},
					});
				}
				if (url === UPLOAD_URL && method === "PUT") {
					uploads.push({
						offset: headers["X-Goog-Upload-Offset"] ?? "",
						bytes: bodyByteLength(init),
					});
					if (uploads.length === 1) {
						return jsonResponse({ error: { message: "unavailable" } }, 503);
					}
					return jsonResponse(FILE_BODY);
				}
				if (url.includes(":generateContent")) return transcriptResponse();
				if (method === "DELETE") return new Response(null, { status: 200 });
				throw new Error(`Unexpected fetch in test: ${method} ${url}`);
			},
		);
		global.fetch = fetchMock as unknown as typeof fetch;

		const result = await transcribeWithGemini(AUDIO_URL, {
			apiKey: "test-key",
			audioDurationSec: 5,
			maxAttempts: 3,
		});

		expect(uploads).toHaveLength(2);
		expect(uploads[0]).toEqual({ offset: "0", bytes: AUDIO_BYTES.byteLength });
		// The retry sends ONLY the tail, not the whole file again.
		expect(uploads[1]).toEqual({
			offset: String(RECEIVED),
			bytes: AUDIO_BYTES.byteLength - RECEIVED,
		});
		const totalSent = uploads.reduce((n, u) => n + u.bytes, 0);
		expect(totalSent).toBeLessThan(AUDIO_BYTES.byteLength * 2);
		expect(result.transcriptVtt).toContain("salom");
	}, 20_000);
});

// ── Cacheable prompt prefix ────────────────────────────────────────────────
//
// Gemini's implicit context cache only hits when the START of the request is
// byte-identical to a previous one. A 60-minute recording is ~20 chunks that all
// re-send the same ~700-word instruction block, so the block must be the PREFIX
// (parts[0]) and everything variable — the audio fileData and the per-chunk
// speaker roster — must come after it. These tests pin the ordering and the
// byte-identity of that prefix across two different chunks of one recording.

/** Capture the `parts` array that transcribeWithGemini actually puts on the wire
 * for one chunk, given that chunk's uploaded fileUri and speaker roster. */
async function capturePartsForChunk(opts: {
	fileUri: string;
	knownSpeakers?: string[];
}): Promise<Array<Record<string, unknown>>> {
	let sentParts: Array<Record<string, unknown>> = [];

	const fetchMock = vi.fn(
		async (input: RequestInfo | URL, init?: RequestInit) => {
			const url = String(input);
			const method = init?.method ?? "GET";

			if (url === AUDIO_URL) {
				return new Response(AUDIO_BYTES.buffer.slice(0), { status: 200 });
			}
			if (url.includes("/upload/v1beta/files") && method === "POST") {
				return jsonResponse({}, 200, { "x-goog-upload-url": UPLOAD_URL });
			}
			if (url === UPLOAD_URL && method === "PUT") {
				return jsonResponse({
					file: {
						name: `files/${opts.fileUri.slice(-4)}`,
						uri: opts.fileUri,
						state: "ACTIVE",
					},
				});
			}
			if (url.includes(":generateContent")) {
				const body = JSON.parse(String(init?.body)) as {
					contents: Array<{ parts: Array<Record<string, unknown>> }>;
				};
				sentParts = body.contents[0]?.parts ?? [];
				return transcriptResponse();
			}
			if (method === "DELETE") return new Response(null, { status: 200 });
			throw new Error(`Unexpected fetch in test: ${method} ${url}`);
		},
	);
	global.fetch = fetchMock as unknown as typeof fetch;

	await transcribeWithGemini(AUDIO_URL, {
		apiKey: "test-key",
		audioDurationSec: 5,
		knownSpeakers: opts.knownSpeakers,
		maxAttempts: 1,
	});

	return sentParts;
}

describe("transcription prompt ordering — byte-identical prefix for implicit caching", () => {
	const originalFetch = global.fetch;

	afterEach(() => {
		global.fetch = originalFetch;
		vi.restoreAllMocks();
	});

	it("sends the fixed instruction text as parts[0] and the audio only after it", async () => {
		const parts = await capturePartsForChunk({
			fileUri: "https://files.example/chunk-1",
		});

		expect(parts[0]).toEqual({ text: TRANSCRIPTION_INSTRUCTION_PREFIX });
		expect(parts[1]).toMatchObject({
			fileData: { fileUri: "https://files.example/chunk-1" },
		});
		// The audio must never precede the cacheable instruction block.
		const fileDataIndex = parts.findIndex((p) => "fileData" in p);
		expect(fileDataIndex).toBe(1);
	}, 20_000);

	it("keeps parts[0].text byte-identical across two chunks with different fileUris and different knownSpeakers", async () => {
		const chunkA = await capturePartsForChunk({
			fileUri: "https://files.example/chunk-a",
		});
		const chunkB = await capturePartsForChunk({
			fileUri: "https://files.example/chunk-b",
			knownSpeakers: ["Zafarbek", "Мирослава"],
		});

		const prefixA = (chunkA[0] as { text: string }).text;
		const prefixB = (chunkB[0] as { text: string }).text;

		// Byte-identical, not merely "similar": compare the raw UTF-8 bytes so a
		// stray whitespace or interpolated value cannot slip through.
		const bytesA = new TextEncoder().encode(prefixA);
		const bytesB = new TextEncoder().encode(prefixB);
		expect(prefixA).toBe(prefixB);
		expect(Array.from(bytesA)).toEqual(Array.from(bytesB));
		expect(prefixA).toBe(TRANSCRIPTION_INSTRUCTION_PREFIX);

		// The roster is what differs — and it lands AFTER the audio, never in the
		// cacheable prefix.
		// NB: "Alisher" alone is a bad probe — it appears in the fixed prefix as a
		// voice-tag FORMAT example. The roster's own sentence is the real probe.
		expect(prefixA).not.toContain("Known speakers identified earlier");
		expect(prefixB).not.toContain("Known speakers identified earlier");
		expect(prefixB).not.toContain("Zafarbek");
		expect(prefixB).not.toContain("Мирослава");
		const rosterPart = chunkB[2] as { text: string } | undefined;
		expect(rosterPart?.text).toContain("Zafarbek");
		expect(rosterPart?.text).toContain("Мирослава");
		// Chunk A has no roster at all, so it sends only two parts.
		expect(chunkA).toHaveLength(2);
		expect(chunkB).toHaveLength(3);
	}, 20_000);

	it("buildTranscriptionParts is pure and orders instructions before audio", () => {
		const a = buildTranscriptionParts({
			mimeType: "audio/mpeg",
			fileUri: "uri-a",
		});
		const b = buildTranscriptionParts({
			mimeType: "audio/mp4",
			fileUri: "uri-b",
			knownSpeakers: ["Sarah"],
		});

		expect((a[0] as { text: string }).text).toBe(
			(b[0] as { text: string }).text,
		);
		expect(a[1]).toEqual({
			fileData: { mimeType: "audio/mpeg", fileUri: "uri-a" },
		});
		expect(b[1]).toEqual({
			fileData: { mimeType: "audio/mp4", fileUri: "uri-b" },
		});
		expect(a).toHaveLength(2);
		expect(b).toHaveLength(3);
	});
});
