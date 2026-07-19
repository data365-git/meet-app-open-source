import type { Storage } from "@cap/web-domain";

type UploadTarget =
	| Storage.UploadTarget
	| {
			url: string;
			fields: Record<string, string>;
	  };

type UploadProgress = {
	loaded: number;
	total: number;
};

const MAX_UPLOAD_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;
// Files this small route through a single un-chunked PUT/POST rather than
// multipart (see utils/multipart-upload.ts's MULTIPART_UPLOAD_THRESHOLD_BYTES),
// but a single request with no timeout can hang forever on a dead connection.
// Give it a generous hard cap plus a stall detector (no progress for this long
// = abort and retry) so a stuck upload fails fast instead of spinning silently.
const SINGLE_UPLOAD_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const SINGLE_UPLOAD_STALL_TIMEOUT_MS = 30_000;

class UploadRequestError extends Error {
	readonly status: number;

	constructor(status: number) {
		super(`Upload failed with status ${status}`);
		this.name = "UploadRequestError";
		this.status = status;
	}
}

const shouldRetryUpload = (error: unknown) =>
	!(error instanceof UploadRequestError) ||
	error.status === 0 ||
	error.status >= 500;

const isPostTarget = (
	target: UploadTarget,
): target is { url: string; fields: Record<string, string> } =>
	!("type" in target) || target.type === "s3Post";

const isDriveResumableTarget = (
	target: UploadTarget,
): target is Extract<Storage.UploadTarget, { type: "driveResumable" }> =>
	"type" in target && target.type === "driveResumable";

export function uploadWithTarget({
	target,
	body,
	fileName,
	onProgress,
}: {
	target: UploadTarget;
	body: Blob;
	fileName?: string;
	onProgress?: (progress: UploadProgress) => void;
}) {
	const waitForRetry = (attempt: number) =>
		new Promise<void>((resolve) => {
			window.setTimeout(resolve, attempt * RETRY_BACKOFF_MS);
		});

	// Shared timeout/stall wiring for both the POST (s3Post/FormData) and PUT
	// branches below: a hard request timeout, plus a stall timer that's
	// refreshed on every upload progress tick and aborts the request if none
	// arrives for SINGLE_UPLOAD_STALL_TIMEOUT_MS. Settling (resolve/reject)
	// always clears the stall timer first.
	const attachTimeoutAndStallDetection = (
		xhr: XMLHttpRequest,
		reject: (error: unknown) => void,
	) => {
		xhr.timeout = SINGLE_UPLOAD_REQUEST_TIMEOUT_MS;

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
			}, SINGLE_UPLOAD_STALL_TIMEOUT_MS);
		};
		refreshStallTimeout();

		xhr.ontimeout = () => {
			clearStallTimeout();
			reject(new Error("Upload timed out"));
		};
		xhr.onabort = () => {
			clearStallTimeout();
			reject(new Error("Upload stalled"));
		};

		return { clearStallTimeout, refreshStallTimeout };
	};

	const uploadOnce = () =>
		new Promise<void>((resolve, reject) => {
			const xhr = new XMLHttpRequest();

			if (isPostTarget(target)) {
				const formData = new FormData();
				Object.entries(target.fields).forEach(([key, value]) => {
					formData.append(key, value);
				});
				formData.append("file", body, fileName);
				xhr.open("POST", target.url);
				const { clearStallTimeout, refreshStallTimeout } =
					attachTimeoutAndStallDetection(xhr, reject);
				xhr.upload.onprogress = (event) => {
					refreshStallTimeout();
					if (event.lengthComputable) {
						onProgress?.({ loaded: event.loaded, total: event.total });
					}
				};
				xhr.onload = () => {
					clearStallTimeout();
					if (xhr.status >= 200 && xhr.status < 300) {
						resolve();
					} else {
						reject(new UploadRequestError(xhr.status));
					}
				};
				xhr.onerror = () => {
					clearStallTimeout();
					reject(new Error("Upload failed"));
				};
				xhr.send(formData);
				return;
			}

			xhr.open("PUT", target.url);
			const { clearStallTimeout, refreshStallTimeout } =
				attachTimeoutAndStallDetection(xhr, reject);
			Object.entries(target.headers).forEach(([key, value]) => {
				xhr.setRequestHeader(key, value);
			});
			if (isDriveResumableTarget(target) && body.size > 0) {
				xhr.setRequestHeader(
					"Content-Range",
					`bytes 0-${body.size - 1}/${body.size}`,
				);
			}
			xhr.upload.onprogress = (event) => {
				refreshStallTimeout();
				if (event.lengthComputable) {
					onProgress?.({ loaded: event.loaded, total: event.total });
				}
			};
			xhr.onload = () => {
				clearStallTimeout();
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve();
				} else {
					reject(new UploadRequestError(xhr.status));
				}
			};
			xhr.onerror = () => {
				clearStallTimeout();
				reject(new Error("Upload failed"));
			};
			xhr.send(body);
		});

	return (async () => {
		let lastError: unknown;

		for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt += 1) {
			try {
				await uploadOnce();
				return;
			} catch (error) {
				lastError = error;
				if (!shouldRetryUpload(error) || attempt >= MAX_UPLOAD_ATTEMPTS) {
					break;
				}
				await waitForRetry(attempt);
			}
		}

		throw lastError instanceof Error ? lastError : new Error("Upload failed");
	})();
}
