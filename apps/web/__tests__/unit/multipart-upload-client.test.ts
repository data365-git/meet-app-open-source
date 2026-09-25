import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	CancelledUploadError,
	computePartRanges,
	MultipartCompletionUncertainError,
	uploadBlobMultipart,
	uploadPartBlob,
} from "@/utils/multipart-upload";

// Mirrors the MockXMLHttpRequest pattern used by
// __tests__/unit/instant-recording-uploader.test.ts, which this module's
// uploadPartBlob primitive was extracted from — kept deliberately small since
// this suite only needs to prove the whole-blob driver (part splitting,
// retry/backoff, progress aggregation), not re-cover every streaming-uploader
// edge case already covered there.
type UploadOutcome =
	| { type: "success"; etag?: string; status?: number }
	| { type: "network-error" }
	| { type: "pending" };

class MockXMLHttpRequest {
	static outcomes: UploadOutcome[] = [];
	static abortedCount = 0;
	static recordedHeaders: Array<Map<string, string>> = [];
	static sentUrls: string[] = [];

	upload = {
		onprogress: null as ((event: ProgressEvent<EventTarget>) => void) | null,
	};
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	onabort: (() => void) | null = null;
	ontimeout: (() => void) | null = null;
	status = 0;
	statusText = "";
	timeout = 0;
	private url = "";
	private headers = new Map<string, string>();
	private completed = false;

	static setOutcomes(outcomes: UploadOutcome[]) {
		MockXMLHttpRequest.outcomes = [...outcomes];
		MockXMLHttpRequest.abortedCount = 0;
		MockXMLHttpRequest.recordedHeaders = [];
		MockXMLHttpRequest.sentUrls = [];
	}

	open(_method: string, url: string) {
		this.url = url;
	}

	setRequestHeader(name: string, value: string) {
		this.headers.set(name.toLowerCase(), value);
	}

	getResponseHeader(name: string) {
		return this.headers.get(name.toLowerCase()) ?? null;
	}

	send(part: Blob) {
		MockXMLHttpRequest.sentUrls.push(this.url);
		MockXMLHttpRequest.recordedHeaders.push(new Map(this.headers));

		const outcome = MockXMLHttpRequest.outcomes.shift();
		if (!outcome) {
			throw new Error("Missing upload outcome");
		}

		this.upload.onprogress?.({
			lengthComputable: true,
			loaded: part.size,
			total: part.size,
		} as ProgressEvent<EventTarget>);

		if (outcome.type === "pending") return;

		if (outcome.type === "network-error") {
			this.completed = true;
			this.onerror?.();
			return;
		}

		this.completed = true;
		this.status = outcome.status ?? 200;
		this.statusText = this.status === 308 ? "Resume Incomplete" : "OK";
		if (outcome.etag) this.headers.set("etag", `"${outcome.etag}"`);
		this.onload?.();
	}

	abort() {
		if (this.completed) return;
		this.completed = true;
		MockXMLHttpRequest.abortedCount += 1;
		this.onabort?.();
	}
}

const makeJsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

const makeBlob = (size: number) => new Blob([new Uint8Array(size)]);

describe("computePartRanges", () => {
	it("splits into equal non-trailing parts with a smaller trailing part", () => {
		const MB = 1024 * 1024;
		const ranges = computePartRanges(40 * MB, 16 * MB);
		expect(ranges).toEqual([
			{ partNumber: 1, start: 0, end: 16 * MB },
			{ partNumber: 2, start: 16 * MB, end: 32 * MB },
			{ partNumber: 3, start: 32 * MB, end: 40 * MB },
		]);
	});

	it("produces one part when the input is an exact multiple of the part size", () => {
		const MB = 1024 * 1024;
		const ranges = computePartRanges(16 * MB, 16 * MB);
		expect(ranges).toEqual([{ partNumber: 1, start: 0, end: 16 * MB }]);
	});

	it("produces a single part for input smaller than the part size", () => {
		const ranges = computePartRanges(1024, 16 * 1024 * 1024);
		expect(ranges).toEqual([{ partNumber: 1, start: 0, end: 1024 }]);
	});

	it("produces zero parts for empty input", () => {
		expect(computePartRanges(0, 16 * 1024 * 1024)).toEqual([]);
	});
});

describe("uploadBlobMultipart", () => {
	beforeEach(() => {
		vi.stubGlobal("window", globalThis as typeof globalThis & Window);
		vi.stubGlobal(
			"XMLHttpRequest",
			MockXMLHttpRequest as unknown as typeof XMLHttpRequest,
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	const MB = 1024 * 1024;

	it("initiates, uploads every part, and completes with sequential parts + forwarded metadata", async () => {
		let completeBody: Record<string, unknown> | undefined;
		const fetchMock = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				const body = init?.body ? JSON.parse(init.body as string) : null;

				if (url === "/api/upload/multipart/initiate") {
					expect(body).toMatchObject({
						videoId: "video-1",
						contentType: "video/mp4",
						subpath: "raw-upload.mp4",
					});
					return makeJsonResponse({ uploadId: "upload-1" });
				}
				if (url === "/api/upload/multipart/presign-part") {
					return makeJsonResponse({
						presignedUrl: `https://uploads.example/part-${body.partNumber}`,
					});
				}
				if (url === "/api/upload/multipart/complete") {
					completeBody = body;
					return makeJsonResponse({ success: true });
				}
				throw new Error(`Unexpected fetch call: ${url}`);
			},
		);
		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([
			{ type: "success", etag: "etag-1" },
			{ type: "success", etag: "etag-2" },
			{ type: "success", etag: "etag-3" },
		]);

		const onProgress = vi.fn();
		const result = await uploadBlobMultipart({
			videoId: "video-1",
			blob: makeBlob(40 * MB),
			contentType: "video/mp4",
			subpath: "raw-upload.mp4",
			durationInSecs: 42,
			width: 1920,
			height: 1080,
			fps: 30,
			partSizeBytes: 16 * MB,
			onProgress,
		});

		expect(result).toEqual({ processingStarted: true });
		expect(completeBody).toMatchObject({
			videoId: "video-1",
			uploadId: "upload-1",
			subpath: "raw-upload.mp4",
			durationInSecs: 42,
			width: 1920,
			height: 1080,
			fps: 30,
		});
		expect(completeBody?.parts).toEqual([
			{ partNumber: 1, etag: "etag-1", size: 16 * MB },
			{ partNumber: 2, etag: "etag-2", size: 16 * MB },
			{ partNumber: 3, etag: "etag-3", size: 8 * MB },
		]);
		// Final call always reports the whole blob as fully uploaded.
		expect(onProgress).toHaveBeenLastCalledWith(40 * MB, 40 * MB);
	});

	it("aggregates progress across in-flight parallel parts", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
				const url = input.toString();
				const body = init?.body ? JSON.parse(init.body as string) : null;
				if (url === "/api/upload/multipart/initiate") {
					return makeJsonResponse({ uploadId: "upload-1" });
				}
				if (url === "/api/upload/multipart/presign-part") {
					return makeJsonResponse({
						presignedUrl: `https://uploads.example/part-${body.partNumber}`,
					});
				}
				if (url === "/api/upload/multipart/complete") {
					return makeJsonResponse({ success: true });
				}
				throw new Error(`Unexpected fetch call: ${url}`);
			}),
		);
		// 3 parts of 16MB each; the mock resolves each part synchronously inside
		// send(), so by the time all workers finish every part has already
		// reported its full size once — progress should never exceed the total.
		MockXMLHttpRequest.setOutcomes([
			{ type: "success", etag: "etag-1" },
			{ type: "success", etag: "etag-2" },
			{ type: "success", etag: "etag-3" },
		]);

		const progressSnapshots: Array<[number, number]> = [];
		await uploadBlobMultipart({
			videoId: "video-1",
			blob: makeBlob(48 * MB),
			contentType: "video/mp4",
			subpath: "raw-upload.mp4",
			partSizeBytes: 16 * MB,
			parallelism: 3,
			onProgress: (loaded, total) => progressSnapshots.push([loaded, total]),
		});

		expect(progressSnapshots.length).toBeGreaterThan(0);
		for (const [loaded, total] of progressSnapshots) {
			expect(loaded).toBeLessThanOrEqual(total);
			expect(total).toBe(48 * MB);
		}
		const [finalLoaded, finalTotal] =
			progressSnapshots[progressSnapshots.length - 1] ?? [];
		expect(finalLoaded).toBe(48 * MB);
		expect(finalTotal).toBe(48 * MB);
	});

	it("retries a failed part with backoff before completing", async () => {
		vi.useFakeTimers();
		let presignCalls = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url === "/api/upload/multipart/initiate") {
					return makeJsonResponse({ uploadId: "upload-1" });
				}
				if (url === "/api/upload/multipart/presign-part") {
					presignCalls += 1;
					return makeJsonResponse({
						presignedUrl: `https://uploads.example/attempt-${presignCalls}`,
					});
				}
				if (url === "/api/upload/multipart/complete") {
					return makeJsonResponse({ success: true });
				}
				throw new Error(`Unexpected fetch call: ${url}`);
			}),
		);
		MockXMLHttpRequest.setOutcomes([
			{ type: "network-error" },
			{ type: "success", etag: "etag-retried" },
		]);

		const resultPromise = uploadBlobMultipart({
			videoId: "video-1",
			blob: makeBlob(10 * MB),
			contentType: "video/mp4",
			subpath: "raw-upload.mp4",
			partSizeBytes: 16 * MB,
		});

		await vi.runAllTimersAsync();
		const result = await resultPromise;

		expect(result).toEqual({ processingStarted: true });
		expect(presignCalls).toBe(2);
	});

	it("aborts the multipart upload and rejects once a part exhausts its retries", async () => {
		vi.useFakeTimers();
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = input.toString();
			if (url === "/api/upload/multipart/initiate") {
				return makeJsonResponse({ uploadId: "upload-1" });
			}
			if (url === "/api/upload/multipart/presign-part") {
				return makeJsonResponse({
					presignedUrl: "https://uploads.example/part-1",
				});
			}
			if (url === "/api/upload/multipart/abort") {
				return makeJsonResponse({ success: true });
			}
			throw new Error(`Unexpected fetch call: ${url}`);
		});
		vi.stubGlobal("fetch", fetchMock);
		MockXMLHttpRequest.setOutcomes([
			{ type: "network-error" },
			{ type: "network-error" },
			{ type: "network-error" },
		]);

		const resultPromise = uploadBlobMultipart({
			videoId: "video-1",
			blob: makeBlob(5 * MB),
			contentType: "video/mp4",
			subpath: "raw-upload.mp4",
			partSizeBytes: 16 * MB,
		});

		const expectation = expect(resultPromise).rejects.toThrow(
			"Failed to upload part 1: network error",
		);
		await vi.runAllTimersAsync();
		await expectation;

		expect(
			fetchMock.mock.calls.some(
				([input]) => input.toString() === "/api/upload/multipart/abort",
			),
		).toBe(true);
	});

	it("throws for an empty blob without contacting the server", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(
			uploadBlobMultipart({
				videoId: "video-1",
				blob: makeBlob(0),
				contentType: "video/mp4",
				subpath: "raw-upload.mp4",
			}),
		).rejects.toThrow("Cannot upload empty file");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("treats a lost completion response as uncertain rather than a hard failure", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url === "/api/upload/multipart/initiate") {
					return makeJsonResponse({ uploadId: "upload-1" });
				}
				if (url === "/api/upload/multipart/presign-part") {
					return makeJsonResponse({
						presignedUrl: "https://uploads.example/part-1",
					});
				}
				if (url === "/api/upload/multipart/complete") {
					return new Response("gateway timeout", { status: 504 });
				}
				throw new Error(`Unexpected fetch call: ${url}`);
			}),
		);
		MockXMLHttpRequest.setOutcomes([{ type: "success", etag: "etag-1" }]);

		await expect(
			uploadBlobMultipart({
				videoId: "video-1",
				blob: makeBlob(1 * MB),
				contentType: "video/mp4",
				subpath: "raw-upload.mp4",
				partSizeBytes: 16 * MB,
			}),
		).rejects.toBeInstanceOf(MultipartCompletionUncertainError);
	});

	it("forces sequential (non-parallel) parts with offset content-range headers for Google Drive", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url === "/api/upload/multipart/initiate") {
					return makeJsonResponse({ uploadId: "drive-1", provider: "googleDrive" });
				}
				if (url === "/api/upload/multipart/presign-part") {
					return makeJsonResponse({
						presignedUrl: "https://drive.example/session",
						provider: "googleDrive",
					});
				}
				if (url === "/api/upload/multipart/complete") {
					return makeJsonResponse({ success: true });
				}
				throw new Error(`Unexpected fetch call: ${url}`);
			}),
		);
		MockXMLHttpRequest.setOutcomes([
			{ type: "success", status: 308 },
			{ type: "success", status: 200 },
		]);

		await uploadBlobMultipart({
			videoId: "video-1",
			blob: makeBlob(20 * MB),
			contentType: "video/mp4",
			subpath: "raw-upload.mp4",
			partSizeBytes: 16 * MB,
			parallelism: 3, // requested parallelism must be overridden to 1
		});

		expect(MockXMLHttpRequest.recordedHeaders[0]?.get("content-range")).toBe(
			`bytes 0-${16 * MB - 1}/*`,
		);
		expect(MockXMLHttpRequest.recordedHeaders[1]?.get("content-range")).toBe(
			`bytes ${16 * MB}-${20 * MB - 1}/${20 * MB}`,
		);
	});

	// Owner order 2026-09-11: a Cancel control on an in-progress upload that
	// takes effect within a couple of seconds (not a network timeout) and
	// deletes whatever bytes were already sent. These prove the CLIENT half:
	// the in-flight part is aborted immediately and the multipart upload is
	// aborted server-side, releasing the parts already sent.
	it("cancels immediately: aborts the in-flight part, aborts server-side, rejects with CancelledUploadError", async () => {
		let abortCalled = false;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url === "/api/upload/multipart/initiate") {
					return makeJsonResponse({ uploadId: "upload-1" });
				}
				if (url === "/api/upload/multipart/presign-part") {
					return makeJsonResponse({
						presignedUrl: "https://uploads.example/part-1",
					});
				}
				if (url === "/api/upload/multipart/abort") {
					abortCalled = true;
					return makeJsonResponse({ success: true });
				}
				throw new Error(`Unexpected fetch call: ${url}`);
			}),
		);
		// "pending" never settles on its own — only a real xhr.abort() (fired by
		// the signal) ends this part, proving cancellation does not wait for a
		// timeout.
		MockXMLHttpRequest.setOutcomes([{ type: "pending" }]);

		const controller = new AbortController();
		const resultPromise = uploadBlobMultipart({
			videoId: "video-1",
			blob: makeBlob(5 * MB),
			contentType: "video/mp4",
			subpath: "raw-upload.mp4",
			partSizeBytes: 16 * MB,
			signal: controller.signal,
		});

		// Let initiate/presign resolve and the part's xhr.send() actually fire
		// (each is a real awaited fetch, so a fixed microtask count is fragile)
		// before cancelling — the outcome is only shifted off once send() runs.
		while (MockXMLHttpRequest.outcomes.length > 0) {
			await Promise.resolve();
		}
		controller.abort();

		await expect(resultPromise).rejects.toBeInstanceOf(CancelledUploadError);
		expect(MockXMLHttpRequest.abortedCount).toBe(1);
		expect(abortCalled).toBe(true);
	});

	it("cancelling never retries a part, even though a retryable error would", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input.toString();
				if (url === "/api/upload/multipart/initiate") {
					return makeJsonResponse({ uploadId: "upload-1" });
				}
				if (url === "/api/upload/multipart/presign-part") {
					return makeJsonResponse({
						presignedUrl: "https://uploads.example/part-1",
					});
				}
				if (url === "/api/upload/multipart/abort") {
					return makeJsonResponse({ success: true });
				}
				throw new Error(`Unexpected fetch call: ${url}`);
			}),
		);
		// Only ONE outcome is provided. A network error alone would retry
		// (MAX_PART_UPLOAD_ATTEMPTS > 1) and throw "Missing upload outcome" when
		// the outcomes queue runs dry — cancellation must never reach that retry.
		MockXMLHttpRequest.setOutcomes([{ type: "network-error" }]);

		const controller = new AbortController();
		controller.abort(); // already cancelled before the part is even attempted
		const resultPromise = uploadBlobMultipart({
			videoId: "video-1",
			blob: makeBlob(5 * MB),
			contentType: "video/mp4",
			subpath: "raw-upload.mp4",
			partSizeBytes: 16 * MB,
			signal: controller.signal,
		});

		await expect(resultPromise).rejects.toBeInstanceOf(CancelledUploadError);
	});
});

describe("uploadPartBlob", () => {
	beforeEach(() => {
		vi.stubGlobal("window", globalThis as typeof globalThis & Window);
		vi.stubGlobal(
			"XMLHttpRequest",
			MockXMLHttpRequest as unknown as typeof XMLHttpRequest,
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it("rejects immediately with CancelledUploadError when already cancelled", async () => {
		MockXMLHttpRequest.setOutcomes([{ type: "success", etag: "unused" }]);
		await expect(
			uploadPartBlob({
				url: "https://uploads.example/part-1",
				part: new Blob(["x"]),
				timeoutMs: 1000,
				stallTimeoutMs: 1000,
				isCancelled: () => true,
			}),
		).rejects.toBeInstanceOf(CancelledUploadError);
	});

	it("aborts and rejects with a stall error when no progress arrives in time", async () => {
		vi.useFakeTimers();
		MockXMLHttpRequest.setOutcomes([{ type: "pending" }]);

		const resultPromise = uploadPartBlob({
			url: "https://uploads.example/part-1",
			part: new Blob([new Uint8Array(1024)]),
			timeoutMs: 60_000,
			stallTimeoutMs: 5_000,
		});
		const expectation = expect(resultPromise).rejects.toThrow("stalled");
		await vi.advanceTimersByTimeAsync(5_100);
		await expectation;
		expect(MockXMLHttpRequest.abortedCount).toBe(1);
	});
});
