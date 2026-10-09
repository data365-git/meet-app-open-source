import { recordFreeGeminiCall } from "@/lib/free-quota-meter";
import { withGeminiRetry } from "@/lib/gemini-retry";
import {
	buildTranscriptionPrompt,
	normalizeToWebVtt,
	stripRunawayRepetition,
	TRANSCRIBE_MAX_OUTPUT_TOKENS,
} from "@/lib/gemini-transcribe";

// ─── Constants ────────────────────────────────────────────────────────────────

// Same model as the sync path's primary. The batch endpoint keys off the
// model in the URL; keep it aligned with GEMINI_TRANSCRIBE_MODELS[0]
// (gemini-3-flash-preview since 2026-07-04 — the Cyrillic fix applies to the
// "Arzon"/cheap batch path too, owner decision).
const BATCH_TRANSCRIBE_MODEL = "gemini-3-flash-preview";

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

/** Overall timeout budget used by the pure `shouldFallbackToSync` decision. The
 * in-process poller that consumed it was removed (cron-driven collect replaces
 * it); the pure helper + its tests are kept. */
export const BATCH_TIMEOUT_MS = 30 * 60_000; // 30 min

// ─── Pure helpers (network-free — unit tested) ────────────────────────────────

/**
 * Classify a raw batch state string.
 *   SUCCEEDED            → "succeeded"
 *   FAILED/CANCELLED/EXPIRED → "failed" (terminal but no usable output)
 *   anything else (PENDING/RUNNING/undefined/unknown) → "pending" (keep polling)
 * Case/format tolerant: matches on the trailing token so both
 * "BATCH_STATE_SUCCEEDED" and a bare "SUCCEEDED" resolve the same.
 */
export function mapBatchState(
	state: string | undefined | null,
): BatchStateClass {
	const s = (state ?? "").toUpperCase();
	if (s.includes("SUCCEEDED")) return "succeeded";
	if (
		s.includes("FAILED") ||
		s.includes("CANCELLED") ||
		s.includes("EXPIRED")
	) {
		return "failed";
	}
	return "pending";
}

export function isTerminalBatchState(
	state: string | undefined | null,
): boolean {
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
	const rawAudioInTokens =
		gen.usageMetadata?.promptTokensDetails?.find((d) => d.modality === "AUDIO")
			?.tokenCount ?? 0;
	// Transcription input is essentially all audio. When the response omits
	// promptTokensDetails (or lacks an AUDIO entry), don't silently bill the
	// dominant cost at the cheaper text rate — treat the whole input as audio.
	const audioInTokens =
		rawAudioInTokens === 0 && inputTokens > 0 ? inputTokens : rawAudioInTokens;
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
					{
						text: buildTranscriptionPrompt({
							knownSpeakers: params.knownSpeakers,
						}),
					},
				],
			},
		],
		generationConfig: {
			temperature: 0.1,
			// Aligned with the sync path's runaway-cost cap (spec §5 C1). The old
			// 65,536 let a repetition loop burn the whole budget; sync caps at 24k
			// and the collector applies the same stripRunawayRepetition guard.
			maxOutputTokens: TRANSCRIBE_MAX_OUTPUT_TOKENS,
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
		if (data.state === "FAILED")
			throw new Error("Gemini file processing failed");
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
			// Body included so a revoked key is visible to the classifier
			// (round-15 #1, same as the sync path).
			const body = await initRes.text().catch(() => "");
			throw new Error(
				`Gemini upload init failed (HTTP ${initRes.status}): ${body.slice(0, 300)}`,
			);
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
			const body = await uploadRes.text().catch(() => "");
			throw new Error(
				`Gemini audio upload failed (HTTP ${uploadRes.status}): ${body.slice(0, 300)}`,
			);
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
		// Owner's free-quota meter: fire-and-forget, never awaited, no-op
		// unless this key is the free one (admin badge, 2026-10-02).
		recordFreeGeminiCall({
			apiKey,
			model: BATCH_TRANSCRIBE_MODEL,
			status: res.status,
			body: res.ok ? undefined : JSON.stringify(data),
		});
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

/** Best-effort cancel — never throws. Used by the paid four-hour flip and the
 * "no longer cheap" cron branch to stop a still-running Batch we will abandon. */
export async function cancelBatch(
	batchName: string,
	apiKey: string,
): Promise<void> {
	await fetch(`${GL_BASE}/${batchName}:cancel?key=${apiKey}`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: "{}",
	}).catch(() => {});
}

/** Best-effort delete of an uploaded Files API input object — never throws. */
export async function deleteBatchFile(
	fileName: string,
	apiKey: string,
): Promise<void> {
	await fetch(`${GL_BASE}/${fileName}?key=${apiKey}`, {
		method: "DELETE",
	}).catch(() => {});
}

// ─── Durable submit / collect (cron-driven; NO in-process poll) ─────────────────
// The pair below splits the old in-process transcribeChunkWithBatch into two
// steps so a batch can outlive the request that started it: the workflow SUBMITS
// (and returns), a cron later COLLECTS. This is what makes "Arzon" batch safe —
// the 30-min in-process poll that used to freeze jobs is gone.

export interface SubmittedBatchChunk {
	batchName: string;
	/** Files API object name — kept alive until collect; the caller stores it so
	 * the collector can delete it after the result is retrieved. */
	fileName: string;
}

/** Upload + submit one chunk to the Batch API and return immediately. Does NOT
 * poll and does NOT delete the uploaded file (the collector deletes it). */
export async function submitChunkBatch(
	audioUrl: string,
	options: { apiKey: string; knownSpeakers?: string[]; videoId?: string },
): Promise<SubmittedBatchChunk> {
	const { apiKey, knownSpeakers, videoId } = options;
	const uploaded = await uploadAudioForBatch(audioUrl, apiKey);
	const body = buildBatchRequestBody({
		model: BATCH_TRANSCRIBE_MODEL,
		mimeType: uploaded.mimeType,
		fileUri: uploaded.fileUri,
		knownSpeakers,
		displayName: `cap-batch-${videoId ?? "chunk"}-${Date.now()}`,
	});
	let batchName: string;
	try {
		batchName = await submitBatch(body, apiKey);
	} catch (error) {
		// Upload succeeded but submission failed — the Files API object would leak
		// (no collector will ever see it since no job was persisted). Best-effort
		// delete it, then rethrow so the caller keeps the patient-free wait.
		await deleteBatchFile(uploaded.fileName, apiKey);
		throw error;
	}
	// Do NOT log the audio URL (it is a signed storage URL); batch name + video id
	// are enough to re-attach from logs.
	console.log(
		`[gemini-batch] durable submit ${batchName} for video=${videoId ?? "?"}`,
	);
	return { batchName, fileName: uploaded.fileName };
}

export type CollectBatchResult =
	| {
			status: "succeeded";
			transcriptVtt: string;
			inputTokens: number;
			outputTokens: number;
			audioInTokens: number;
	  }
	| { status: "pending" }
	| { status: "failed"; reason: string };

/** Poll a submitted batch ONCE. On success, unwrap + normalize + delete the
 * uploaded file. On terminal failure / inline error / empty output, delete the
 * file and report "failed" (the chunk gets re-done on the next kick). Still
 * running → "pending". Never throws for expected states (poll network errors do
 * throw so the cron logs + retries next tick). */
export async function collectBatchResult(
	batchName: string,
	options: { apiKey: string; fileName?: string; audioDurationSec?: number },
): Promise<CollectBatchResult> {
	const { apiKey, fileName, audioDurationSec = 300 } = options;
	const polled = await getBatch(batchName, apiKey);
	const cls = mapBatchState(extractBatchState(polled));

	if (cls === "pending") return { status: "pending" };

	if (cls === "failed") {
		if (fileName) await deleteBatchFile(fileName, apiKey);
		return { status: "failed", reason: `terminal state for ${batchName}` };
	}

	try {
		const unwrapped = unwrapBatchResponse(polled);
		// Same runaway-repetition guard the sync path applies before normalizing
		// (spec §5 C1) — a Batch chunk can loop just like a sync one, and the 24k
		// cap alone does not remove the garbage tail.
		const { text: guardedText } = stripRunawayRepetition(unwrapped.rawText);
		const transcriptVtt = normalizeToWebVtt(guardedText, audioDurationSec);
		if (fileName) await deleteBatchFile(fileName, apiKey);
		return {
			status: "succeeded",
			transcriptVtt,
			inputTokens: unwrapped.inputTokens,
			outputTokens: unwrapped.outputTokens,
			audioInTokens: unwrapped.audioInTokens,
		};
	} catch (error) {
		if (fileName) await deleteBatchFile(fileName, apiKey);
		return {
			status: "failed",
			reason: error instanceof Error ? error.message : String(error),
		};
	}
}
