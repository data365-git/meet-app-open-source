import { createCapApi } from "./api";
import type { CompletedPart, ExtensionSettings } from "./state";
import { getSettings, getState, setState } from "./state";

export const MIN_PART_SIZE = 5 * 1024 * 1024;
const RETRY_QUEUE_KEY = "capExtRetryQueue";
const DEAD_LETTER_KEY = "capExtDeadLetterQueue";
const MAX_ATTEMPTS = 6;

const BACKOFF_SECONDS = [1, 4, 16, 64, 256];

// (P1.5 / M3) A dedicated alarm drives periodic drains of the retry queue.
// Deliberately NOT the keepalive alarm (see keepalive.ts) — that one is
// cleared exactly when retries are needed (RECORDER_ERROR, finalizeRecording
// in sw.ts), so piggybacking it would barely fire at all. This alarm's
// lifecycle is centralized in setRetryQueue below, so it can never drift out
// of sync with whether the queue actually has anything to drain.
export const RETRY_ALARM_NAME = "cap-retry-queue";
const RETRY_ALARM_INTERVAL_MINUTES = 1;

export function isRetryAlarm(name: string): boolean {
	return name === RETRY_ALARM_NAME;
}

interface RetryItem {
	kind: "part" | "complete" | "recording-complete";
	payload: Record<string, unknown>;
	attempts: number;
	nextRetryAt: number;
}

let inMemoryBuffer: Uint8Array = new Uint8Array(0);

// ── Pending-buffer persistence (D6a: survive MV3 service-worker eviction) ──
//
// `inMemoryBuffer` above lives only in the SW's JS heap. Chrome can evict an
// idle MV3 service worker (or the browser can be closed) at any time between
// message deliveries; on respawn all module-level state resets to its
// initial value, silently dropping up to MIN_PART_SIZE (~5MB) of recording
// tail that had not yet been flushed into an uploaded part. Persisting the
// buffer to chrome.storage.local — throttled so we don't thrash storage on
// every small chunk — lets a respawned SW restore it before continuing.
const PENDING_BUFFER_KEY_PREFIX = "pendingBuffer:";
const PENDING_BUFFER_PERSIST_INTERVAL_MS = 2000;
const PENDING_BUFFER_PERSIST_GROWTH_BYTES = 1 * 1024 * 1024;

let lastPersistedForUploadId: string | undefined;
let lastPersistAt = 0;
let lastPersistedLength = 0;

function pendingBufferKey(uploadId: string): string {
	return `${PENDING_BUFFER_KEY_PREFIX}${uploadId}`;
}

async function persistPendingBuffer(uploadId: string): Promise<void> {
	await chrome.storage.local.set({
		[pendingBufferKey(uploadId)]: bytesToBase64(inMemoryBuffer),
	});
	lastPersistedForUploadId = uploadId;
	lastPersistAt = Date.now();
	lastPersistedLength = inMemoryBuffer.length;
}

/** Persist the current buffer if enough time or growth has passed since the last persist. */
async function maybePersistPendingBuffer(uploadId: string): Promise<void> {
	const now = Date.now();
	const grew = inMemoryBuffer.length - lastPersistedLength;
	const isNewUpload = lastPersistedForUploadId !== uploadId;

	if (
		isNewUpload ||
		now - lastPersistAt >= PENDING_BUFFER_PERSIST_INTERVAL_MS ||
		grew >= PENDING_BUFFER_PERSIST_GROWTH_BYTES
	) {
		await persistPendingBuffer(uploadId);
	}
}

async function clearPendingBuffer(uploadId: string): Promise<void> {
	await chrome.storage.local.remove(pendingBufferKey(uploadId));
	if (lastPersistedForUploadId === uploadId) {
		lastPersistedForUploadId = undefined;
		lastPersistAt = 0;
		lastPersistedLength = 0;
	}
}

/**
 * Restore a persisted pending buffer into `inMemoryBuffer` for the given
 * upload if the in-memory copy is empty (i.e. this SW instance never saw
 * the buffered bytes — a fresh respawn after eviction). Safe to call
 * unconditionally at the top of any buffer-touching entry point.
 */
async function restorePendingBufferIfNeeded(uploadId: string): Promise<void> {
	if (inMemoryBuffer.length > 0) return;

	const result = await chrome.storage.local.get(pendingBufferKey(uploadId));
	const stored = result[pendingBufferKey(uploadId)] as string | undefined;
	if (!stored) return;

	inMemoryBuffer = base64ToBytes(stored);
	lastPersistedForUploadId = uploadId;
	lastPersistAt = Date.now();
	lastPersistedLength = inMemoryBuffer.length;
}

interface PartRetryPayload {
	partNumber: number;
	videoId: string;
	uploadId: string;
	partDataBase64: string;
}

function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;

	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}

	return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
	const binary = atob(base64);
	const bytes = new Uint8Array(binary.length);

	for (let i = 0; i < binary.length; i += 1) {
		bytes[i] = binary.charCodeAt(i);
	}

	return bytes;
}

function getPartRetryPayload(item: RetryItem): PartRetryPayload | undefined {
	const { partNumber, videoId, uploadId, partDataBase64 } = item.payload;

	if (
		typeof partNumber !== "number" ||
		typeof videoId !== "string" ||
		typeof uploadId !== "string" ||
		typeof partDataBase64 !== "string"
	) {
		return undefined;
	}

	return { partNumber, videoId, uploadId, partDataBase64 };
}

function upsertCompletedPart(
	parts: CompletedPart[],
	completedPart: CompletedPart,
): CompletedPart[] {
	const withoutPart = parts.filter(
		(part) => part.PartNumber !== completedPart.PartNumber,
	);
	return [...withoutPart, completedPart].sort(
		(a, b) => a.PartNumber - b.PartNumber,
	);
}

function appendToBuffer(chunk: Uint8Array): void {
	const merged = new Uint8Array(inMemoryBuffer.length + chunk.length);
	merged.set(inMemoryBuffer, 0);
	merged.set(chunk, inMemoryBuffer.length);
	inMemoryBuffer = merged;
}

function drainBuffer(): Uint8Array {
	const drained = inMemoryBuffer;
	inMemoryBuffer = new Uint8Array(0);
	return drained;
}

/**
 * Slice `buffer` into as many fixed-`partSize` parts as it contains, keeping
 * whatever is left over (< partSize) as the remainder. Pure — no chrome.*,
 * no network, no module-level state — so every non-trailing multipart part
 * is guaranteed byte-identical in size, per R2's "all parts except the last
 * must be the same size" requirement.
 */
export function takeFixedSizeParts(
	buffer: Uint8Array,
	partSize: number,
): { parts: Uint8Array[]; remainder: Uint8Array } {
	const parts: Uint8Array[] = [];
	let offset = 0;

	while (buffer.length - offset >= partSize) {
		parts.push(buffer.slice(offset, offset + partSize));
		offset += partSize;
	}

	return { parts, remainder: buffer.slice(offset) };
}

/**
 * (M7) The next PartNumber to use for a persisted "uploading" state's
 * trailing remainder. `parts.length + 1` is wrong whenever the part numbers
 * have a gap (e.g. parts [1,2,4] because part 3 is still queued elsewhere
 * from a prior crash) — it would reassign an already-used number (4), and
 * the non-upsert append in finalizeUpload then produces a duplicate
 * PartNumber in the completeMultipart call. Use max(PartNumber)+1 instead,
 * accounting for both already-uploaded parts AND any part still queued for
 * retry for this exact upload (which will also eventually claim a number).
 */
function computeNextPartNumberForUploading(
	parts: CompletedPart[],
	queue: RetryItem[],
	videoId: string,
	uploadId: string,
): number {
	let maxPartNumber = 0;
	for (const part of parts) {
		if (part.PartNumber > maxPartNumber) maxPartNumber = part.PartNumber;
	}
	for (const item of queue) {
		if (item.kind !== "part") continue;
		const payload = getPartRetryPayload(item);
		if (!payload) continue;
		if (payload.videoId !== videoId || payload.uploadId !== uploadId) continue;
		if (payload.partNumber > maxPartNumber) maxPartNumber = payload.partNumber;
	}
	return maxPartNumber + 1;
}

async function getRetryQueue(): Promise<RetryItem[]> {
	const result = await chrome.storage.local.get(RETRY_QUEUE_KEY);
	return (result[RETRY_QUEUE_KEY] as RetryItem[] | undefined) ?? [];
}

async function setRetryQueue(queue: RetryItem[]): Promise<void> {
	await chrome.storage.local.set({ [RETRY_QUEUE_KEY]: queue });
	// Every writer of the retry queue (addToRetryQueue, retryQueuedPartsForUpload,
	// retryPendingUploads) funnels through here, so the alarm's lifecycle stays
	// in lockstep with the persisted queue by construction — it can't be created
	// without something to drain, or left running once drained.
	if (queue.length > 0) {
		chrome.alarms.create(RETRY_ALARM_NAME, {
			periodInMinutes: RETRY_ALARM_INTERVAL_MINUTES,
		});
	} else {
		chrome.alarms.clear(RETRY_ALARM_NAME);
	}
}

async function addToRetryQueue(
	item: Omit<RetryItem, "attempts" | "nextRetryAt">,
): Promise<void> {
	const queue = await getRetryQueue();
	queue.push({ ...item, attempts: 0, nextRetryAt: Date.now() + 1000 });
	await setRetryQueue(queue);
}

async function moveToDeadLetter(item: RetryItem): Promise<void> {
	const result = await chrome.storage.local.get(DEAD_LETTER_KEY);
	const dead = (result[DEAD_LETTER_KEY] as RetryItem[] | undefined) ?? [];
	dead.push(item);
	await chrome.storage.local.set({ [DEAD_LETTER_KEY]: dead });

	chrome.notifications.create({
		type: "basic",
		iconUrl: "/icons/icon-48.png",
		title: "data365 upload failed",
		message:
			"Upload failed and could not be recovered. This recording is lost — please re-record.",
	});
}

async function requireSettings(): Promise<ExtensionSettings> {
	const settings = await getSettings();
	if (!settings.apiKey) {
		throw new Error("[upload] apiKey is not configured in extension settings");
	}
	return settings;
}

async function uploadPart(
	partData: Uint8Array,
	partNumber: number,
	videoId: string,
	uploadId: string,
	settings: ExtensionSettings,
): Promise<CompletedPart> {
	const api = createCapApi(settings.apiBaseUrl, settings.apiKey);

	const { presignedUrl } = await api.presignPart({
		uploadId,
		partNumber,
		videoId,
		subpath: "result.mp4",
	});

	const putRes = await fetch(presignedUrl, {
		method: "PUT",
		headers: { "Content-Type": "application/octet-stream" },
		body: partData,
	});

	if (!putRes.ok) {
		const text = await putRes.text().catch(() => "");
		throw new Error(
			`[upload] PUT part ${partNumber} failed ${putRes.status}: ${text}`,
		);
	}

	const etag = putRes.headers.get("ETag");

	return {
		ETag: etag ? etag.replace(/"/g, "") : "RESOLVE_SERVER_SIDE",
		PartNumber: partNumber,
	};
}

async function recordCompletedPart(
	videoId: string,
	uploadId: string,
	completedPart: CompletedPart,
	partSize: number,
): Promise<void> {
	const state = await getState();

	if (
		(state.kind !== "recording" && state.kind !== "uploading") ||
		state.videoId !== videoId ||
		state.uploadId !== uploadId
	) {
		return;
	}

	const alreadyRecorded = state.parts.some(
		(part) => part.PartNumber === completedPart.PartNumber,
	);

	await setState({
		...state,
		parts: upsertCompletedPart(state.parts, completedPart),
		uploadedBytes: alreadyRecorded
			? state.uploadedBytes
			: state.uploadedBytes + partSize,
	});
}

function enqueuePartRetryPayload(
	partData: Uint8Array,
	partNumber: number,
	videoId: string,
	uploadId: string,
): Omit<RetryItem, "attempts" | "nextRetryAt"> {
	return {
		kind: "part",
		payload: {
			partNumber,
			videoId,
			uploadId,
			partDataBase64: bytesToBase64(partData),
		},
	};
}

function scheduleRetry(item: RetryItem, now: number): RetryItem | undefined {
	const nextAttempts = item.attempts + 1;
	if (nextAttempts >= MAX_ATTEMPTS) return undefined;

	const delaySec = BACKOFF_SECONDS[nextAttempts - 1] ?? 256;
	return {
		...item,
		attempts: nextAttempts,
		nextRetryAt: now + delaySec * 1000,
	};
}

async function retryQueuedPartsForUpload(
	videoId: string,
	uploadId: string,
	parts: CompletedPart[],
	settings: ExtensionSettings,
): Promise<{
	parts: CompletedPart[];
	failed: boolean;
	remainingPartsQueued: boolean;
}> {
	const queue = await getRetryQueue();
	const remaining: RetryItem[] = [];
	const now = Date.now();
	let nextParts = parts;
	let failed = false;

	for (const item of queue) {
		const payload =
			item.kind === "part" ? getPartRetryPayload(item) : undefined;
		if (item.kind !== "part") {
			remaining.push(item);
			continue;
		}

		if (!payload) {
			if (
				item.payload.videoId === videoId &&
				item.payload.uploadId === uploadId
			) {
				failed = true;
				await moveToDeadLetter(item);
			} else {
				remaining.push(item);
			}
			continue;
		}

		if (payload.videoId !== videoId || payload.uploadId !== uploadId) {
			remaining.push(item);
			continue;
		}

		try {
			const partData = base64ToBytes(payload.partDataBase64);
			const completedPart = await uploadPart(
				partData,
				payload.partNumber,
				payload.videoId,
				payload.uploadId,
				settings,
			);
			nextParts = upsertCompletedPart(nextParts, completedPart);
			await recordCompletedPart(
				payload.videoId,
				payload.uploadId,
				completedPart,
				partData.length,
			);
		} catch (err) {
			console.error("[upload] Queued part retry failed:", err);
			failed = true;

			const rescheduled = scheduleRetry(item, now);
			if (rescheduled) {
				remaining.push(rescheduled);
			} else {
				await moveToDeadLetter({ ...item, attempts: item.attempts + 1 });
			}
		}
	}

	const remainingPartsQueued = remaining.some(
		(item) =>
			item.kind === "part" &&
			item.payload.videoId === videoId &&
			item.payload.uploadId === uploadId,
	);
	await setRetryQueue(remaining);
	return { parts: nextParts, failed, remainingPartsQueued };
}

export async function initializeUpload(
	mode: "instruction" | "meeting",
	meetingId?: string,
): Promise<{ videoId: string; uploadId: string }> {
	const settings = await requireSettings();
	const api = createCapApi(settings.apiBaseUrl, settings.apiKey);

	const now = new Date();
	const dateStr = now.toLocaleDateString("en-GB", {
		day: "numeric",
		month: "long",
		year: "numeric",
	});
	const name =
		mode === "meeting" && meetingId
			? `data365 Meeting — ${meetingId}`
			: `data365 Recording — ${dateStr}`;

	const { id: videoId } = await api.createVideo({
		recordingMode: "extensionWeb",
		name,
		extensionContext: mode,
		meetingId,
	});

	const { uploadId } = await api.initiateMultipart({
		contentType: "video/webm",
		videoId,
		subpath: "result.mp4",
	});

	inMemoryBuffer = new Uint8Array(0);
	lastPersistedForUploadId = undefined;
	lastPersistAt = 0;
	lastPersistedLength = 0;

	return { videoId, uploadId };
}

/** Discard any pending-buffer persistence for an aborted/cancelled upload. */
export async function abortUpload(uploadId: string): Promise<void> {
	await clearPendingBuffer(uploadId);
}

export async function handleChunk(
	chunk: ArrayBuffer,
	_index: number,
	_mime: string,
): Promise<void> {
	const state = await getState();
	if (state.kind !== "recording") return;

	await restorePendingBufferIfNeeded(state.uploadId);

	const data = new Uint8Array(chunk);
	appendToBuffer(data);

	const newTotalBytes = state.totalBytes + data.length;

	// Slice off every fixed-MIN_PART_SIZE part the buffer now contains, keeping
	// only the (< MIN_PART_SIZE) remainder — R2 requires all non-trailing parts
	// to be the same size, so we must never upload a "whatever's in the buffer"
	// sized part (see takeFixedSizeParts).
	const { parts: fullParts, remainder } = takeFixedSizeParts(
		inMemoryBuffer,
		MIN_PART_SIZE,
	);

	if (fullParts.length === 0) {
		await maybePersistPendingBuffer(state.uploadId);
		await setState({ ...state, totalBytes: newTotalBytes });
		return;
	}

	inMemoryBuffer = remainder;
	// Persist the remainder rather than clear it: unlike the old drain-everything
	// path (which left nothing behind to lose), we now keep up to partSize-1
	// bytes in memory. Clearing here would leave those bytes RAM-only, so an SW
	// eviction before the next chunk would punch a hole in the middle of the
	// recording. Persist before the network calls so the window is never open.
	await persistPendingBuffer(state.uploadId);
	const settings = await requireSettings();

	let partNumber = state.nextPartNumber;

	for (const partData of fullParts) {
		try {
			const completedPart = await uploadPart(
				partData,
				partNumber,
				state.videoId,
				state.uploadId,
				settings,
			);

			const freshState = await getState();
			if (freshState.kind !== "recording") return;

			await setState({
				...freshState,
				parts: [...freshState.parts, completedPart],
				nextPartNumber: Math.max(freshState.nextPartNumber, partNumber + 1),
				totalBytes: Math.max(freshState.totalBytes, newTotalBytes),
				uploadedBytes: freshState.uploadedBytes + partData.length,
			});
		} catch (err) {
			console.error("[upload] Part upload failed:", err);
			await addToRetryQueue(
				enqueuePartRetryPayload(
					partData,
					partNumber,
					state.videoId,
					state.uploadId,
				),
			);

			const freshState = await getState();
			if (freshState.kind === "recording") {
				await setState({
					...freshState,
					nextPartNumber: Math.max(freshState.nextPartNumber, partNumber + 1),
					totalBytes: Math.max(freshState.totalBytes, newTotalBytes),
				});
			}
		}

		partNumber += 1;
	}
}

export async function finalizeUpload(): Promise<void> {
	const state = await getState();
	if (state.kind !== "recording" && state.kind !== "uploading") return;

	const settings = await requireSettings();
	const api = createCapApi(settings.apiBaseUrl, settings.apiKey);

	let parts = [...state.parts];
	let nextPartNumber =
		state.kind === "recording"
			? state.nextPartNumber
			: computeNextPartNumberForUploading(
					state.parts,
					await getRetryQueue(),
					state.videoId,
					state.uploadId,
				);
	const totalBytes = state.totalBytes;
	const uploadedBytes =
		"uploadedBytes" in state ? (state.uploadedBytes as number) : 0;
	const { videoId, uploadId } = state;

	// Restore any pending buffer an evicted-then-respawned SW never saw, BEFORE
	// computing durable bytes below — otherwise those bytes would look "lost"
	// even though they are still recoverable from chrome.storage.local.
	await restorePendingBufferIfNeeded(uploadId);

	// MIN_VIABLE_BYTES must count DURABLE bytes only: bytes already in
	// uploaded parts (uploadedBytes) plus whatever is still sitting in the
	// pending buffer right now (restored above if applicable). `totalBytes` is
	// a running counter that also includes bytes from a buffer that could have
	// been evicted before persistence caught up — using it here would let a
	// recording with genuinely-lost tail bytes pass the viability check.
	const durableBytes = uploadedBytes + inMemoryBuffer.length;

	const MIN_VIABLE_BYTES = 10 * 1024; // header-only mp4 is ~1.2KB; a real recording is far larger
	if (durableBytes < MIN_VIABLE_BYTES) {
		console.error(
			`[upload] Recording too small (${durableBytes} durable bytes) — refusing to publish a broken video.`,
		);
		await setState({
			kind: "error",
			reason:
				"Recording was too short — no video was captured. Please record for at least a couple of seconds and try again.",
			recoverable: true,
			previousVideoId: videoId,
		});
		return;
	}

	if (state.kind === "recording") {
		await setState({
			kind: "uploading",
			videoId,
			uploadId,
			parts,
			totalBytes,
			uploadedBytes,
		});
	}

	const remaining = drainBuffer();
	// The buffer's bytes are now either about to be uploaded directly or
	// handed to the retry queue (itself durable in chrome.storage.local) below
	// — either way they no longer need the separate pending-buffer copy.
	await clearPendingBuffer(uploadId);
	if (remaining.length > 0) {
		try {
			const completedPart = await uploadPart(
				remaining,
				nextPartNumber,
				videoId,
				uploadId,
				settings,
			);
			parts = [...parts, completedPart];
			nextPartNumber += 1;
		} catch (err) {
			console.error("[upload] Final part upload failed:", err);
			await addToRetryQueue(
				enqueuePartRetryPayload(remaining, nextPartNumber, videoId, uploadId),
			);
		}
	}

	const queuedPartsResult = await retryQueuedPartsForUpload(
		videoId,
		uploadId,
		parts,
		settings,
	);
	parts = queuedPartsResult.parts;

	if (queuedPartsResult.failed) {
		if (queuedPartsResult.remainingPartsQueued) {
			// (P1.6 / invariant b) At least one part is still queued for retry —
			// the multipart can still be completed once it lands, so this must NOT
			// dead-end in "error" with nothing durable behind it (that stranded a
			// fully-uploadable recording forever). Enqueue a durable, retryable
			// "complete" record and leave state at "uploading": the drain (retry
			// alarm / onStartup) will finish the job once the queued part(s)
			// succeed. recordCompletedPart keeps enriching `state.parts` on each
			// successful part retry because state stays "uploading".
			await addToRetryQueue({
				kind: "complete",
				payload: { uploadId, videoId },
			});
			return;
		}

		// No parts remain queued for this upload — the failure(s) above were
		// dead-lettered outright (no reschedule left), so there is nothing left
		// to retry and the recording cannot be completed. Terminal state.
		await setState({
			kind: "error",
			reason: "Upload part retry failed. Check network and try again.",
			recoverable: true,
			previousVideoId: videoId,
		});
		return;
	}

	if (parts.length === 0) {
		const bufferLen = remaining.length;
		console.error(
			`[upload] No parts uploaded — cannot complete multipart. totalBytes=${totalBytes}, remainingBuffer=${bufferLen}`,
		);
		await setState({
			kind: "error",
			reason:
				totalBytes === 0
					? "No recording data was captured. Check screen-capture permissions and try again."
					: `Upload failed — ${totalBytes} bytes captured but no parts uploaded. Check network or try again.`,
			recoverable: true,
			previousVideoId: videoId,
		});
		return;
	}

	await setState({ kind: "finishing", videoId });

	try {
		const apiParts = parts.map((p) => ({
			partNumber: p.PartNumber,
			etag: p.ETag,
			size: 0,
		}));
		await api.completeMultipart({
			uploadId,
			parts: apiParts,
			videoId,
			subpath: "result.mp4",
		});
	} catch (err) {
		console.error("[upload] completeMultipart failed:", err);
		await addToRetryQueue({
			kind: "complete",
			payload: {
				uploadId,
				videoId,
				parts: parts.map((p) => ({
					partNumber: p.PartNumber,
					etag: p.ETag,
					size: 0,
				})),
			},
		});
		await setState({
			kind: "error",
			reason: `Upload finalization failed: ${err instanceof Error ? err.message : String(err)}`,
			recoverable: true,
			previousVideoId: videoId,
		});
		return;
	}

	try {
		await api.recordingComplete({ videoId });
	} catch (err) {
		console.error("[upload] recordingComplete failed:", err);
		await addToRetryQueue({
			kind: "recording-complete",
			payload: { videoId },
		});
	}

	const shareUrl = `${settings.apiBaseUrl}/s/${videoId}`;
	await setState({ kind: "complete", videoId, shareUrl });
}

export async function retryPendingUploads(): Promise<void> {
	const queue = await getRetryQueue();
	if (queue.length === 0) return;

	const settings = await getSettings();
	if (!settings.apiKey) return;

	const api = createCapApi(settings.apiBaseUrl, settings.apiKey);
	const now = Date.now();

	const remaining: RetryItem[] = [];

	for (const item of queue) {
		if (item.nextRetryAt > now) {
			remaining.push(item);
			continue;
		}

		if (item.kind === "complete") {
			const { uploadId, videoId } = item.payload as {
				uploadId: string;
				videoId: string;
			};
			// (P1.6 / invariant b) A sibling "part" item for the same upload is
			// still in the queue — completing now would call R2 with a partial
			// part list and produce a truncated video. Defer without consuming an
			// attempt; the next drain pass (once the part has resolved) retries.
			const siblingPartsQueued = queue.some(
				(other) =>
					other !== item &&
					other.kind === "part" &&
					other.payload.videoId === videoId &&
					other.payload.uploadId === uploadId,
			);
			if (siblingPartsQueued) {
				remaining.push(item);
				continue;
			}
		}

		try {
			if (item.kind === "part") {
				const payload = getPartRetryPayload(item);
				if (!payload) {
					await moveToDeadLetter(item);
					continue;
				}

				const partData = base64ToBytes(payload.partDataBase64);
				const completedPart = await uploadPart(
					partData,
					payload.partNumber,
					payload.videoId,
					payload.uploadId,
					settings,
				);
				await recordCompletedPart(
					payload.videoId,
					payload.uploadId,
					completedPart,
					partData.length,
				);
			} else if (item.kind === "complete") {
				const {
					uploadId,
					videoId,
					parts: snapshotParts,
				} = item.payload as {
					uploadId: string;
					videoId: string;
					parts?: Array<{ partNumber: number; etag: string; size: number }>;
				};

				// The P1.6 durable-completion record carries no parts snapshot (it
				// was enqueued before all parts were known) — read the live,
				// durably-tracked state instead, which recordCompletedPart has kept
				// enriched on every successful part retry above. The legacy
				// completeMultipart-failure record (enqueued elsewhere, once all
				// parts were already final) still carries its own snapshot; use it
				// directly.
				let parts = snapshotParts;
				if (!parts) {
					const liveState = await getState();
					parts =
						liveState.kind === "uploading" &&
						liveState.videoId === videoId &&
						liveState.uploadId === uploadId
							? liveState.parts.map((p) => ({
									partNumber: p.PartNumber,
									etag: p.ETag,
									size: 0,
								}))
							: [];
				}

				await api.completeMultipart({
					uploadId,
					parts,
					videoId,
					subpath: "result.mp4",
				});

				try {
					await api.recordingComplete({ videoId });
				} catch (recErr) {
					console.error(
						"[upload] recordingComplete failed after drained complete:",
						recErr,
					);
					// Push directly into `remaining` (not addToRetryQueue): this loop
					// writes the queue exactly once via setRetryQueue(remaining) after
					// the loop below, so a separate get-then-set here would be
					// clobbered by that final write.
					remaining.push({
						kind: "recording-complete",
						payload: { videoId },
						attempts: 0,
						nextRetryAt: Date.now() + 1000,
					});
				}

				await setState({
					kind: "complete",
					videoId,
					shareUrl: `${settings.apiBaseUrl}/s/${videoId}`,
				});
			} else if (item.kind === "recording-complete") {
				const { videoId } = item.payload as { videoId: string };
				await api.recordingComplete({ videoId });
			}
		} catch (err) {
			console.error(`[upload] Retry failed for ${item.kind}:`, err);
			const rescheduled = scheduleRetry(item, now);
			if (!rescheduled) {
				await moveToDeadLetter({ ...item, attempts: item.attempts + 1 });
			} else {
				remaining.push(rescheduled);
			}
		}
	}

	await setRetryQueue(remaining);
}

export async function checkApiHealth(): Promise<boolean> {
	try {
		const settings = await getSettings();
		const res = await fetch(`${settings.apiBaseUrl}/api/status`, {
			headers: { Authorization: `Bearer ${settings.apiKey}` },
		});
		return res.ok;
	} catch {
		return false;
	}
}
