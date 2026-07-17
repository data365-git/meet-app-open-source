import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_PART_SIZE, takeFixedSizeParts } from "./upload";

// ── Shared helpers ──────────────────────────────────────────────────────────

// Deterministic MediaRecorder-like chunk stream: varying ~200-400KB chunks
// (the real recorder's `dataavailable` interval yields irregular sizes).
// Every byte encodes its absolute offset (mod 256) so byte-integrity can be
// checked later without depending on chunk boundaries.
const CHUNK_SIZE_PATTERN = [
	237_616, 198_432, 356_210, 301_045, 264_533, 312_890, 219_876,
];

function buildChunkStream(totalBytes: number): Uint8Array[] {
	const chunks: Uint8Array[] = [];
	let produced = 0;
	let i = 0;

	while (produced < totalBytes) {
		const size = CHUNK_SIZE_PATTERN[i % CHUNK_SIZE_PATTERN.length];
		const chunk = new Uint8Array(size);
		for (let b = 0; b < size; b++) chunk[b] = (produced + b) % 256;
		chunks.push(chunk);
		produced += size;
		i += 1;
	}

	return chunks;
}

function concatBytes(arrays: Uint8Array[]): Uint8Array {
	const total = arrays.reduce((sum, a) => sum + a.length, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const a of arrays) {
		out.set(a, offset);
		offset += a.length;
	}
	return out;
}

// vitest's `toEqual` does an element-by-element deep-equal, which is far too
// slow for multi-megabyte typed arrays (times out). Buffer.compare is a
// native memcmp and stays fast at these sizes.
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	return (
		Buffer.compare(
			Buffer.from(a.buffer, a.byteOffset, a.length),
			Buffer.from(b.buffer, b.byteOffset, b.length),
		) === 0
	);
}

// ── Pure part-slicing logic (takeFixedSizeParts) ────────────────────────────

describe("takeFixedSizeParts (pure part-slicing logic)", () => {
	it("produces equal-size non-trailing parts >= 5 MiB from a realistic MediaRecorder chunk stream", () => {
		const totalBytes = 60 * 1024 * 1024;
		const chunks = buildChunkStream(totalBytes);

		let buffer = new Uint8Array(0);
		const allParts: Uint8Array[] = [];

		for (const chunk of chunks) {
			const merged = new Uint8Array(buffer.length + chunk.length);
			merged.set(buffer, 0);
			merged.set(chunk, buffer.length);
			buffer = merged;

			const { parts, remainder } = takeFixedSizeParts(buffer, MIN_PART_SIZE);
			allParts.push(...parts);
			buffer = remainder;
		}

		expect(allParts.length).toBeGreaterThanOrEqual(2);
		for (const part of allParts) {
			expect(part.length).toBe(MIN_PART_SIZE);
			expect(part.length).toBeGreaterThanOrEqual(5 * 1024 * 1024);
		}
		// The trailing remainder is flushed separately at finalize and must stay
		// below partSize.
		expect(buffer.length).toBeLessThan(MIN_PART_SIZE);
	});

	it("slices a single oversized chunk (bigger than partSize) into multiple full parts", () => {
		const oversized = new Uint8Array(MIN_PART_SIZE * 3 + 1234);
		for (let i = 0; i < oversized.length; i++) oversized[i] = i % 256;

		const { parts, remainder } = takeFixedSizeParts(oversized, MIN_PART_SIZE);

		expect(parts.length).toBe(3);
		for (const part of parts) expect(part.length).toBe(MIN_PART_SIZE);
		expect(remainder.length).toBe(1234);
	});

	it("keeps the remainder below partSize and loses no bytes", () => {
		const buffer = new Uint8Array(MIN_PART_SIZE * 2 + 777);
		for (let i = 0; i < buffer.length; i++) buffer[i] = i % 256;

		const { parts, remainder } = takeFixedSizeParts(buffer, MIN_PART_SIZE);

		expect(remainder.length).toBeLessThan(MIN_PART_SIZE);
		expect(remainder.length).toBe(777);
		expect(parts.reduce((sum, p) => sum + p.length, 0) + remainder.length).toBe(
			buffer.length,
		);
	});

	it("reproduces the original bytes byte-for-byte, in order, when parts + remainder are concatenated", () => {
		const totalBytes = 12 * 1024 * 1024 + 555;
		const original = new Uint8Array(totalBytes);
		for (let i = 0; i < totalBytes; i++) original[i] = i % 256;

		const { parts, remainder } = takeFixedSizeParts(original, MIN_PART_SIZE);
		const reconstructed = concatBytes([...parts, remainder]);

		expect(reconstructed.length).toBe(original.length);
		expect(bytesEqual(reconstructed, original)).toBe(true);
	});
});

// ── Integration: the real handleChunk/finalizeUpload against a fake R2 ─────

function createFakeChromeStorage() {
	const store = new Map<string, unknown>();
	return {
		async get(key: string) {
			return { [key]: store.get(key) };
		},
		async set(items: Record<string, unknown>) {
			for (const [k, v] of Object.entries(items)) store.set(k, v);
		},
		async remove(key: string) {
			store.delete(key);
		},
	};
}

function jsonResponse(data: unknown): Response {
	return new Response(JSON.stringify(data), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

function createFakeFetch(onPut: (bytes: Uint8Array) => void) {
	let putCounter = 0;

	return async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = input.toString();
		const method = init?.method ?? "GET";

		if (url.includes("/api/upload/multipart/presign-part")) {
			return jsonResponse({
				presignedUrl: "https://fake-r2.example/put",
				provider: "r2",
			});
		}
		if (method === "PUT") {
			const body = init?.body;
			const bytes =
				body instanceof Uint8Array
					? body
					: new Uint8Array(await new Response(body as BodyInit).arrayBuffer());
			putCounter += 1;
			onPut(bytes);
			return new Response(null, {
				status: 200,
				headers: { ETag: `"etag-${putCounter}"` },
			});
		}
		if (url.includes("/api/upload/multipart/complete")) {
			return jsonResponse({
				location: undefined,
				success: true,
				fileKey: "file",
			});
		}
		if (url.includes("/api/upload/recording-complete")) {
			return jsonResponse({});
		}

		throw new Error(`Unhandled fetch in test: ${method} ${url}`);
	};
}

describe("handleChunk -> finalizeUpload (live R2 multipart invariant)", () => {
	beforeEach(() => {
		vi.stubGlobal("chrome", {
			storage: { local: createFakeChromeStorage() },
			runtime: { sendMessage: async () => undefined },
			tabs: { query: async () => [], sendMessage: async () => undefined },
			notifications: { create: () => undefined },
			alarms: { create: () => undefined, clear: () => undefined },
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uploads only equal-size non-trailing parts for a realistic recording, and never drops/reorders bytes", async () => {
		const { handleChunk, finalizeUpload } = await import("./upload");
		const { setState, setSettings } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-1",
			uploadId: "upload-1",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		// > 2 * MIN_PART_SIZE so the recording forces 2+ non-trailing parts.
		const totalBytes = 13 * 1024 * 1024;
		const chunks = buildChunkStream(totalBytes);
		const original = concatBytes(chunks);

		const putBodies: Uint8Array[] = [];
		vi.stubGlobal(
			"fetch",
			createFakeFetch((bytes) => putBodies.push(bytes)),
		);

		for (let i = 0; i < chunks.length; i++) {
			await handleChunk(chunks[i].buffer as ArrayBuffer, i, "video/webm");
		}
		await finalizeUpload();

		expect(putBodies.length).toBeGreaterThanOrEqual(2);

		const nonTrailing = putBodies.slice(0, -1);
		const trailing = putBodies[putBodies.length - 1];

		for (const part of nonTrailing) {
			expect(part.length).toBe(MIN_PART_SIZE);
		}
		expect(trailing.length).toBeLessThanOrEqual(MIN_PART_SIZE);

		// Byte integrity: concatenating uploaded parts in order must reproduce
		// the original recording exactly — no lost, duplicated, or reordered
		// bytes.
		const reconstructed = concatBytes(putBodies);
		expect(reconstructed.length).toBe(original.length);
		expect(bytesEqual(reconstructed, original)).toBe(true);
	});
});

// ── P1.6: a failed retry-drain must not strand a fully-uploadable recording ─

describe("finalizeUpload -> retryPendingUploads (P1.6 durable complete-after-drain)", () => {
	beforeEach(() => {
		vi.stubGlobal("chrome", {
			storage: { local: createFakeChromeStorage() },
			runtime: { sendMessage: async () => undefined },
			tabs: { query: async () => [], sendMessage: async () => undefined },
			notifications: { create: () => undefined },
			alarms: { create: () => undefined, clear: () => undefined },
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("enqueues a durable complete record when parts remain queued, and a later drain finishes the job (completeMultipart runs, recording lands)", async () => {
		const { handleChunk, finalizeUpload, retryPendingUploads } = await import(
			"./upload"
		);
		const { setState, setSettings, getState } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-p16",
			uploadId: "upload-p16",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		// Small recording: well under MIN_PART_SIZE but above MIN_VIABLE_BYTES
		// (10KB), so only the trailing "remaining" part gets uploaded at
		// finalize — the simplest way to force exactly one part through the
		// failure path below.
		const chunk = new Uint8Array(20_000);
		for (let i = 0; i < chunk.length; i++) chunk[i] = i % 256;
		await handleChunk(chunk.buffer as ArrayBuffer, 0, "video/webm");

		let putAttempts = 0;
		let completeMultipartCalls = 0;
		let recordingCompleteCalls = 0;

		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				const method = init?.method ?? "GET";

				if (url.includes("/api/upload/multipart/presign-part")) {
					return jsonResponse({
						presignedUrl: "https://fake-r2.example/put",
						provider: "r2",
					});
				}
				if (method === "PUT") {
					putAttempts += 1;
					// Fail the first two PUT attempts (finalizeUpload's own attempt, plus
					// its immediate in-pass retry via retryQueuedPartsForUpload) so the
					// part is still genuinely queued when finalizeUpload returns. The
					// third attempt (the LATER drain, simulating a subsequent alarm tick)
					// succeeds.
					if (putAttempts <= 2) {
						return new Response("boom", { status: 500 });
					}
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-final"' },
					});
				}
				if (url.includes("/api/upload/multipart/complete")) {
					completeMultipartCalls += 1;
					return jsonResponse({
						location: undefined,
						success: true,
						fileKey: "file",
					});
				}
				if (url.includes("/api/upload/recording-complete")) {
					recordingCompleteCalls += 1;
					return jsonResponse({});
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		await finalizeUpload();

		// The old (buggy) behaviour set kind:"error" here and never enqueued
		// anything durable — completeMultipart would never run again even after
		// a later successful drain. Assert the fix: state stays "uploading"
		// (durable, retryable), not "error".
		const midState = await getState();
		expect(midState.kind).toBe("uploading");
		expect(completeMultipartCalls).toBe(0);

		// Simulate time passing so the queued part's backoff has elapsed.
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 2000);

		// First later drain: the queued part succeeds; the durable "complete"
		// record defers one more pass since its sibling part item was still
		// present in the same queue snapshot.
		await retryPendingUploads();
		// Second later drain: no sibling parts remain, so the complete record
		// runs for real.
		await retryPendingUploads();

		expect(completeMultipartCalls).toBe(1);
		expect(recordingCompleteCalls).toBe(1);

		const finalState = await getState();
		expect(finalState.kind).toBe("complete");
		if (finalState.kind === "complete") {
			expect(finalState.shareUrl).toContain("vid-p16");
		}
	});
});

// ── P1.4: the dead-letter notification must not claim a local fallback ─────

describe("moveToDeadLetter notification (P1.4 honest messaging)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("never claims the recording was saved locally as a fallback once dead-lettered", async () => {
		const notifications: Array<{ title?: string; message?: string }> = [];

		vi.stubGlobal("chrome", {
			storage: { local: createFakeChromeStorage() },
			runtime: { sendMessage: async () => undefined },
			tabs: { query: async () => [], sendMessage: async () => undefined },
			notifications: {
				create: (a: unknown, b?: { title?: string; message?: string }) => {
					// upload.ts calls chrome.notifications.create(options) (no id arg)
					// for the dead-letter notification specifically.
					const opts = (b ?? a) as { title?: string; message?: string };
					notifications.push(opts);
				},
			},
			alarms: { create: () => undefined, clear: () => undefined },
		});

		const { handleChunk, finalizeUpload, retryPendingUploads } = await import(
			"./upload"
		);
		const { setState, setSettings } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-p14",
			uploadId: "upload-p14",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		const chunk = new Uint8Array(20_000);
		await handleChunk(chunk.buffer as ArrayBuffer, 0, "video/webm");

		// Every PUT fails permanently, driving the queued part all the way to
		// dead-letter (MAX_ATTEMPTS = 6 reschedules) rather than ever succeeding.
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				const method = init?.method ?? "GET";
				if (url.includes("/api/upload/multipart/presign-part")) {
					return jsonResponse({
						presignedUrl: "https://fake-r2.example/put",
						provider: "r2",
					});
				}
				if (method === "PUT") {
					return new Response("boom", { status: 500 });
				}
				if (url.includes("/api/upload/multipart/complete")) {
					// The P1.6 durable-complete record (enqueued alongside the failing
					// part) also gets attempted on each drain pass here; it must fail
					// too since the part it depends on never succeeds in this scenario.
					return new Response("boom", { status: 500 });
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		await finalizeUpload();

		vi.useFakeTimers();
		// BACKOFF_SECONDS = [1,4,16,64,256]; 6 total attempts dead-letters.
		const backoffsMs = [1000, 4000, 16000, 64000, 256000, 256000];
		for (const step of backoffsMs) {
			vi.setSystemTime(Date.now() + step);
			await retryPendingUploads();
		}

		expect(notifications.length).toBeGreaterThan(0);
		const deadLetterNotif = notifications.find((n) =>
			n.title?.includes("upload failed"),
		);
		expect(deadLetterNotif).toBeDefined();
		expect(deadLetterNotif?.message).not.toMatch(/saved locally/i);
		expect(deadLetterNotif?.message).toMatch(/lost|re-record|not.*recover/i);
	});
});

// ── M7: nextPartNumber for a persisted "uploading" state must not collide
// with a gap in already-uploaded part numbers ──────────────────────────────

describe("finalizeUpload nextPartNumber (M7 gapped-parts fix)", () => {
	beforeEach(() => {
		vi.stubGlobal("chrome", {
			storage: { local: createFakeChromeStorage() },
			runtime: { sendMessage: async () => undefined },
			tabs: { query: async () => [], sendMessage: async () => undefined },
			notifications: { create: () => undefined },
			alarms: { create: () => undefined, clear: () => undefined },
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses max(PartNumber)+1, not parts.length+1, so a gapped part list never produces a duplicate PartNumber", async () => {
		const { finalizeUpload } = await import("./upload");
		const { setState, setSettings } = await import("./state");

		await setSettings({ apiKey: "test-key" });

		// Parts [1, 2, 4]: part 3 is missing (e.g. still queued elsewhere from a
		// prior crash). parts.length is 3, so the OLD buggy formula
		// (parts.length + 1 = 4) would assign the trailing remainder PartNumber
		// 4 — colliding with the part 4 that's already in the array.
		await setState({
			kind: "uploading",
			videoId: "vid-m7",
			uploadId: "upload-m7",
			parts: [
				{ PartNumber: 1, ETag: "etag-1" },
				{ PartNumber: 2, ETag: "etag-2" },
				{ PartNumber: 4, ETag: "etag-4" },
			],
			totalBytes: 4 * MIN_PART_SIZE + 20_000,
			uploadedBytes: 3 * MIN_PART_SIZE,
		});

		// A persisted pending buffer (the trailing remainder) for this upload —
		// finalizeUpload restores and uploads this as the "remaining" part.
		const remainderBytes = new Uint8Array(20_000);
		for (let i = 0; i < remainderBytes.length; i++) remainderBytes[i] = i % 256;
		await chrome.storage.local.set({
			"pendingBuffer:upload-m7": Buffer.from(remainderBytes).toString("base64"),
		});

		const presignedPartNumbers: number[] = [];
		let completedParts:
			| Array<{ partNumber: number; etag: string; size: number }>
			| undefined;

		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				const method = init?.method ?? "GET";
				if (url.includes("/api/upload/multipart/presign-part")) {
					const body = JSON.parse(String(init?.body)) as {
						partNumber: number;
					};
					presignedPartNumbers.push(body.partNumber);
					return jsonResponse({
						presignedUrl: "https://fake-r2.example/put",
						provider: "r2",
					});
				}
				if (method === "PUT") {
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-remainder"' },
					});
				}
				if (url.includes("/api/upload/multipart/complete")) {
					const body = JSON.parse(String(init?.body)) as {
						parts: Array<{ partNumber: number; etag: string; size: number }>;
					};
					completedParts = body.parts;
					return jsonResponse({
						location: undefined,
						success: true,
						fileKey: "file",
					});
				}
				if (url.includes("/api/upload/recording-complete")) {
					return jsonResponse({});
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		await finalizeUpload();

		// The remainder must be presigned/uploaded as PartNumber 5 (max(1,2,4)+1),
		// never 4 (parts.length+1) — which would collide with the existing part 4.
		expect(presignedPartNumbers).toEqual([5]);

		const partNumbers = completedParts
			?.map((p) => p.partNumber)
			.sort((a, b) => a - b);
		expect(partNumbers).toEqual([1, 2, 4, 5]);
		// No duplicate PartNumbers in the final completeMultipart call.
		expect(new Set(partNumbers).size).toBe(partNumbers?.length);
	});
});
