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
