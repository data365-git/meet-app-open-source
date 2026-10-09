/**
 * Shared client-side multipart upload machinery.
 *
 * This module owns the HTTP contract with `/api/upload/multipart/*`
 * (initiate/presign-part/complete/abort) plus the low-level "upload one part"
 * XHR primitive (progress + stall-timeout + hard-timeout + abort). It is used
 * by:
 *  - `instant-mp4-uploader.ts` (the live streaming-webm recorder pipeline),
 *    which keeps its own buffering/backpressure/chunk-state state machine but
 *    delegates the actual per-part HTTP upload to `uploadPartBlob`.
 *  - `uploadBlobMultipart` below, a whole-Blob/File driver used by the import
 *    flow and the buffered-raw web-recorder path, where the full file is
 *    already in memory and there is no live buffering to do.
 *
 * Extracted 2026-07-19 (WAVE 1.3) so import + buffered-raw uploads get the
 * same part-size/parallelism/retry/stall-timeout guarantees as the streaming
 * recorder, without forking a second copy of the part-upload logic.
 */

// R2 requires every non-trailing multipart part to be the SAME size (and each
// >= 5 MiB). 16 MiB mirrors the streaming recorder's part size.
export const DEFAULT_MULTIPART_PART_SIZE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MULTIPART_PARALLELISM = 3;
export const MAX_PART_UPLOAD_ATTEMPTS = 3;
export const PART_UPLOAD_STALL_TIMEOUT_MS = 30_000;
export const PART_UPLOAD_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
export const PART_RETRY_BACKOFF_MS = 500;

// Below this size, a single un-chunked PUT is simpler and has less overhead
// than initiating a multipart upload. At/above it, route through multipart so
// a slow/flaky connection retries a 16MB part instead of the whole file.
export const MULTIPART_UPLOAD_THRESHOLD_BYTES = 50 * 1024 * 1024;

export type MultipartProvider = "s3" | "googleDrive";

export interface UploadedPartPayload {
	partNumber: number;
	etag: string;
	size: number;
}

export interface MultipartCompletePayload {
	durationSeconds?: number;
	width?: number;
	height?: number;
	fps?: number;
	subpath: string;
}

export class HttpRequestError extends Error {
	readonly status: number;
	readonly url: string;

	constructor(url: string, status: number, message: string) {
		super(`Request to ${url} failed: ${status} ${message}`);
		this.name = "HttpRequestError";
		this.status = status;
		this.url = url;
	}
}

export class MultipartCompletionUncertainError extends Error {
	constructor(cause?: unknown) {
		super("Multipart upload completed but confirmation was interrupted", {
			cause,
		});
		this.name = "MultipartCompletionUncertainError";
	}
}

export class CancelledUploadError extends Error {
	constructor() {
		super("Multipart upload was cancelled");
		this.name = "CancelledUploadError";
	}
}

export const normalizeMultipartContentType = (mimeType: string) => {
	const normalized = mimeType.split(";")[0]?.trim();
	return normalized || "application/octet-stream";
};

const postJson = async <TResponse>(
	url: string,
	body: Record<string, unknown>,
): Promise<TResponse> => {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		credentials: "same-origin",
		body: JSON.stringify(body),
	});

	if (!response.ok) {
		const message = await response.text();
		throw new HttpRequestError(url, response.status, message);
	}

	return (await response.json()) as TResponse;
};

export const initiateMultipartUpload = async ({
	videoId,
	contentType,
	subpath,
}: {
	videoId: string;
	contentType: string;
	subpath: string;
}): Promise<{ uploadId: string; provider: MultipartProvider }> => {
	const result = await postJson<{
		uploadId: string;
		provider?: MultipartProvider;
	}>("/api/upload/multipart/initiate", {
		videoId,
		contentType: normalizeMultipartContentType(contentType),
		subpath,
	});

	if (!result.uploadId) {
		throw new Error("Multipart initiate response missing uploadId");
	}

	return {
		uploadId: result.uploadId,
		provider: result.provider ?? "s3",
	};
};

export const presignMultipartPart = async (
	videoId: string,
	uploadId: string,
	partNumber: number,
	subpath: string,
): Promise<{ url: string; provider: MultipartProvider }> => {
	const result = await postJson<{
		presignedUrl: string;
		provider?: MultipartProvider;
	}>("/api/upload/multipart/presign-part", {
		videoId,
		uploadId,
		partNumber,
		subpath,
	});

	if (!result.presignedUrl) {
		throw new Error(`Missing presigned URL for part ${partNumber}`);
	}

	return {
		url: result.presignedUrl,
		provider: result.provider ?? "s3",
	};
};

export const completeMultipartUpload = async (
	videoId: string,
	uploadId: string,
	parts: UploadedPartPayload[],
	meta: MultipartCompletePayload,
): Promise<{ processingStarted: boolean }> => {
	try {
		const response = await postJson<{
			success: boolean;
			processingStarted?: boolean;
		}>("/api/upload/multipart/complete", {
			videoId,
			uploadId,
			parts,
			subpath: meta.subpath,
			durationInSecs: meta.durationSeconds,
			width: meta.width,
			height: meta.height,
			fps: meta.fps,
		});

		return {
			processingStarted: response.processingStarted !== false,
		};
	} catch (error) {
		if (error instanceof HttpRequestError && error.status < 500) {
			throw error;
		}

		throw new MultipartCompletionUncertainError(error);
	}
};

export const abortMultipartUpload = async (
	videoId: string,
	uploadId: string,
	subpath: string,
) => {
	await postJson<{ success: boolean }>("/api/upload/multipart/abort", {
		videoId,
		uploadId,
		subpath,
	});
};

export interface PartUploadResult {
	status: number;
	statusText: string;
	/** Raw ETag response header value (still quoted), or null if absent. */
	etagHeader: string | null;
}

/**
 * The reusable "upload one part" primitive: a PUT with upload progress,
 * a stall timeout (aborts if no progress event arrives within
 * `stallTimeoutMs`, refreshed on every progress tick) and a hard request
 * timeout. Callers own retry looping, ETag interpretation and accepted
 * status codes (S3 vs Google Drive's 308-for-non-final-part) — this function
 * only does the XHR mechanics.
 */
export function uploadPartBlob({
	url,
	part,
	headers,
	timeoutMs,
	stallTimeoutMs,
	onProgress,
	isCancelled,
	signal,
	onRequestCreated,
}: {
	url: string;
	part: Blob;
	headers?: Record<string, string>;
	timeoutMs: number;
	stallTimeoutMs: number;
	onProgress?: (loaded: number, total: number) => void;
	isCancelled?: () => boolean;
	/**
	 * When provided, aborts an ALREADY-IN-FLIGHT request immediately — the
	 * request-body upload of a large part can run for many seconds, and
	 * `isCancelled` alone is only ever checked before a request starts, so a
	 * user-initiated cancel would otherwise wait for the current part to
	 * finish or stall out before it took effect.
	 */
	signal?: AbortSignal;
	onRequestCreated?: (xhr: XMLHttpRequest) => void;
}): Promise<PartUploadResult> {
	return new Promise((resolve, reject) => {
		if (isCancelled?.() || signal?.aborted) {
			reject(new CancelledUploadError());
			return;
		}

		const xhr = new XMLHttpRequest();
		xhr.open("PUT", url);
		xhr.responseType = "text";
		xhr.timeout = timeoutMs;
		if (headers) {
			for (const [key, value] of Object.entries(headers)) {
				xhr.setRequestHeader(key, value);
			}
		}
		onRequestCreated?.(xhr);
		signal?.addEventListener("abort", () => xhr.abort(), { once: true });

		let stallTimeoutId: number | null = null;
		const clearStallTimeout = () => {
			if (stallTimeoutId === null) return;
			window.clearTimeout(stallTimeoutId);
			stallTimeoutId = null;
		};
		const refreshStallTimeout = () => {
			clearStallTimeout();
			stallTimeoutId = window.setTimeout(() => {
				stallTimeoutId = null;
				xhr.abort();
			}, stallTimeoutMs);
		};
		refreshStallTimeout();

		xhr.upload.onprogress = (event) => {
			refreshStallTimeout();
			const uploaded = event.lengthComputable
				? event.loaded
				: Math.min(part.size, event.loaded);
			const total = event.lengthComputable ? event.total : part.size;
			onProgress?.(uploaded, total);
		};

		xhr.onload = () => {
			clearStallTimeout();
			resolve({
				status: xhr.status,
				statusText: xhr.statusText,
				etagHeader: xhr.getResponseHeader("ETag"),
			});
		};
		xhr.onerror = () => {
			clearStallTimeout();
			reject(new Error("network error"));
		};
		xhr.ontimeout = () => {
			clearStallTimeout();
			reject(new Error("timed out"));
		};
		xhr.onabort = () => {
			clearStallTimeout();
			reject(isCancelled?.() || signal?.aborted ? new CancelledUploadError() : new Error("stalled"));
		};

		xhr.send(part);
	});
}

export interface PartRange {
	partNumber: number;
	start: number;
	end: number;
}

/**
 * Splits `totalBytes` into fixed-size, sequential, 1-indexed part ranges.
 * Every non-trailing part is exactly `partSizeBytes` (R2's equal-size
 * requirement); only the final part may be smaller. A zero-byte input
 * produces zero parts — callers should reject empty uploads before calling.
 */
export function computePartRanges(
	totalBytes: number,
	partSizeBytes: number,
): PartRange[] {
	if (totalBytes <= 0) return [];

	const partCount = Math.ceil(totalBytes / partSizeBytes);
	const ranges: PartRange[] = [];
	for (let i = 0; i < partCount; i++) {
		const start = i * partSizeBytes;
		const end = Math.min(totalBytes, start + partSizeBytes);
		ranges.push({ partNumber: i + 1, start, end });
	}
	return ranges;
}

export interface BlobMultipartUploadResult {
	processingStarted: boolean;
}

/**
 * Uploads an already-complete Blob/File via multipart: initiate -> split
 * into parts -> upload with N parallel workers (each part retried up to
 * `MAX_PART_UPLOAD_ATTEMPTS` times with backoff) -> complete. Progress is
 * aggregated across all parts. Google Drive's resumable protocol requires
 * strictly sequential, offset-addressed parts, so it forces parallelism to 1
 * regardless of the requested value.
 *
 * On a non-retryable failure, best-effort aborts the multipart upload server
 * side so it doesn't linger, then rethrows.
 */
export async function uploadBlobMultipart({
	videoId,
	blob,
	contentType,
	subpath,
	durationInSecs,
	width,
	height,
	fps,
	partSizeBytes = DEFAULT_MULTIPART_PART_SIZE_BYTES,
	parallelism = DEFAULT_MULTIPART_PARALLELISM,
	onProgress,
	signal,
}: {
	videoId: string;
	blob: Blob;
	contentType: string;
	subpath: string;
	durationInSecs?: number;
	width?: number;
	height?: number;
	fps?: number;
	partSizeBytes?: number;
	parallelism?: number;
	onProgress?: (uploaded: number, total: number) => void;
	/** Cancels the whole upload: no further parts start, the current part's
	 *  in-flight request is aborted immediately, and the multipart upload is
	 *  aborted server-side (releasing the parts already sent) before this
	 *  rejects with `CancelledUploadError`. */
	signal?: AbortSignal;
}): Promise<BlobMultipartUploadResult> {
	if (signal?.aborted) throw new CancelledUploadError();
	const totalBytes = blob.size;
	if (totalBytes === 0) {
		throw new Error("Cannot upload empty file");
	}

	const { uploadId, provider } = await initiateMultipartUpload({
		videoId,
		contentType,
		subpath,
	});

	const ranges = computePartRanges(totalBytes, partSizeBytes);
	const effectiveParallelism =
		provider === "googleDrive" ? 1 : Math.max(1, Math.min(parallelism, ranges.length));

	const uploadedBytesByPart = new Map<number, number>();
	const emitProgress = () => {
		if (!onProgress) return;
		let uploaded = 0;
		for (const bytes of uploadedBytesByPart.values()) uploaded += bytes;
		onProgress(uploaded, totalBytes);
	};

	const uploadOnePart = async (
		range: PartRange,
	): Promise<UploadedPartPayload> => {
		const partBlob = blob.slice(range.start, range.end, contentType);
		const isFinalPart =
			provider === "googleDrive" && range.end >= totalBytes;

		let attempt = 0;
		let lastError: unknown;
		while (attempt < MAX_PART_UPLOAD_ATTEMPTS) {
			attempt += 1;
			try {
				const presign = await presignMultipartPart(
					videoId,
					uploadId,
					range.partNumber,
					subpath,
				);

				const headers: Record<string, string> | undefined =
					provider === "googleDrive"
						? {
								"Content-Range": `bytes ${range.start}-${range.end - 1}/${
									isFinalPart ? totalBytes : "*"
								}`,
								"Content-Type": contentType,
							}
						: undefined;

				const { status, etagHeader } = await uploadPartBlob({
					url: presign.url,
					part: partBlob,
					headers,
					timeoutMs: PART_UPLOAD_REQUEST_TIMEOUT_MS,
					stallTimeoutMs: PART_UPLOAD_STALL_TIMEOUT_MS,
					signal,
					onProgress: (loaded) => {
						uploadedBytesByPart.set(range.partNumber, loaded);
						emitProgress();
					},
				});

				const ok =
					(status >= 200 && status < 300) ||
					(provider === "googleDrive" && status === 308 && !isFinalPart);
				if (!ok) {
					throw new Error(
						`Failed to upload part ${range.partNumber}: ${status}`,
					);
				}

				const etag =
					etagHeader?.replace(/"/g, "") ||
					(provider === "googleDrive" ? `drive-${range.partNumber}` : "");
				if (!etag) {
					throw new Error(`Missing ETag for part ${range.partNumber}`);
				}

				uploadedBytesByPart.set(range.partNumber, partBlob.size);
				emitProgress();
				return { partNumber: range.partNumber, etag, size: partBlob.size };
			} catch (error) {
				// uploadPartBlob rejects with the bare XHR reason ("network error" /
				// "timed out" / "stalled"); identify which part failed here so a
				// surfaced failure message is actionable instead of generic.
				lastError =
					error instanceof Error &&
					!error.message.startsWith(`Failed to upload part ${range.partNumber}`) &&
					(error.message === "network error" ||
						error.message === "timed out" ||
						error.message === "stalled")
						? new Error(
								`Failed to upload part ${range.partNumber}: ${error.message}`,
							)
						: error;
				if (
					signal?.aborted ||
					error instanceof CancelledUploadError ||
					attempt >= MAX_PART_UPLOAD_ATTEMPTS
				) {
					break;
				}
				uploadedBytesByPart.set(range.partNumber, 0);
				emitProgress();
				await new Promise((resolve) =>
					window.setTimeout(resolve, attempt * PART_RETRY_BACKOFF_MS),
				);
			}
		}

		throw lastError instanceof Error
			? lastError
			: new Error(`Failed to upload part ${range.partNumber}`);
	};

	const results: UploadedPartPayload[] = new Array(ranges.length);
	let nextIndex = 0;
	let firstError: unknown = null;

	const worker = async () => {
		while (true) {
			if (firstError) return;
			const index = nextIndex;
			nextIndex += 1;
			if (index >= ranges.length) return;
			try {
				results[index] = await uploadOnePart(ranges[index] as PartRange);
			} catch (error) {
				firstError = error;
				return;
			}
		}
	};

	await Promise.all(
		Array.from({ length: effectiveParallelism }, () => worker()),
	);

	if (firstError) {
		try {
			await abortMultipartUpload(videoId, uploadId, subpath);
		} catch (abortError) {
			console.error("Failed to abort multipart upload", abortError);
		}
		// A cancel wins over whatever error was recorded: a parallel worker's
		// late "network error" can overwrite a CancelledUploadError in
		// firstError, and the caller must still treat it as a cancel.
		if (signal?.aborted) throw new CancelledUploadError();
		throw firstError instanceof Error
			? firstError
			: new Error(String(firstError));
	}

	const completion = await completeMultipartUpload(videoId, uploadId, results, {
		durationSeconds: durationInSecs,
		width,
		height,
		fps,
		subpath,
	});

	onProgress?.(totalBytes, totalBytes);
	return completion;
}
