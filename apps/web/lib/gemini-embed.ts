import { recordFreeGeminiCall } from "@/lib/free-quota-meter";
import { withGeminiRetry } from "@/lib/gemini-retry";

/** Max documents per `batchEmbedContents` request. Was 100 — that burst the
 * per-minute embedding quota on any transcript long enough to need it. */
export const EMBED_BATCH_SIZE = 32;
/** Batches keep halving on a 429 down to this many documents before the
 * error is allowed to surface. */
export const EMBED_BATCH_FLOOR = 4;
/** Minimum gap between the START of successive batch requests, so a long
 * transcript paces itself instead of bursting. A single-chunk embed (the
 * one-sentence chat question) never waits — there is no "successive" batch. */
export const EMBED_BATCH_PACING_MS = 1000;

export const EMBED_MODEL = "gemini-embedding-001";

interface BatchEmbedResponse {
	embeddings: Array<{
		values: number[];
	}>;
}

type BatchEmbedResult = BatchEmbedResponse & {
	usageMetadata?: { promptTokenCount?: number };
};

export interface EmbedResult {
	embeddings: number[][];
	totalTokens: number;
}

export async function embedChunks(
	chunks: { text: string }[],
	apiKey: string,
): Promise<number[][]> {
	const result = await embedChunksWithUsage(chunks, apiKey);
	return result.embeddings;
}

async function requestBatch(
	batch: { text: string }[],
	apiKey: string,
): Promise<BatchEmbedResult> {
	// The embedding path opts into honouring the 429 body's `retryDelay`
	// (uncapped by the old 8s ceiling) — this does not touch
	// gemini-batch-transcribe.ts, which calls withGeminiRetry with no options
	// and keeps its existing capped backoff.
	return withGeminiRetry(
		async () => {
			const res = await fetch(
				`https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${apiKey}`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						requests: batch.map((chunk) => ({
							model: `models/${EMBED_MODEL}`,
							content: {
								parts: [{ text: chunk.text }],
							},
						})),
					}),
				},
			);

			if (!res.ok) {
				const errBody = await res.text();
				// Owner's free-quota meter (admin badge): fire-and-forget, never
				// awaited, no-op unless this key is the free one. The 429 body is
				// already read here, so the daily-exhaustion classifier gets it.
				recordFreeGeminiCall({
					apiKey,
					model: EMBED_MODEL,
					status: res.status,
					body: errBody,
				});
				throw new Error(
					`Gemini batchEmbedContents failed: ${res.status} ${errBody}`,
				);
			}

			recordFreeGeminiCall({
				apiKey,
				model: EMBED_MODEL,
				status: res.status,
			});

			return (await res.json()) as BatchEmbedResult;
		},
		5,
		undefined,
		{ honorRetryDelay: true, maxDelayMs: 60_000 },
	);
}

/** Requests `chunks[start, start + size)`, halving the window on a 429 down
 * to `EMBED_BATCH_FLOOR` before letting the error give up for real. */
async function requestBatchWithHalving(
	chunks: { text: string }[],
	start: number,
	size: number,
	apiKey: string,
): Promise<{ data: BatchEmbedResult; used: number }> {
	let currentSize = size;
	for (;;) {
		const batch = chunks.slice(start, start + currentSize);
		try {
			const data = await requestBatch(batch, apiKey);
			return { data, used: batch.length };
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const is429 = /\b429\b/.test(message);
			if (is429 && currentSize > EMBED_BATCH_FLOOR) {
				currentSize = Math.max(EMBED_BATCH_FLOOR, Math.ceil(currentSize / 2));
				continue;
			}
			throw err;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function embedChunksWithUsage(
	chunks: { text: string }[],
	apiKey: string,
): Promise<EmbedResult> {
	const allEmbeddings: number[][] = [];
	let totalTokens = 0;
	let lastRequestAt: number | null = null;

	let i = 0;
	while (i < chunks.length) {
		// Pace by the gap since the previous batch's request started — the
		// very first request (lastRequestAt === null) always fires immediately,
		// so a single-chunk embed never picks up an added delay.
		if (lastRequestAt !== null) {
			const wait = EMBED_BATCH_PACING_MS - (Date.now() - lastRequestAt);
			if (wait > 0) await sleep(wait);
		}
		lastRequestAt = Date.now();

		const size = Math.min(EMBED_BATCH_SIZE, chunks.length - i);
		const { data, used } = await requestBatchWithHalving(
			chunks,
			i,
			size,
			apiKey,
		);
		for (const emb of data.embeddings) {
			allEmbeddings.push(emb.values);
		}
		totalTokens += data.usageMetadata?.promptTokenCount ?? 0;
		i += used;
	}

	return { embeddings: allEmbeddings, totalTokens };
}
