/**
 * Drives the REAL OpenRouter code path with a stubbed `fetch`.
 *
 * Why it is shaped like this: earlier pins in this area asserted strings that
 * the TEST itself authored, which is how ~1350 green tests coexisted with a
 * live hole. So every assertion below reads the bytes the production code
 * actually put on the wire, or the value it actually returned — nothing is
 * re-declared at the test boundary. The prompt assertion in particular
 * compares against the module the production path imports, so changing the
 * prompt in one place and not the other turns this red.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mock every heavy dependency workflows/transcribe.ts imports ──────────────
const ROW = vi.hoisted(() => ({ metadata: {} as Record<string, unknown> }));
vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => [{ metadata: ROW.metadata }] }),
			}),
		}),
	}),
}));
const ENV = vi.hoisted(() => ({
	value: {} as Record<string, string | undefined>,
}));
vi.mock("@cap/env", () => ({ serverEnv: () => ENV.value }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@cap/database/crypto", () => ({
	decrypt: vi.fn(async () => "decrypted-key"),
}));
vi.mock("@cap/utils", () => ({ userIsPro: vi.fn() }));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-storage", () => ({ getStorageAccessForVideo: vi.fn() }));
vi.mock("@/lib/ai-generation-request", () => ({
	shouldStartAiAfterTranscription: vi.fn(),
}));
vi.mock("@/lib/audio-enhance", () => ({
	ENHANCED_AUDIO_CONTENT_TYPE: "audio/wav",
	ENHANCED_AUDIO_EXTENSION: "wav",
	enhanceAudioFromUrl: vi.fn(),
}));
vi.mock("@/lib/audio-extract", () => ({
	checkHasAudioTrack: vi.fn(),
	extractAudioChunksFromUrl: vi.fn(),
	extractAudioFromUrl: vi.fn(),
	extractAudioSpanFromUrl: vi.fn(),
}));
vi.mock("@/lib/generate-ai", () => ({ startAiGeneration: vi.fn() }));
vi.mock("@/lib/transcription-settings", () => ({
	isTranscriptionDisabled: vi.fn(),
}));
vi.mock("@/lib/restore-russian-script", () => ({
	restoreRussianScript: (s: string) => s,
}));
vi.mock("server-only", () => ({}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {
		readonly _tag = "FatalError";
	},
}));

const H = vi.hoisted(() => ({
	withCostGuard: vi.fn(),
	transcribeWithGemini: vi.fn(),
	patchVideoMetadata: vi.fn(),
}));

vi.mock("@/lib/ai-cost-guard", () => ({
	withCostGuard: (opts: unknown) => H.withCostGuard(opts),
}));
vi.mock("@/lib/gemini-batch-transcribe", () => ({
	BatchFallbackError: class BatchFallbackError extends Error {},
	transcribeChunkWithBatch: vi.fn(),
	submitChunkBatch: vi.fn(),
}));
vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: (...args: unknown[]) => H.patchVideoMetadata(...args),
}));
// PARTIAL mock: only the Gemini transport is faked. Everything the OpenRouter
// path reuses — the prompt bytes, the runaway guard, normalizeToWebVtt, the
// output-token ceiling — stays REAL, which is the whole point of this file.
vi.mock("@/lib/gemini-transcribe", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/gemini-transcribe")>()),
	transcribeWithGemini: (url: string, opts: unknown) =>
		H.transcribeWithGemini(url, opts),
}));

import {
	buildTranscriptionPrompt,
	TRANSCRIBE_MAX_OUTPUT_TOKENS,
} from "@/lib/gemini-transcribe";
import {
	OPENROUTER_COMPLETIONS_URL,
	OPENROUTER_MODEL,
	OPENROUTER_USAGE_MODEL,
	redactOpenRouterKey,
	transcribeWithOpenRouter,
} from "@/lib/openrouter";
import { transcribeAudioChunks } from "@/workflows/transcribe";

const CTX = { userId: "u1", orgId: "o1", videoId: "v1" };
// Obviously not a credential: short, and says so. A real key value must never
// appear in code, fixtures or tests.
const KEY = "sk-or-v1-FAKE";

const VTT_REPLY = [
	"WEBVTT",
	"",
	"00:00:00.000 --> 00:00:04.000",
	"Spiker 1: Assalomu alaykum.",
	"",
	"00:00:04.000 --> 00:00:09.000",
	"Spiker 2: Va alaykum assalom.",
	"",
].join("\n");

type Call = { url: string; init: RequestInit };

function stubFetch(opts: {
	completion?: unknown;
	status?: number;
	rawBody?: string;
}): { calls: Call[] } {
	const calls: Call[] = [];
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string, init: RequestInit = {}) => {
			calls.push({ url: String(url), init });
			if (String(url).startsWith(OPENROUTER_COMPLETIONS_URL)) {
				const body =
					opts.rawBody ??
					JSON.stringify(
						opts.completion ?? {
							choices: [
								{ message: { content: VTT_REPLY }, finish_reason: "stop" },
							],
							usage: {
								prompt_tokens: 4321,
								completion_tokens: 765,
								cost: 0.0129,
							},
						},
					);
				return new Response(body, { status: opts.status ?? 200 });
			}
			// The audio download.
			return new Response(new Uint8Array([1, 2, 3, 4, 5]), { status: 200 });
		}),
	);
	return { calls };
}

describe("transcribeWithOpenRouter — the bytes that actually go on the wire", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
	});

	it("sends the measured request shape: model, temperature 0.1, reasoning at the floor, the EXACT prompt bytes, and the audio as input_audio", async () => {
		const { calls } = stubFetch({});

		await transcribeWithOpenRouter("https://a/0.mp3", {
			apiKey: KEY,
			audioDurationSec: 180,
			knownSpeakers: ["Spiker 1", "Spiker 2"],
		});

		const call = calls.find((c) => c.url === OPENROUTER_COMPLETIONS_URL);
		expect(call).toBeDefined();
		const sent = JSON.parse(String(call?.init.body)) as {
			model: string;
			temperature: number;
			max_tokens: number;
			reasoning: { effort: string };
			messages: Array<{
				role: string;
				content: Array<Record<string, unknown>>;
			}>;
		};

		expect(sent.model).toBe(OPENROUTER_MODEL);
		expect(sent.temperature).toBe(0.1);
		expect(sent.max_tokens).toBe(TRANSCRIBE_MAX_OUTPUT_TOKENS);
		// Reasoning at the FLOOR — the parity requirement, and the thing a "helpful"
		// later edit is most likely to drop.
		expect(sent.reasoning).toEqual({ effort: "minimal" });

		expect(sent.messages).toHaveLength(1);
		expect(sent.messages[0]?.role).toBe("user");
		const parts = sent.messages[0]?.content ?? [];
		// Prompt bytes come from the production prompt builder, not from a
		// string authored here.
		expect(parts[0]).toEqual({
			type: "text",
			text: buildTranscriptionPrompt({
				knownSpeakers: ["Spiker 1", "Spiker 2"],
			}),
		});
		expect(parts[1]).toEqual({
			type: "input_audio",
			input_audio: {
				data: Buffer.from(new Uint8Array([1, 2, 3, 4, 5])).toString("base64"),
				format: "mp3",
			},
		});

		// The credential travels in the header and NOWHERE else.
		const headers = call?.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(String(call?.init.body)).not.toContain(KEY);
		expect(call?.url).not.toContain(KEY);
	});

	it("parses the reply into WebVTT and carries OpenRouter's own dollar cost through as microdollars", async () => {
		stubFetch({});

		const res = await transcribeWithOpenRouter("https://a/0.mp3", {
			apiKey: KEY,
			audioDurationSec: 180,
		});

		expect(res.transcriptVtt).toContain("WEBVTT");
		expect(res.transcriptVtt).toContain("Spiker 1: Assalomu alaykum.");
		expect(res.transcriptVtt).toContain("-->");
		expect(res.inputTokens).toBe(4321);
		expect(res.outputTokens).toBe(765);
		// $0.0129 → 12900 microdollars. This is the number the owner's cost
		// panel shows, so it is asserted exactly.
		expect(res.costUsdMicros).toBe(12_900);
		expect(res.modelUsed).toBe(OPENROUTER_USAGE_MODEL);
	});

	it("a missing/unusable usage.cost leaves costUsdMicros undefined so the caller prices it rather than recording $0", async () => {
		stubFetch({
			completion: {
				choices: [{ message: { content: VTT_REPLY } }],
				usage: { prompt_tokens: 10, completion_tokens: 5 },
			},
		});

		const res = await transcribeWithOpenRouter("https://a/0.mp3", {
			apiKey: KEY,
		});
		expect(res.costUsdMicros).toBeUndefined();
	});

	it("SECURITY: an error body that echoes the request cannot carry the key into the message", async () => {
		stubFetch({
			status: 401,
			rawBody: JSON.stringify({
				error: {
					message: `No auth credentials found. sent: Authorization: Bearer ${KEY}`,
				},
			}),
		});

		await expect(
			transcribeWithOpenRouter("https://a/0.mp3", {
				apiKey: KEY,
				maxAttempts: 1,
			}),
		).rejects.toThrow(/OpenRouter completion failed \(HTTP 401\)/);

		try {
			await transcribeWithOpenRouter("https://a/0.mp3", {
				apiKey: KEY,
				maxAttempts: 1,
			});
			throw new Error("expected a throw");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			expect(message).not.toContain(KEY);
			expect(message).toContain("[redacted]");
		}
	});

	it("the redactor removes a key it was never told about (shape-based, not value-based)", () => {
		const leaked = redactOpenRouterKey(
			"upstream said: sk-or-v1-abcdef0123456789abcdef ok",
		);
		expect(leaked).not.toContain("sk-or-v1-abcdef0123456789abcdef");
		expect(leaked).toContain("[redacted]");
	});
});

describe("THE GATE: free first — an available free chain means ZERO OpenRouter calls", () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		H.withCostGuard.mockReset();
		H.transcribeWithGemini.mockReset();
		H.patchVideoMetadata.mockReset();
		H.withCostGuard.mockImplementation(
			async (opts: { fn: () => Promise<unknown> }) => opts.fn(),
		);
		ROW.metadata = {};
	});

	it("free Google answers → the OpenRouter endpoint is never contacted, even though its key is configured", async () => {
		ENV.value = {
			GEMINI_API_KEY_FREE: "free-key",
			OPENROUTER_API_KEY: KEY,
		};
		const { calls } = stubFetch({});
		H.transcribeWithGemini.mockResolvedValue({
			transcriptVtt: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFREE\n\n",
			inputTokens: 1,
			outputTokens: 1,
			audioInTokens: 1,
		});

		const out = await transcribeAudioChunks(
			{
				chunks: [
					{ key: "k0", url: "https://a/0.mp3", startSec: 0, durationSec: 180 },
				],
				totalDurationSec: 180,
			},
			null,
			CTX,
		);

		expect(out).toContain("FREE");
		expect(
			calls.filter((c) => c.url === OPENROUTER_COMPLETIONS_URL),
		).toHaveLength(0);
	});

	it("free quota exhausted → the paid leg is OpenRouter, called ONCE, and its own cost reaches the cost guard", async () => {
		ENV.value = {
			GEMINI_API_KEY_FREE: "free-key",
			OPENROUTER_API_KEY: KEY,
		};
		const { calls } = stubFetch({});
		H.transcribeWithGemini.mockRejectedValue(
			new Error("429 RESOURCE_EXHAUSTED: Your prepayment credits are depleted"),
		);

		const out = await transcribeAudioChunks(
			{
				chunks: [
					{ key: "k0", url: "https://a/0.mp3", startSec: 0, durationSec: 180 },
				],
				totalDurationSec: 180,
			},
			null,
			CTX,
		);

		expect(out).toContain("Assalomu alaykum");
		expect(
			calls.filter((c) => c.url === OPENROUTER_COMPLETIONS_URL),
		).toHaveLength(1);

		// The cost guard was asked to record the OpenRouter model, and the
		// value it received back is OpenRouter's own charge — not a token
		// estimate produced here.
		const paidGuardCall = H.withCostGuard.mock.calls
			.map((c) => c[0] as { model: string; fn: () => Promise<unknown> })
			.find((c) => c.model === OPENROUTER_USAGE_MODEL);
		expect(paidGuardCall).toBeDefined();
		const guarded = (await H.withCostGuard.mock.results[
			H.withCostGuard.mock.results.length - 1
		]?.value) as { costUsdMicros?: number };
		expect(guarded.costUsdMicros).toBe(12_900);
	});
});
