import { withGeminiRetry } from "@/lib/gemini-retry";
import {
	buildTranscriptionPrompt,
	type GeminiTranscribeResult,
	normalizeToWebVtt,
} from "@/lib/gemini-transcribe";

// ─── Constants ────────────────────────────────────────────────────────────────

// Same model set as the sync path's primary. The batch endpoint keys off the
// model in the URL; keep it aligned with GEMINI_TRANSCRIBE_MODELS[0].
const BATCH_TRANSCRIBE_MODEL = "gemini-2.5-flash";

// Terminal batch states. The live API returns BATCH_STATE_* (NOT JOB_STATE_*
// as some Google docs claim — spike-verified 2026-07-03). Anything not in this
// set (PENDING/RUNNING/unknown) is treated as still-pending → keep polling.
export const TERMINAL_BATCH_STATES = [
	"BATCH_STATE_SUCCEEDED",
	"BATCH_STATE_FAILED",
	"BATCH_STATE_CANCELLED",
	"BATCH_STATE_EXPIRED",
] as const;

export type BatchStateClass = "succeeded" | "failed" | "pending";

/** Poll interval and overall timeout. Batch jobs run server-side; we only poll. */
export const BATCH_POLL_INTERVAL_MS = 30_000; // 30s (spec: every 30-60s)
export const BATCH_TIMEOUT_MS = 30 * 60_000; // 30 min → fall back to sync

// ─── Pure helpers (network-free — unit tested) ────────────────────────────────

/**
 * Classify a raw batch state string.
 *   SUCCEEDED            → "succeeded"
 *   FAILED/CANCELLED/EXPIRED → "failed" (terminal but no usable output)
 *   anything else (PENDING/RUNNING/undefined/unknown) → "pending" (keep polling)
 * Case/format tolerant: matches on the trailing token so both
 * "BATCH_STATE_SUCCEEDED" and a bare "SUCCEEDED" resolve the same.
 */
export function mapBatchState(state: string | undefined | null): BatchStateClass {
	const s = (state ?? "").toUpperCase();
	if (s.includes("SUCCEEDED")) return "succeeded";
	if (s.includes("FAILED") || s.includes("CANCELLED") || s.includes("EXPIRED")) {
		return "failed";
	}
	return "pending";
}

export function isTerminalBatchState(state: string | undefined | null): boolean {
	return mapBatchState(state) !== "pending";
}

/**
 * Decide whether a not-yet-terminal batch has exceeded its timeout budget and
 * should be abandoned in favour of the synchronous path for this chunk. Kept
 * pure (takes elapsed + state, no clock/network) so the fallback decision is
 * unit-testable.
 */
export function shouldFallbackToSync({
	state,
	elapsedMs,
	timeoutMs = BATCH_TIMEOUT_MS,
}: {
	state: string | undefined | null;
	elapsedMs: number;
	timeoutMs?: number;
}): boolean {
	if (isTerminalBatchState(state)) return false;
	return elapsedMs >= timeoutMs;
}

type InlinedResponse = {
	response?: unknown;
	error?: { message?: string; code?: number | string } | null;
};

/**
 * Tolerantly pull the first inlined per-request result out of a completed batch
 * metadata blob. The spike observed DOUBLED nesting
 * (`response.inlinedResponses.inlinedResponses[0]`), but Google has shipped the
 * single-nested shape (`response.inlinedResponses[0]`) in other responses and
 * may put the array under `output`/`dest` instead of `response`. Try every
 * known shape and return the first inlined entry (which itself carries either
 * `.response` with candidates or `.error`).
 */
export function extractInlinedResponse(
	batch: unknown,
): InlinedResponse | undefined {
	const readArray = (node: unknown): unknown[] | undefined => {
		if (Array.isArray(node)) return node;
		if (node && typeof node === "object") {
			const inner = (node as { inlinedResponses?: unknown }).inlinedResponses;
			if (Array.isArray(inner)) return inner;
		}
		return undefined;
	};

	const b = (batch ?? {}) as Record<string, unknown>;
	// Candidate containers, in priority order, that may hold `inlinedResponses`.
	const containers: unknown[] = [
		(b.response as { inlinedResponses?: unknown })?.inlinedResponses,
		b.response,
		(b.output as { inlinedResponses?: unknown })?.inlinedResponses,
		b.output,
		(b.dest as { inlinedResponses?: unknown })?.inlinedResponses,
		b.inlinedResponses,
		b,
	];

	for (const c of containers) {
		const arr = readArray(c);
		if (arr && arr.length > 0) {
			return arr[0] as InlinedResponse;
		}
	}
	return undefined;
}

type GenCandidateData = {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		finishReason?: string;
	}>;
	usageMetadata?: {
		promptTokenCount?: number;
		candidatesTokenCount?: number;
		promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
	};
};

export interface UnwrappedBatchResult {
	rawText: string;
	inputTokens: number;
	outputTokens: number;
	audioInTokens: number;
	finishReason?: string;
}

/**
 * Turn a completed batch metadata blob into the same token/text fields the sync
 * path produces. Throws when the single inlined request carried an error (so it
 * routes into the SAME retry path as a sync failure) or when no candidate text
 * is present. Tolerant to the response nesting variants above.
 */
export function unwrapBatchResponse(batch: unknown): UnwrappedBatchResult {
	const inlined = extractInlinedResponse(batch);
	if (!inlined) {
		throw new Error("Batch response missing inlinedResponses");
	}
	if (inlined.error) {
		const msg =
			inlined.error.message ?? `code ${inlined.error.code ?? "unknown"}`;
		throw new Error(`Batch inline request error: ${msg}`);
	}

	const gen = (inlined.response ?? {}) as GenCandidateData;
	const rawText = gen.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
	const inputTokens = gen.usageMetadata?.promptTokenCount ?? 0;
	const outputTokens = gen.usageMetadata?.candidatesTokenCount ?? 0;
	const audioInTokens =
		gen.usageMetadata?.promptTokensDetails?.find(
			(d) => d.modality === "AUDIO",
		)?.tokenCount ?? 0;
	const finishReason = gen.candidates?.[0]?.finishReason;

	if (rawText.trim().length === 0) {
		throw new Error(
			`Batch response empty transcript (finishReason=${finishReason})`,
		);
	}

	return { rawText, inputTokens, outputTokens, audioInTokens, finishReason };
}

/** Build the batch create body: same contents/generationConfig as the sync call,
 * wrapped in the spike-proven `batch.input_config.requests.requests[0].request`
 * envelope. Kept pure so the request shape is asserted in tests. */
export function buildBatchRequestBody(params: {
	model: string;
	mimeType: string;
	fileUri: string;
	knownSpeakers?: string[];
	displayName: string;
}): Record<string, unknown> {
	const request = {
		contents: [
			{
				parts: [
					{ fileData: { mimeType: params.mimeType, fileUri: params.fileUri } },
					{ text: buildTranscriptionPrompt({ knownSpeakers: params.knownSpeakers }) },
				],
			},
		],
		generationConfig: {
			temperature: 0.1,
			maxOutputTokens: 65536,
			thinkingConfig: { thinkingBudget: 0 },
		},
	};

	return {
		batch: {
			display_name: params.displayName,
			input_config: {
				requests: {
					requests: [{ request }],
				},
			},
		},
	};
}

// ─── Network ──────────────────────────────────────────────────────────────────

const GL_BASE = "https://generativelanguage.googleapis.com/v1beta";

interface UploadedFile {
	fileName: string;
	fileUri: string;
	mimeType: string;
}

function detectMimeType(audioUrl: string): string {
	const url = audioUrl.split("?")[0] ?? audioUrl;
	if (url.endsWith(".mp4") || url.endsWith(".m4a")) return "audio/mp4";
	if (url.endsWith(".wav")) return "audio/wav";
	if (url.endsWith(".ogg")) return "audio/ogg";
	if (url.endsWith(".webm")) return "audio/webm";
	return "audio/mpeg";
}

async function pollFileUntilActive(
	fileName: string,
	apiKey: string,
): Promise<void> {
	for (let i = 0; i < 30; i++) {
		const res = await fetch(`${GL_BASE}/${fileName}?key=${apiKey}`);
		if (!res.ok) throw new Error(`Gemini file poll failed: ${res.status}`);
		const data = (await res.json()) as { state?: string };
		if (data.state === "ACTIVE") return;
		if (data.state === "FAILED") throw new Error("Gemini file processing failed");
		await new Promise<void>((r) => setTimeout(r, 2000));
	}
	throw new Error("Gemini file never reached ACTIVE state");
}

/** Upload chunk audio to the Files API (resumable) and wait until ACTIVE. */
async function uploadAudioForBatch(
	audioUrl: string,
	apiKey: string,
): Promise<UploadedFile> {
	const audioResponse = await fetch(audioUrl);
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}
	const audioBytes = new Uint8Array(await audioResponse.arrayBuffer());
	const mimeType = detectMimeType(audioUrl);
	const displayName = `cap-batch-audio-${Date.now()}`;

	const uploadUrl = await withGeminiRetry(async () => {
		const initRes = await fetch(
			`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
			{
				method: "POST",
				headers: {
					"X-Goog-Upload-Protocol": "resumable",
					"X-Goog-Upload-Command": "start",
					"X-Goog-Upload-Header-Content-Length": String(audioBytes.byteLength),
					"X-Goog-Upload-Header-Content-Type": mimeType,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ file: { display_name: displayName } }),
			},
		);
		if (!initRes.ok) {
			throw new Error(`Gemini upload init failed (HTTP ${initRes.status})`);
		}
		const url = initRes.headers.get("x-goog-upload-url");
		if (!url) throw new Error("No upload URL from Gemini Files API");
		return url;
	});

	const fileData = await withGeminiRetry(async () => {
		const uploadRes = await fetch(uploadUrl, {
			method: "PUT",
			headers: {
				"X-Goog-Upload-Offset": "0",
				"X-Goog-Upload-Command": "upload, finalize",
				"Content-Length": String(audioBytes.byteLength),
			},
			body: audioBytes,
		});
		if (!uploadRes.ok) {
			throw new Error(`Gemini audio upload failed (HTTP ${uploadRes.status})`);
		}
		return (await uploadRes.json()) as {
			file: { name: string; uri: string; state: string };
		};
	});

	const { name: fileName, uri: fileUri, state } = fileData.file;
	if (!fileUri || !fileName) {
		throw new Error(
			`Gemini upload response missing file info: ${JSON.stringify(fileData)}`,
		);
	}
	if (state !== "ACTIVE") {
		await withGeminiRetry(() => pollFileUntilActive(fileName, apiKey));
	}
	return { fileName, fileUri, mimeType };
}

function extractBatchName(created: unknown): string | undefined {
	const c = (created ?? {}) as Record<string, unknown>;
	// The create response returns the operation/batch under `name` (e.g.
	// "batches/xyz"); some shapes nest it under `metadata.name`.
	if (typeof c.name === "string" && c.name) return c.name;
	const meta = c.metadata as { name?: unknown } | undefined;
	if (meta && typeof meta.name === "string" && meta.name) return meta.name;
	return undefined;
}

function extractBatchState(polled: unknown): string | undefined {
	const p = (polled ?? {}) as Record<string, unknown>;
	if (typeof p.state === "string") return p.state;
	const meta = p.metadata as { state?: unknown } | undefined;
	if (meta && typeof meta.state === "string") return meta.state;
	return undefined;
}

async function submitBatch(
	body: Record<string, unknown>,
	apiKey: string,
): Promise<string> {
	const created = await withGeminiRetry(async () => {
		const res = await fetch(
			`${GL_BASE}/models/${BATCH_TRANSCRIBE_MODEL}:batchGenerateContent?key=${apiKey}`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			},
		);
		const data = (await res.json()) as unknown;
		if (!res.ok) {
			const msg =
				(data as { error?: { message?: string } })?.error?.message ??
				String(res.status);
			throw new Error(`Batch submit failed (HTTP ${res.status}): ${msg}`);
		}
		return data;
	});

	const name = extractBatchName(created);
	if (!name) {
		throw new Error(
			`Batch create response missing name: ${JSON.stringify(created).slice(0, 300)}`,
		);
	}
	return name;
}

async function getBatch(batchName: string, apiKey: string): Promise<unknown> {
	return withGeminiRetry(async () => {
		const res = await fetch(`${GL_BASE}/${batchName}?key=${apiKey}`);
		const data = (await res.json()) as unknown;
		if (!res.ok) {
			const msg =
				(data as { error?: { message?: string } })?.error?.message ??
				String(res.status);
			throw new Error(`Batch poll failed (HTTP ${res.status}): ${msg}`);
		}
		return data;
	});
}

async function cancelBatch(batchName: string, apiKey: string): Promise<void> {
	// Best-effort — never throw. Cancels a batch that blew the timeout so we
	// don't pay for output we'll discard in favour of the sync fallback.
	await fetch(`${GL_BASE}/${batchName}:cancel?key=${apiKey}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	}).catch(() => {});
}

async function deleteBatchFile(fileName: string, apiKey: string): Promise<void> {
	await fetch(`${GL_BASE}/${fileName}?key=${apiKey}`, {
		method: "DELETE",
	}).catch(() => {});
}

/** Signalled by the batch runner when the job did not finish usefully in time
 * (timeout, terminal-failure, or empty output). The caller MUST catch this and
 * fall back to the synchronous path for this chunk. */
export class BatchFallbackError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BatchFallbackError";
	}
}

/**
 * Transcribe one chunk via the Gemini Batch API. Uploads the audio, submits the
 * batch, LOGS the returned batch name before polling (crash-safe re-attach at
 * least via logs), polls until terminal or the 30-min timeout, then unwraps.
 *
 * Failure policy — this NEVER silently drops a chunk:
 *   - timeout            → best-effort cancel, throw BatchFallbackError
 *   - terminal FAILED/…  → throw BatchFallbackError
 *   - inline error / empty output → unwrap throws → caller's retry path handles it
 * The uploaded Files API object is ALWAYS deleted in `finally`.
 *
 * `sleepFn`/`nowFn` are injectable for tests; production uses real timers.
 */
export async function transcribeChunkWithBatch(
	audioUrl: string,
	options: {
		apiKey: string;
		audioDurationSec?: number;
		knownSpeakers?: string[];
		videoId?: string;
		pollIntervalMs?: number;
		timeoutMs?: number;
		sleepFn?: (ms: number) => Promise<void>;
		nowFn?: () => number;
	},
): Promise<GeminiTranscribeResult> {
	const {
		apiKey,
		audioDurationSec = 300,
		knownSpeakers,
		videoId,
		pollIntervalMs = BATCH_POLL_INTERVAL_MS,
		timeoutMs = BATCH_TIMEOUT_MS,
		sleepFn = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
		nowFn = () => Date.now(),
	} = options;

	const uploaded = await uploadAudioForBatch(audioUrl, apiKey);
	const displayName = `cap-batch-${videoId ?? "chunk"}-${Date.now()}`;

	try {
		const body = buildBatchRequestBody({
			model: BATCH_TRANSCRIBE_MODEL,
			mimeType: uploaded.mimeType,
			fileUri: uploaded.fileUri,
			knownSpeakers,
			displayName,
		});

		const batchName = await submitBatch(body, apiKey);
		// Persist the batch name BEFORE polling (spike gotcha: batch jobs are not
		// idempotent). Logs are the crash-safe re-attach record.
		console.log(
			`[gemini-batch] submitted batch ${batchName} for video=${videoId ?? "?"} audioUrl=${audioUrl.split("?")[0]}`,
		);

		const startedAt = nowFn();
		let lastState: string | undefined;
		// Poll loop. The first poll happens after one interval — batch jobs take
		// minutes, so an immediate poll is wasted.
		for (;;) {
			await sleepFn(pollIntervalMs);
			const polled = await getBatch(batchName, apiKey);
			lastState = extractBatchState(polled);
			const cls = mapBatchState(lastState);

			if (cls === "succeeded") {
				const unwrapped = unwrapBatchResponse(polled);
				const transcriptVtt = normalizeToWebVtt(
					unwrapped.rawText,
					audioDurationSec,
				);
				console.log(
					`[gemini-batch] batch ${batchName} SUCCEEDED (rawText.length=${unwrapped.rawText.length}, outputTokens=${unwrapped.outputTokens})`,
				);
				return {
					transcriptVtt,
					inputTokens: unwrapped.inputTokens,
					outputTokens: unwrapped.outputTokens,
					audioInTokens: unwrapped.audioInTokens,
				};
			}

			if (cls === "failed") {
				throw new BatchFallbackError(
					`Batch ${batchName} reached terminal non-success state ${lastState}`,
				);
			}

			// Still pending — timeout check.
			if (
				shouldFallbackToSync({
					state: lastState,
					elapsedMs: nowFn() - startedAt,
					timeoutMs,
				})
			) {
				console.warn(
					`[gemini-batch] batch ${batchName} timed out after ${Math.round((nowFn() - startedAt) / 1000)}s (state=${lastState}); cancelling and falling back to sync`,
				);
				await cancelBatch(batchName, apiKey);
				throw new BatchFallbackError(
					`Batch ${batchName} did not finish within ${timeoutMs}ms`,
				);
			}
		}
	} finally {
		await deleteBatchFile(uploaded.fileName, apiKey);
	}
}
