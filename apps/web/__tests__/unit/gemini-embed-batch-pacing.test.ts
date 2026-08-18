import { afterEach, describe, expect, it, vi } from "vitest";

// SCOPE (docs/plans/2026-08-18-ai-chat-429-SCOPE.md): a transcript with no
// index yet embeds 100 documents in ONE batchEmbedContents request and Google
// answers 429 RESOURCE_EXHAUSTED (a per-minute limit). This shrinks the batch,
// paces successive batches, and halves a 429'd batch down to a floor before
// giving up. Stubs `fetch` — never calls Google.
import {
	EMBED_BATCH_FLOOR,
	EMBED_BATCH_PACING_MS,
	EMBED_BATCH_SIZE,
	embedChunksWithUsage,
} from "@/lib/gemini-embed";

function makeChunks(n: number): { text: string }[] {
	return Array.from({ length: n }, (_, i) => ({ text: `chunk ${i}` }));
}

function okResponse(count: number) {
	return {
		ok: true,
		json: async () => ({
			embeddings: Array.from({ length: count }, () => ({ values: [0.1] })),
			usageMetadata: { promptTokenCount: count },
		}),
	};
}

function rateLimitedResponse(retryDelay?: string) {
	const body = retryDelay
		? JSON.stringify({
				error: {
					code: 429,
					status: "RESOURCE_EXHAUSTED",
					details: [
						{
							"@type": "type.googleapis.com/google.rpc.RetryInfo",
							retryDelay,
						},
					],
				},
			})
		: JSON.stringify({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } });
	return {
		ok: false,
		status: 429,
		text: async () => body,
	};
}

function countDocs(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): number {
	const [, init] = fetchMock.mock.calls[callIndex] as [string, RequestInit];
	const body = JSON.parse(init.body as string);
	return body.requests.length;
}

describe("embedChunksWithUsage batching, pacing and 429 halving", () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("never sends more documents than EMBED_BATCH_SIZE in one request", async () => {
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string);
			expect(body.requests.length).toBeLessThanOrEqual(EMBED_BATCH_SIZE);
			return okResponse(body.requests.length);
		});
		vi.stubGlobal("fetch", fetchMock);

		const chunks = makeChunks(EMBED_BATCH_SIZE * 2 + 5);
		const result = await embedChunksWithUsage(chunks, "key");

		expect(result.embeddings).toHaveLength(chunks.length);
		for (let i = 0; i < fetchMock.mock.calls.length; i++) {
			expect(countDocs(fetchMock, i)).toBeLessThanOrEqual(EMBED_BATCH_SIZE);
		}
	});

	it("paces successive batches by at least EMBED_BATCH_PACING_MS, but a single-chunk embed issues immediately", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string);
			return okResponse(body.requests.length);
		});
		vi.stubGlobal("fetch", fetchMock);

		// Single-chunk embed (the one-sentence chat question): resolves with
		// zero real waiting — advancing 0ms is enough.
		const single = embedChunksWithUsage(makeChunks(1), "key");
		await vi.advanceTimersByTimeAsync(0);
		await single;
		expect(fetchMock).toHaveBeenCalledTimes(1);

		fetchMock.mockClear();

		// Multi-batch embed: the second batch must not fire before the pacing
		// interval has elapsed.
		const multi = embedChunksWithUsage(
			makeChunks(EMBED_BATCH_SIZE + 1),
			"key",
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(fetchMock).toHaveBeenCalledTimes(1); // first batch fires immediately

		await vi.advanceTimersByTimeAsync(EMBED_BATCH_PACING_MS - 100);
		expect(fetchMock).toHaveBeenCalledTimes(1); // still paced

		await vi.advanceTimersByTimeAsync(200);
		expect(fetchMock).toHaveBeenCalledTimes(2); // pacing interval elapsed

		await multi;
	});

	it("honours a retryDelay of 34s instead of the old 8s ceiling", async () => {
		vi.useFakeTimers();
		let attempt = 0;
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			attempt++;
			if (attempt === 1) return rateLimitedResponse("34s");
			const body = JSON.parse(init.body as string);
			return okResponse(body.requests.length);
		});
		vi.stubGlobal("fetch", fetchMock);

		const promise = embedChunksWithUsage(makeChunks(1), "key");

		await vi.advanceTimersByTimeAsync(8500); // old ceiling + jitter: must NOT have retried yet
		expect(fetchMock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(26000); // reach ~34.5s total
		await promise;
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("halves a batch that 429s twice, and respects the floor", async () => {
		vi.useFakeTimers();
		const seenSizes: number[] = [];
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string);
			seenSizes.push(body.requests.length);
			if (body.requests.length > EMBED_BATCH_FLOOR) {
				return rateLimitedResponse();
			}
			return okResponse(body.requests.length);
		});
		vi.stubGlobal("fetch", fetchMock);

		const promise = embedChunksWithUsage(makeChunks(EMBED_BATCH_SIZE), "key");
		// Each 429 inside requestBatch is retried once by withGeminiRetry (8s
		// ceiling) before the caller halves the window; give it plenty of time.
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		const result = await promise;

		expect(result.embeddings).toHaveLength(EMBED_BATCH_SIZE);
		expect(Math.min(...seenSizes)).toBeGreaterThanOrEqual(EMBED_BATCH_FLOOR);
		expect(seenSizes).toContain(EMBED_BATCH_FLOOR);
	}, 15000);

	it("indexes 500 chunks with zero surfaced errors through a transport that rejects oversized or too-frequent requests", async () => {
		vi.useFakeTimers();
		let lastRequestAt: number | null = null;
		const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
			const body = JSON.parse(init.body as string);
			const now = Date.now();
			if (body.requests.length > EMBED_BATCH_SIZE) {
				return rateLimitedResponse();
			}
			if (lastRequestAt !== null && now - lastRequestAt < EMBED_BATCH_PACING_MS) {
				return rateLimitedResponse();
			}
			lastRequestAt = now;
			return okResponse(body.requests.length);
		});
		vi.stubGlobal("fetch", fetchMock);

		const promise = embedChunksWithUsage(makeChunks(500), "key");
		await vi.advanceTimersByTimeAsync(2 * 60_000);
		const result = await promise;

		expect(result.embeddings).toHaveLength(500);
	}, 15000);
});
