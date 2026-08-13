/**
 * The OpenRouter transport for the PAID leg of the AI path.
 *
 * Scope, deliberately narrow: this file knows how to talk to OpenRouter and
 * nothing else. It never reads the credential (lib/openrouter-key.ts owns it,
 * pinned by a source-scan test), never decides WHETHER to spend (the free-first
 * gate does that at each call site), and never chooses a model per feature —
 * the model is one constant, because parity with today's Google output was
 * measured on exactly that model.
 *
 * The request shape below is not a guess. It is the shape verified live on
 * 2026-08-13 across six runs / three real 3-min chunks against the production
 * Gemini path: same coverage (2m26s vs 2m27s), same `Spiker 1/2` labels, same
 * Uzbek Latin script. `temperature: 0.1` and `reasoning: { max_tokens: 0 }` are
 * REQUIRED for that parity — they are the OpenRouter spelling of the Gemini
 * path's `temperature: 0.1` + `thinkingConfig: { thinkingBudget: 0 }`.
 */
import {
	buildTranscriptionPrompt,
	type GeminiTranscribeResult,
	normalizeToWebVtt,
	stripRunawayRepetition,
	TRANSCRIBE_MAX_OUTPUT_TOKENS,
} from "@/lib/gemini-transcribe";
import { withGeminiRetry } from "@/lib/gemini-retry";

export const OPENROUTER_COMPLETIONS_URL =
	"https://openrouter.ai/api/v1/chat/completions";

/** ONE model. The measured-parity model — the Google model this app already
 * uses, served through OpenRouter. Recorded in `ai_usage_events.model` with the
 * `openrouter/` prefix OpenRouter itself uses, so the owner's cost panel shows
 * which vendor was billed. */
export const OPENROUTER_MODEL = "google/gemini-3-flash-preview";
/** What withCostGuard records. Prefixed so a Gemini row and an OpenRouter row
 * are never confused in the spend breakdown. */
export const OPENROUTER_USAGE_MODEL = `openrouter/${OPENROUTER_MODEL}`;

export type OpenRouterContentPart =
	| { type: "text"; text: string }
	| { type: "input_audio"; input_audio: { data: string; format: string } };

export type OpenRouterMessage = {
	role: "user" | "assistant" | "system";
	content: string | OpenRouterContentPart[];
};

export interface OpenRouterUsage {
	inputTokens: number;
	outputTokens: number;
	/** OpenRouter's OWN dollar figure for the call (`usage.cost`). Undefined when
	 * the response did not carry one — callers must then fall back to the token
	 * pricing table rather than record $0. */
	costUsdMicros?: number;
}

/**
 * SECURITY (round-15 taught this the expensive way): upload/generate errors on
 * this path deliberately carry the upstream response BODY so the auth
 * classifier can see the vendor's own `API_KEY_INVALID`-style evidence. That
 * body, and any request echo inside it, must never be able to carry the
 * credential into a log line or a user-visible string. The OpenRouter key
 * travels in the `Authorization` header only — never in a URL or a body — so
 * an echo is the only realistic path, and this closes it: the exact key value
 * AND anything key-SHAPED is replaced before the text is ever concatenated
 * into an Error.
 */
export function redactOpenRouterKey(text: string, apiKey?: string): string {
	let out = text;
	if (apiKey && apiKey.length >= 8) {
		out = out.split(apiKey).join("[redacted]");
	}
	return out
		.replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "[redacted]")
		.replace(/(Bearer)\s+[A-Za-z0-9._-]{8,}/gi, "$1 [redacted]");
}

/** Body builder, exported so a test can assert the exact bytes that go out
 * without re-authoring them at the test boundary. */
export function buildOpenRouterBody(opts: {
	model?: string;
	messages: OpenRouterMessage[];
	maxTokens: number;
	temperature: number;
	stream?: boolean;
	/** Structured-output request, the twin of the Gemini legs'
	 * `generationConfig.responseMimeType: "application/json"`. Without it the
	 * model may wrap its JSON in prose, which costs a SECOND paid call on the
	 * summary leg and throws on the translate leg — after both are billed.
	 * Verified accepted (HTTP 200, valid JSON) against
	 * google/gemini-3-flash-preview on 2026-08-13. */
	responseFormat?: "json_object";
}): Record<string, unknown> {
	return {
		model: opts.model ?? OPENROUTER_MODEL,
		messages: opts.messages,
		max_tokens: opts.maxTokens,
		temperature: opts.temperature,
		...(opts.responseFormat
			? { response_format: { type: opts.responseFormat } }
			: {}),
		// Reasoning OFF. Parity requirement, not a cost tweak: the Google path
		// runs with thinkingBudget 0 and the measured transcript match was taken
		// with reasoning disabled.
		reasoning: { max_tokens: 0 },
		// Ask for the real dollar figure back on streamed responses too; harmless
		// on non-streamed ones, which return `usage` regardless.
		...(opts.stream ? { stream: true, usage: { include: true } } : {}),
	};
}

export function openRouterHeaders(apiKey: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	};
}

/** USD → microdollars, the unit `ai_usage_events.costUsdMicros` stores. Returns
 * undefined for anything that is not a usable POSITIVE number, so a missing,
 * malformed OR ZERO `usage.cost` falls back to the pricing table instead of
 * recording a free call that was not free.
 *
 * Why zero is excluded (round-18 #5): a paid OpenRouter call is never actually
 * free — every measured response, down to an 11-character completion, reports a
 * non-zero cost. An exact `0` is therefore a REPORTING failure, not a price, and
 * accepting it recorded a $0 event: monthly/per-video spend stayed flat and the
 * $100/month + $20/video backstops could never trip, so a retry loop could bill
 * without limit. The genuinely-free Google path never reaches this function — it
 * records $0 through `withCostGuard({ free: true })`. */
export function costUsdToMicros(cost: unknown): number | undefined {
	if (typeof cost !== "number" || !Number.isFinite(cost) || cost <= 0) {
		return undefined;
	}
	return Math.round(cost * 1_000_000);
}

interface OpenRouterCompletionResponse {
	choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		cost?: number;
	};
	error?: { message?: string };
}

/** One non-streamed chat completion. Returns the assistant text plus usage. */
export async function openRouterCompletion(opts: {
	apiKey: string;
	messages: OpenRouterMessage[];
	maxTokens: number;
	temperature: number;
	model?: string;
	signal?: AbortSignal;
	maxAttempts?: number;
	fetchImpl?: typeof fetch;
	/** Ask for structured JSON, the twin of the Gemini legs' responseMimeType. */
	responseFormat?: "json_object";
}): Promise<OpenRouterUsage & { text: string; finishReason?: string }> {
	const doFetch = opts.fetchImpl ?? fetch;
	const body = JSON.stringify(
		buildOpenRouterBody({
			model: opts.model,
			messages: opts.messages,
			maxTokens: opts.maxTokens,
			temperature: opts.temperature,
			responseFormat: opts.responseFormat,
		}),
	);

	const data = await withGeminiRetry(
		async () => {
			const res = await doFetch(OPENROUTER_COMPLETIONS_URL, {
				method: "POST",
				headers: openRouterHeaders(opts.apiKey),
				body,
				signal: opts.signal,
			});
			const raw = await res.text();
			if (!res.ok) {
				// Same message SHAPE as the Gemini legs — "... failed (HTTP nnn): ..."
				// — so withGeminiRetry's transient detection, the free/paid error
				// classifiers and sanitizeAiErrorMessageForUi all keep working
				// unchanged. Body redacted first (see redactOpenRouterKey).
				throw new Error(
					`OpenRouter completion failed (HTTP ${res.status}): ${redactOpenRouterKey(
						raw,
						opts.apiKey,
					).slice(0, 300)}`,
				);
			}
			let parsed: OpenRouterCompletionResponse;
			try {
				parsed = JSON.parse(raw) as OpenRouterCompletionResponse;
			} catch {
				throw new Error(
					`OpenRouter completion returned non-JSON (HTTP ${res.status}): ${redactOpenRouterKey(
						raw,
						opts.apiKey,
					).slice(0, 200)}`,
				);
			}
			if (parsed.error) {
				throw new Error(
					`OpenRouter completion failed (HTTP ${res.status}): ${redactOpenRouterKey(
						parsed.error.message ?? "unknown",
						opts.apiKey,
					).slice(0, 300)}`,
				);
			}
			return parsed;
		},
		opts.maxAttempts ?? 5,
		opts.signal,
	);

	return {
		text: data.choices?.[0]?.message?.content ?? "",
		finishReason: data.choices?.[0]?.finish_reason,
		inputTokens: data.usage?.prompt_tokens ?? 0,
		outputTokens: data.usage?.completion_tokens ?? 0,
		costUsdMicros: costUsdToMicros(data.usage?.cost),
	};
}

/** OpenRouter's `input_audio.format` — the container name, not a MIME type. */
export function audioFormatFromUrl(audioUrl: string): string {
	const url = (audioUrl.split("?")[0] ?? audioUrl).toLowerCase();
	if (url.endsWith(".wav")) return "wav";
	if (url.endsWith(".m4a") || url.endsWith(".mp4")) return "m4a";
	if (url.endsWith(".ogg") || url.endsWith(".oga")) return "ogg";
	if (url.endsWith(".flac")) return "flac";
	return "mp3";
}

export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

/**
 * Transcription through OpenRouter — the drop-in twin of transcribeWithGemini.
 *
 * Same prompt BYTES (buildTranscriptionPrompt, the single string the Gemini
 * batch path already sends), same output ceiling, same post-processing chain
 * (runaway-repetition guard → empty check → normalizeToWebVtt), so the stored
 * transcript is produced by the identical code below the transport.
 *
 * One structural difference from the Gemini path, and it is a simplification:
 * there is no Files API. The audio is inlined as base64 in the request, so the
 * resumable-upload/poll/cleanup machinery has no counterpart here and nothing
 * is left behind on the vendor to delete.
 */
export async function transcribeWithOpenRouter(
	audioUrl: string,
	options: {
		apiKey: string;
		audioDurationSec?: number;
		knownSpeakers?: string[];
		signal?: AbortSignal;
		maxAttempts?: number;
		model?: string;
		fetchImpl?: typeof fetch;
	},
): Promise<GeminiTranscribeResult & { costUsdMicros?: number }> {
	const doFetch = options.fetchImpl ?? fetch;
	const audioDurationSec = options.audioDurationSec ?? 300;

	const audioResponse = await doFetch(audioUrl, { signal: options.signal });
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}
	const audioBytes = new Uint8Array(await audioResponse.arrayBuffer());

	const result = await openRouterCompletion({
		apiKey: options.apiKey,
		model: options.model,
		maxTokens: TRANSCRIBE_MAX_OUTPUT_TOKENS,
		temperature: 0.1,
		signal: options.signal,
		maxAttempts: options.maxAttempts,
		fetchImpl: options.fetchImpl,
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						// The EXACT prompt bytes the Google path sends: the fixed
						// instruction prefix plus this chunk's speaker roster.
						text: buildTranscriptionPrompt({
							knownSpeakers: options.knownSpeakers,
						}),
					},
					{
						type: "input_audio",
						input_audio: {
							data: toBase64(audioBytes),
							format: audioFormatFromUrl(audioUrl),
						},
					},
				],
			},
		],
	});

	const { text: guardedText, runaway } = stripRunawayRepetition(result.text);
	if (runaway) {
		console.warn(
			`[openrouter-transcribe] RUNAWAY repetition detected (outputTokens=${result.outputTokens}, finishReason=${result.finishReason}); truncated garbage tail, kept clean prefix`,
		);
	}
	if (guardedText.trim().length === 0) {
		throw new Error(
			`[openrouter-transcribe] empty transcript from OpenRouter (finishReason=${result.finishReason}); not saving as complete`,
		);
	}

	return {
		transcriptVtt: normalizeToWebVtt(guardedText, audioDurationSec),
		inputTokens: result.inputTokens,
		outputTokens: result.outputTokens,
		// OpenRouter does not split the audio share of the input. It does not
		// need to: `costUsdMicros` below is the vendor's own charge, so the
		// token-split heuristic in withCostGuard is bypassed entirely for this
		// path and never has to guess an audio rate.
		audioInTokens: 0,
		modelUsed: OPENROUTER_USAGE_MODEL,
		costUsdMicros: result.costUsdMicros,
	};
}
