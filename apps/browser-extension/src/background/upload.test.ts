import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	MIN_PART_SIZE,
	PART_MAX_ATTEMPTS,
	computeDurationInSecs,
	takeFixedSizeParts,
} from "./upload";

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

// ── Wave 0: computeDurationInSecs (pure fn) ─────────────────────────────────
//
// Elapsed recording time in whole seconds, excluding paused spans — feeds
// durationInSecs on the complete request (pre-AI seek bar). Pure and
// side-effect-free apart from reading Date.now(), so these tests pin the
// clock with fake timers rather than touching chrome/fetch at all.

describe("computeDurationInSecs (pure fn)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("running with no pause returns the whole elapsed span", () => {
		const now = Date.now();
		vi.useFakeTimers();
		vi.setSystemTime(now);

		const startedAt = now - 5000;
		expect(computeDurationInSecs(startedAt, 0, false, undefined)).toBe(5);
	});

	it("subtracts accumulated paused time from prior pause/resume cycles", () => {
		const now = Date.now();
		vi.useFakeTimers();
		vi.setSystemTime(now);

		const startedAt = now - 10_000;
		// 10s wall-clock span, 3s of which was spent paused (already resumed) —
		// the recorded media only covers the remaining 7s.
		expect(computeDurationInSecs(startedAt, 3000, false, undefined)).toBe(7);
	});

	it("also excludes the currently-open pause span when still paused at stop", () => {
		const now = Date.now();
		vi.useFakeTimers();
		vi.setSystemTime(now);

		const startedAt = now - 10_000;
		const pausedAt = now - 1000; // this pause began 1s ago and never resumed
		// 10s span, 2s from earlier resumed pauses + 1s from the still-open one.
		expect(computeDurationInSecs(startedAt, 2000, true, pausedAt)).toBe(7);
	});

	it("never returns a negative number when pausedAccumMs exceeds the elapsed span", () => {
		const now = Date.now();
		vi.useFakeTimers();
		vi.setSystemTime(now);

		const startedAt = now - 1000;
		// Bogus/adversarial input: more "paused" time recorded than actually
		// elapsed. A negative or zero result must never reach the server.
		expect(computeDurationInSecs(startedAt, 5000, false, undefined)).toBeUndefined();
	});

	// MEASURED regression (2026-08-05): on a throttled 800 kbit/s soak the
	// finalize ran 5 minutes after the user pressed Stop — it waits behind the
	// whole upload backlog — and a 361-second recording was filed as 663 seconds.
	// The media ends when the recorder stops producing it, not when the last byte
	// finally reaches the server.
	it("measures to the END OF THE MEDIA, not to a finalize the slow upload delayed", () => {
		const now = Date.now();
		vi.useFakeTimers();
		vi.setSystemTime(now);

		const startedAt = now - 663_000; // finalize is running 663s after start…
		const endedAt = now - 302_000; // …but the recorder stopped 361s in.
		expect(computeDurationInSecs(startedAt, 0, false, undefined, endedAt)).toBe(
			361,
		);
		// Without the end-of-media stamp the old behaviour is preserved exactly.
		expect(computeDurationInSecs(startedAt, 0, false, undefined)).toBe(663);
	});

	it("ignores a missing or garbage end-of-media stamp instead of returning NaN", () => {
		const now = Date.now();
		vi.useFakeTimers();
		vi.setSystemTime(now);

		const startedAt = now - 5000;
		expect(
			computeDurationInSecs(startedAt, 0, false, undefined, Number.NaN),
		).toBe(5);
		expect(computeDurationInSecs(startedAt, 0, false, undefined, 0)).toBe(5);
	});

	it("never returns NaN (or any value) on a garbage/missing startedAt", () => {
		const result = computeDurationInSecs(
			undefined as unknown as number,
			undefined,
			undefined,
			undefined,
		);
		expect(result).toBeUndefined();
		expect(Number.isNaN(result)).toBe(false);
	});
});

// ── Integration: the real handleChunk/finalizeUpload against a fake R2 ─────

const RETRY_QUEUE_KEY = "capExtRetryQueue";

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

// ── Wave 0: durationInSecs threading (finalizeUpload → completeMultipart /
// the durable retry-queue "complete" payload) ──────────────────────────────
//
// The extension's complete request used to omit durationInSecs entirely, so
// the seek bar had no duration until the AI pipeline eventually backfilled
// it. finalizeUpload now accepts an explicit duration (the caller — sw.ts
// finalizeRecording — computes it from the "recording" state before that
// state is gone) and falls back to computing it itself when still called
// while state.kind is "recording" (e.g. the RECORDER_ERROR path).

describe("Wave 0 — durationInSecs threading", () => {
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

	it("finalizeUpload(durationInSecs) includes it in the completeMultipart request body", async () => {
		const { handleChunk, finalizeUpload } = await import("./upload");
		const { setState, setSettings } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-duration",
			uploadId: "upload-duration",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		// Below MIN_PART_SIZE, above MIN_VIABLE_BYTES: handleChunk records no
		// part, so the entire buffer flushes as the finalize-time remainder and
		// completeMultipart runs immediately (no retry-queue detour).
		const chunk = new Uint8Array(20_000);
		await handleChunk(chunk.buffer as ArrayBuffer, 0, "video/webm");

		let completeBody: Record<string, unknown> | null = null;
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
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-1"' },
					});
				}
				if (url.includes("/api/upload/multipart/complete")) {
					completeBody = JSON.parse(init?.body as string);
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

		await finalizeUpload(42);

		expect(completeBody).not.toBeNull();
		expect(completeBody!.durationInSecs).toBe(42);
	});

	it("omits durationInSecs from the request when no positive elapsed value is available", async () => {
		const { handleChunk, finalizeUpload } = await import("./upload");
		const { setState, setSettings } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-duration-none",
			uploadId: "upload-duration-none",
			// In the future: guarantees a non-positive elapsed span regardless of
			// how much real wall-clock time this test itself takes to run, so the
			// internal fallback in finalizeUpload (no explicit arg passed below)
			// computes undefined deterministically rather than racing the clock.
			startedAt: Date.now() + 60_000,
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		const chunk = new Uint8Array(20_000);
		await handleChunk(chunk.buffer as ArrayBuffer, 0, "video/webm");

		let completeBody: Record<string, unknown> | null = null;
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
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-1"' },
					});
				}
				if (url.includes("/api/upload/multipart/complete")) {
					completeBody = JSON.parse(init?.body as string);
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

		// No explicit duration passed — same call shape as the RECORDER_ERROR
		// caller in sw.ts.
		await finalizeUpload();

		expect(completeBody).not.toBeNull();
		expect(completeBody).not.toHaveProperty("durationInSecs");
	});

	it("persists durationInSecs into the durable retry-queue 'complete' payload when parts are still queued (crash-durability path)", async () => {
		const { handleChunk, finalizeUpload } = await import("./upload");
		const { setState, setSettings } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-duration-durable",
			uploadId: "upload-duration-durable",
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

		let putAttempts = 0;
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
					// Same forcing technique as the P1.6 test above: fail long enough
					// that the part is still genuinely queued when finalizeUpload
					// returns, so it takes the deferred-"complete" durable path
					// instead of completing inline.
					if (putAttempts <= 2) {
						return new Response("boom", { status: 500 });
					}
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-final"' },
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
			},
		);

		await finalizeUpload(99);

		const stored = await chrome.storage.local.get(RETRY_QUEUE_KEY);
		const queue = stored[RETRY_QUEUE_KEY] as
			| Array<{ kind: string; payload: Record<string, unknown> }>
			| undefined;
		const completeItem = queue?.find((item) => item.kind === "complete");

		expect(completeItem).toBeDefined();
		expect(completeItem!.payload.durationInSecs).toBe(99);
	});
});

// ── R1: the finalize-time remainder must survive into the deferred complete ─
// A remainder that uploads successfully at finalize while a sibling full part
// is still queued must be persisted into durable state, or the later drain
// (which rebuilds the part list from live state.parts) completes the multipart
// WITHOUT it and silently truncates the tail of the video.

describe("finalizeUpload remainder durability (R1 tail-truncation)", () => {
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

	it("includes the finalize-time remainder in the deferred complete when a sibling part was still queued", async () => {
		const { handleChunk, finalizeUpload, retryPendingUploads } = await import(
			"./upload"
		);
		const { setState, setSettings } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-r1",
			uploadId: "upload-r1",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		// One full 5 MiB part (uploaded during recording) + a < 5 MiB remainder
		// (uploaded at finalize).
		const totalBytes = MIN_PART_SIZE + 20_000;
		const chunks = buildChunkStream(totalBytes);

		let fullPartAttempts = 0;
		let completeParts: Array<{ partNumber: number; etag: string }> = [];
		let completeMultipartCalls = 0;

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
					const body = init?.body;
					const bytes =
						body instanceof Uint8Array
							? body
							: new Uint8Array(
									await new Response(body as BodyInit).arrayBuffer(),
								);
					// The full 5 MiB part: fail its first two PUTs (the streaming
					// upload + finalize's in-pass retry) so it stays genuinely queued
					// when finalize returns → P1.6 path; succeed the third (later drain).
					if (bytes.length === MIN_PART_SIZE) {
						fullPartAttempts += 1;
						if (fullPartAttempts <= 2) {
							return new Response("boom", { status: 500 });
						}
						return new Response(null, {
							status: 200,
							headers: { ETag: '"etag-full"' },
						});
					}
					// The remainder (< 5 MiB) uploads once at finalize and succeeds.
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-remainder"' },
					});
				}
				if (url.includes("/api/upload/multipart/complete")) {
					completeMultipartCalls += 1;
					const parsed = JSON.parse(String(init?.body)) as {
						parts: Array<{ partNumber: number; etag: string }>;
					};
					completeParts = parsed.parts;
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

		for (let i = 0; i < chunks.length; i++) {
			await handleChunk(chunks[i].buffer as ArrayBuffer, i, "video/webm");
		}
		await finalizeUpload();

		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 2000);
		// First drain: the queued full part succeeds; complete defers one pass.
		await retryPendingUploads();
		// Second drain: no sibling parts remain → complete runs for real.
		await retryPendingUploads();

		expect(completeMultipartCalls).toBe(1);
		// The bug: completeParts would contain ONLY the full part — the remainder,
		// uploaded to R2 at finalize, was dropped from the completed multipart.
		const etags = completeParts.map((p) => p.etag);
		expect(etags).toContain("etag-remainder");
		expect(etags).toContain("etag-full");
		expect(completeParts.length).toBe(2);
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
		// Drive past PART_MAX_ATTEMPTS (R6 raised the retry horizon so a long
		// outage no longer loses a recording) until the part finally dead-letters.
		for (let i = 0; i < PART_MAX_ATTEMPTS + 2; i++) {
			const step = 256000;
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

// ── R4: a dead-lettered part must block the deferred complete — never stamp a
// video with a permanent hole as "complete" (Fable audit) ───────────────────

describe("retryPendingUploads dead-letter guard (R4 holed-complete)", () => {
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

	it("does not complete (or stamp ✓) a multipart whose part was permanently dead-lettered", async () => {
		const { handleChunk, finalizeUpload, retryPendingUploads } = await import(
			"./upload"
		);
		const { setState, setSettings, getState } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-r4",
			uploadId: "upload-r4",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		// Two full 5 MiB parts. Part 1 uploads fine; part 2's PUT always fails, so
		// it drains through MAX_ATTEMPTS and dead-letters — leaving the multipart
		// permanently missing its middle 5 MiB.
		const totalBytes = 2 * MIN_PART_SIZE;
		const chunks = buildChunkStream(totalBytes);

		let completeMultipartCalls = 0;
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				const method = init?.method ?? "GET";
				if (url.includes("/api/upload/multipart/presign-part")) {
					const body = JSON.parse(String(init?.body)) as { partNumber: number };
					return jsonResponse({
						presignedUrl: `https://fake-r2.example/put?part=${body.partNumber}`,
						provider: "r2",
					});
				}
				if (method === "PUT") {
					const part = new URL(url).searchParams.get("part");
					if (part === "2") {
						return new Response("boom", { status: 500 });
					}
					return new Response(null, {
						status: 200,
						headers: { ETag: `"etag-${part}"` },
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
					return jsonResponse({});
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		for (let i = 0; i < chunks.length; i++) {
			await handleChunk(chunks[i].buffer as ArrayBuffer, i, "video/webm");
		}
		await finalizeUpload();

		vi.useFakeTimers();
		// Drain past MAX_ATTEMPTS so part 2 dead-letters, then a couple more passes
		// so the deferred complete record is actually processed post-dead-letter.
		// Drive past PART_MAX_ATTEMPTS so part 2 dead-letters, then a couple more
		// passes so the deferred complete is processed post-dead-letter.
		for (let i = 0; i < PART_MAX_ATTEMPTS + 4; i++) {
			const step = 256000;
			vi.setSystemTime(Date.now() + step);
			await retryPendingUploads();
		}

		// The bug: completeMultipart runs on the surviving [part1] list (R2 accepts
		// the gap) and the recording is stamped "complete" with a share link,
		// contradicting the dead-letter "lost" notification. The fix drops the
		// complete: no completeMultipart, terminal error state preserved.
		expect(completeMultipartCalls).toBe(0);
		const finalState = await getState();
		expect(finalState.kind).toBe("error");
		// This one walks a part all the way to dead-letter through the REAL
		// backoff waits, so it is by far the slowest in the file: measured 17.5s on
		// an idle machine against the suite's 20s ceiling. That margin is not a
		// margin — it timed out twice on 2026-07-20 while other work shared the
		// CPU, once in isolation, and a red suite blocks every commit through the
		// gate. Raising the ceiling for THIS test only keeps the global 20s signal
		// tight for everything else, and weakens no assertion: a genuinely hung
		// retry loop still fails, just at 60s.
	}, 60_000);
});

// ── R6: a temporary outage must NOT permanently lose a fully-uploaded
// recording — the "complete" item has no bytes left to lose, so it must keep
// retrying far past the old flat 6-attempt (~10 min) death clock ───────────

describe("retry horizon for finalization (R6 outage must not lose a saved recording)", () => {
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

	it("keeps retrying a queued complete through a long outage and finishes the recording when the server returns", async () => {
		const { retryPendingUploads } = await import("./upload");
		const { setState, setSettings, getState } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		// Every byte is already in R2; only the finalize call is left.
		await setState({
			kind: "uploading",
			videoId: "vid-r6",
			uploadId: "upload-r6",
			parts: [{ PartNumber: 1, ETag: '"e1"' }],
			totalBytes: MIN_PART_SIZE,
			uploadedBytes: MIN_PART_SIZE,
		});
		await chrome.storage.local.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "complete",
					payload: {
						uploadId: "upload-r6",
						videoId: "vid-r6",
						parts: [{ partNumber: 1, etag: "e1", size: 0 }],
					},
					attempts: 0,
					nextRetryAt: Date.now() - 1000,
				},
			],
		});

		// The server is down for 15 drain passes — far longer than the old
		// 6-attempt horizon — then comes back.
		const OUTAGE_PASSES = 15;
		let completeAttempts = 0;
		let recordingCompleteCalls = 0;
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				if (url.includes("/api/upload/multipart/complete")) {
					completeAttempts += 1;
					if (completeAttempts <= OUTAGE_PASSES) {
						return new Response("gateway down", { status: 502 });
					}
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
				throw new Error(`Unhandled fetch in test: ${url}`);
			},
		);

		vi.useFakeTimers();
		for (let i = 0; i < OUTAGE_PASSES + 5; i++) {
			vi.setSystemTime(Date.now() + 256_000);
			await retryPendingUploads();
		}

		// The bug: after 6 failures the complete dead-lettered and the recording
		// was declared lost ("please re-record") even though every byte was safely
		// in R2 and the server came back minutes later.
		expect(completeAttempts).toBeGreaterThan(OUTAGE_PASSES);
		expect(recordingCompleteCalls).toBe(1);
		const finalState = await getState();
		expect(finalState.kind).toBe("complete");
	});
});

// ── R7: a part PUT that resolves after the user cancelled and started a NEW
// recording must not poison the new recording's state ──────────────────────

describe("handleChunk identity guard (R7 cross-recording poisoning)", () => {
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

	it("does not write the old upload's part into a NEW recording started during the PUT", async () => {
		const { handleChunk } = await import("./upload");
		const { setState, setSettings, getState } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-old",
			uploadId: "upload-old",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		// While the old recording's part is mid-PUT, the user cancels and starts a
		// NEW meeting (CANCEL / RECORDER_STARTED both write state outside
		// enqueueRecorder, so this interleaving is real).
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
					await setState({
						kind: "recording",
						mode: "instruction",
						videoId: "vid-new",
						uploadId: "upload-new",
						startedAt: Date.now(),
						parts: [],
						nextPartNumber: 1,
						totalBytes: 0,
						uploadedBytes: 0,
						mime: "video/webm",
						paused: false,
					});
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-old"' },
					});
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		const chunk = new Uint8Array(MIN_PART_SIZE);
		await handleChunk(chunk.buffer as ArrayBuffer, 0, "video/webm");

		const finalState = await getState();
		expect(finalState.kind).toBe("recording");
		if (finalState.kind === "recording") {
			// The bug: the old upload's part (and a bumped nextPartNumber) landed in
			// the NEW recording, giving it a foreign, non-sequential part list that
			// can never complete — the new meeting is lost.
			expect(finalState.videoId).toBe("vid-new");
			expect(finalState.parts).toHaveLength(0);
			expect(finalState.nextPartNumber).toBe(1);
		}
	});
});

// ── R10: a pending-buffer persist failure must not discard the parts already
// sliced out of the buffer (silent mid-video hole) ─────────────────────────

describe("handleChunk persist failure (R10 sliced parts must survive)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("still uploads the already-sliced full part when persisting the remainder fails", async () => {
		// Storage that fails ONLY for the pending-buffer key — state writes still
		// work, exactly like a quota/IO error hitting the large base64 blob.
		const store = new Map<string, unknown>();
		vi.stubGlobal("chrome", {
			storage: {
				local: {
					async get(key: string) {
						return { [key]: store.get(key) };
					},
					async set(items: Record<string, unknown>) {
						for (const [k, v] of Object.entries(items)) {
							if (k.startsWith("pendingBuffer:")) {
								throw new Error("QUOTA_BYTES quota exceeded");
							}
							store.set(k, v);
						}
					},
					async remove(key: string) {
						store.delete(key);
					},
				},
			},
			runtime: { sendMessage: async () => undefined },
			tabs: { query: async () => [], sendMessage: async () => undefined },
			notifications: { create: () => undefined },
			alarms: { create: () => undefined, clear: () => undefined },
		});

		const { handleChunk } = await import("./upload");
		const { setState, setSettings } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-r10",
			uploadId: "upload-r10",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		const putBodies: Uint8Array[] = [];
		vi.stubGlobal(
			"fetch",
			createFakeFetch((bytes) => putBodies.push(bytes)),
		);

		// Exactly one full part's worth — it is sliced out of the buffer BEFORE
		// the (failing) persist.
		const chunk = new Uint8Array(MIN_PART_SIZE);
		await handleChunk(chunk.buffer as ArrayBuffer, 0, "video/webm");

		// The bug: the persist threw, handleChunk unwound, and the already-sliced
		// 5 MiB part was never uploaded and never queued — a silent hole that R2
		// happily accepts (part-number gaps are legal).
		expect(putBodies).toHaveLength(1);
		expect(putBodies[0].length).toBe(MIN_PART_SIZE);
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

// ── Fix #1: the retry-drain's "complete" branch must not stomp a NEWER
// recording's live state (adversarial-review finding, recording-loss path A)
// ───────────────────────────────────────────────────────────────────────────

describe("retryPendingUploads drain guard (fix #1: stale complete must not stomp a newer recording)", () => {
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

	it("closes the loss path: a stale queued complete for OLD video A must not stomp NEW video B's live 'recording' state, and B keeps working afterwards", async () => {
		const { retryPendingUploads, handleChunk, finalizeUpload } = await import(
			"./upload"
		);
		const { setState, setSettings, getState } = await import("./state");

		await setSettings({ apiKey: "test-key" });

		// A NEW recording (B) is actively in progress.
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-B",
			uploadId: "upload-B",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		// A stale "complete" retry item for an OLDER recording (A) is queued —
		// its completeMultipart failed once, and only succeeds on this later
		// drain pass, well after B started recording.
		await chrome.storage.local.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "complete",
					payload: { uploadId: "upload-A", videoId: "vid-A" },
					attempts: 0,
					nextRetryAt: Date.now() - 1000,
				},
			],
		});

		let completeMultipartCalls = 0;
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
					return new Response(null, {
						status: 200,
						headers: { ETag: '"etag-x"' },
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
					return jsonResponse({});
				}
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		await retryPendingUploads();

		// The stale item for A completed for real on the wire...
		expect(completeMultipartCalls).toBe(1);
		// ...but B's live "recording" state must survive untouched — NOT be
		// stomped to "complete" for the wrong (old) video.
		const midState = await getState();
		expect(midState.kind).toBe("recording");
		if (midState.kind === "recording") {
			expect(midState.videoId).toBe("vid-B");
		}

		// B must still be fully functional afterwards: chunks upload and
		// finalize completes for B — the new meeting was not silently lost
		// behind a stale ✓ badge.
		const chunk = new Uint8Array(20_000);
		for (let i = 0; i < chunk.length; i++) chunk[i] = i % 256;
		await handleChunk(chunk.buffer as ArrayBuffer, 0, "video/webm");
		await finalizeUpload();

		const finalState = await getState();
		expect(finalState.kind).toBe("complete");
		if (finalState.kind === "complete") {
			expect(finalState.videoId).toBe("vid-B");
		}
	});

	it("legitimate case: a queued complete for the SAME video A that live state is 'uploading' for still lands as 'complete'", async () => {
		const { retryPendingUploads } = await import("./upload");
		const { setState, setSettings, getState } = await import("./state");

		await setSettings({ apiKey: "test-key" });

		await setState({
			kind: "uploading",
			videoId: "vid-A",
			uploadId: "upload-A",
			parts: [{ PartNumber: 1, ETag: "etag-1" }],
			totalBytes: MIN_PART_SIZE,
			uploadedBytes: MIN_PART_SIZE,
		});

		await chrome.storage.local.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "complete",
					payload: { uploadId: "upload-A", videoId: "vid-A" },
					attempts: 0,
					nextRetryAt: Date.now() - 1000,
				},
			],
		});

		let completeMultipartParts:
			| Array<{ partNumber: number; etag: string; size: number }>
			| undefined;
		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				if (url.includes("/api/upload/multipart/complete")) {
					const body = JSON.parse(String(init?.body)) as {
						parts: Array<{ partNumber: number; etag: string; size: number }>;
					};
					completeMultipartParts = body.parts;
					return jsonResponse({
						location: undefined,
						success: true,
						fileKey: "file",
					});
				}
				if (url.includes("/api/upload/recording-complete")) {
					return jsonResponse({});
				}
				throw new Error(`Unhandled fetch in test: ${url}`);
			},
		);

		await retryPendingUploads();

		// Proves the live-state read path: this queued item carries no parts
		// snapshot, so completeMultipart's parts must come from the live
		// "uploading" state.
		expect(completeMultipartParts?.map((p) => p.partNumber)).toEqual([1]);

		const finalState = await getState();
		expect(finalState.kind).toBe("complete");
		if (finalState.kind === "complete") {
			expect(finalState.videoId).toBe("vid-A");
			expect(finalState.shareUrl).toContain("vid-A");
		}
	});

	it("error→complete case: an 'error' state carrying previousVideoId A is cleared to 'complete' once the queued complete for A lands", async () => {
		const { retryPendingUploads } = await import("./upload");
		const { setState, setSettings, getState } = await import("./state");

		await setSettings({ apiKey: "test-key" });

		// This is what finalizeUpload's completeMultipart-failure catch block
		// leaves behind: an "error" state plus a durable retry item carrying its
		// own parts snapshot (see upload.ts's legacy completeMultipart-failure
		// path).
		await setState({
			kind: "error",
			reason: "Upload finalization failed: boom",
			recoverable: true,
			previousVideoId: "vid-A",
		});

		await chrome.storage.local.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "complete",
					payload: {
						uploadId: "upload-A",
						videoId: "vid-A",
						parts: [{ partNumber: 1, etag: "etag-1", size: 0 }],
					},
					attempts: 0,
					nextRetryAt: Date.now() - 1000,
				},
			],
		});

		vi.stubGlobal("fetch", async (input: string | URL | Request) => {
			const url = input.toString();
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
			throw new Error(`Unhandled fetch in test: ${url}`);
		});

		await retryPendingUploads();

		const finalState = await getState();
		// The legacy path would otherwise leave the user staring at a failure
		// banner for a recording that has, in fact, just been saved.
		expect(finalState.kind).toBe("complete");
		if (finalState.kind === "complete") {
			expect(finalState.videoId).toBe("vid-A");
		}
	});
});

// ── Fix #2b: dead-lettering an OLD item must not stomp a NEWER recording's
// live state either (the same stomp risk as fix #1, via moveToDeadLetter) ──

describe("moveToDeadLetter drain guard (fix #2b: dead-lettering an old item must not stomp a newer recording)", () => {
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

	it("does not stomp a NEWER upload's 'uploading' state when an unrelated OLD item exhausts retries and dead-letters", async () => {
		const { retryPendingUploads } = await import("./upload");
		const { setState, setSettings, getState } = await import("./state");

		await setSettings({ apiKey: "test-key" });

		// A DIFFERENT, newer upload (B) is currently finalizing — this is the
		// only live kind moveToDeadLetter's release ever touches (uploading /
		// finishing), so it's the shape that can actually be stomped: a
		// "recording" B is already safe by the kind check alone, regardless of
		// the videoId guard, so it wouldn't exercise this fix.
		await setState({
			kind: "uploading",
			videoId: "vid-B2",
			uploadId: "upload-B2",
			parts: [],
			totalBytes: 20_000,
			uploadedBytes: 20_000,
		});

		// An UNRELATED OLD item for video A is one failure away from
		// MAX_ATTEMPTS — this drain pass exhausts it and dead-letters.
		await chrome.storage.local.set({
			[RETRY_QUEUE_KEY]: [
				{
					kind: "part",
					payload: {
						partNumber: 1,
						videoId: "vid-A2",
						uploadId: "upload-A2",
						partDataBase64: Buffer.from("old-part-bytes").toString("base64"),
					},
					attempts: 5,
					nextRetryAt: Date.now() - 1000,
				},
			],
		});

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
				throw new Error(`Unhandled fetch in test: ${method} ${url}`);
			},
		);

		await retryPendingUploads();

		// B's live "uploading" state must survive untouched — the dead-letter
		// release must never stomp an upload it doesn't belong to, even though
		// both share the "uploading" kind.
		const finalState = await getState();
		expect(finalState.kind).toBe("uploading");
		if (finalState.kind === "uploading") {
			expect(finalState.videoId).toBe("vid-B2");
		}
	});
});

// ── H1: durable bytes sitting in the retry queue must count as "viable" ─────
// Stopping a recording while offline leaves every full part in the retry queue
// (durable in chrome.storage.local) with uploadedBytes still 0. If finalize
// only counts uploaded bytes + the pending buffer, a recording whose buffer
// happens to hold less than MIN_VIABLE_BYTES at stop time is declared "too
// short" and flipped to a terminal error — while megabytes of its real video
// sit queued. The drain then uploads those parts and nothing ever completes
// the multipart, so the meeting is lost for good.

describe("finalizeUpload viability (H1 queued bytes are durable too)", () => {
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

	it("does not declare a recording 'too short' when its bytes are queued for retry, and finishes it once the network returns", async () => {
		const { handleChunk, finalizeUpload, retryPendingUploads } = await import(
			"./upload"
		);
		const { setState, setSettings, getState } = await import("./state");

		await setSettings({ apiKey: "test-key" });
		await setState({
			kind: "recording",
			mode: "instruction",
			videoId: "vid-h1",
			uploadId: "upload-h1",
			startedAt: Date.now(),
			parts: [],
			nextPartNumber: 1,
			totalBytes: 0,
			uploadedBytes: 0,
			mime: "video/webm",
			paused: false,
		});

		let offline = true;
		let completeMultipartCalls = 0;
		let recordingCompleteCalls = 0;
		const uploadedBodies: Uint8Array[] = [];

		vi.stubGlobal(
			"fetch",
			async (input: string | URL | Request, init?: RequestInit) => {
				const url = input.toString();
				const method = init?.method ?? "GET";

				if (offline) throw new TypeError("Failed to fetch");

				if (url.includes("/api/upload/multipart/presign-part")) {
					return jsonResponse({
						presignedUrl: "https://fake-r2.example/put",
						provider: "r2",
					});
				}
				if (method === "PUT") {
					const body = init?.body;
					uploadedBodies.push(
						body instanceof Uint8Array
							? body
							: new Uint8Array(
									await new Response(body as BodyInit).arrayBuffer(),
								),
					);
					return new Response(null, {
						status: 200,
						headers: { ETag: `"etag-${uploadedBodies.length}"` },
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

		// One full 5 MiB part (its PUT fails while offline -> queued, durable)
		// plus a 4 KB tail, which is BELOW the 10 KB viability floor on its own.
		const TAIL_BYTES = 4096;
		const chunk = new Uint8Array(MIN_PART_SIZE + TAIL_BYTES);
		for (let i = 0; i < chunk.length; i++) chunk[i] = i % 256;
		await handleChunk(chunk.buffer as ArrayBuffer, 0, "video/webm");

		// Stop while still offline.
		await finalizeUpload();

		// The queued part holds 5 MiB of real, durable video — this recording is
		// emphatically not "too short". The old behaviour set kind:"error" here.
		const midState = await getState();
		expect(midState.kind).toBe("uploading");

		// Network returns; the alarm-driven drain must now finish the recording.
		offline = false;
		vi.useFakeTimers();
		vi.setSystemTime(Date.now() + 2000);

		await retryPendingUploads();
		await retryPendingUploads();

		expect(completeMultipartCalls).toBe(1);
		expect(recordingCompleteCalls).toBe(1);

		const finalState = await getState();
		expect(finalState.kind).toBe("complete");

		// Every captured byte reached storage — nothing was stranded.
		const uploadedBytes = uploadedBodies.reduce((sum, b) => sum + b.length, 0);
		expect(uploadedBytes).toBe(MIN_PART_SIZE + TAIL_BYTES);
	});
});
