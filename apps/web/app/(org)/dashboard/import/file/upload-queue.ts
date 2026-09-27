/**
 * Multi-file import queue (owner order 2026-09-10, re-confirmed 2026-09-26):
 * pick up to 20 files, they upload strictly one after another, a waiting file
 * can be dropped from the queue and the current one cancelled — after which
 * the queue CONTINUES with the next file.
 *
 * Pure module, no React, no imports: the async loop it drives keeps running
 * after the component that started it unmounts, so it must not hold onto any
 * component state. Everything dynamic is injected (upload / isRemoved /
 * onStart), which is also what makes it testable without mounting anything.
 */

export const MAX_BATCH_FILES = 20;

/**
 * Take the first MAX_BATCH_FILES items, report how many were dropped.
 * Pure; used by useImportUpload.processFiles and pinned by unit tests.
 */
export function capBatch<T>(files: T[]): { taken: T[]; dropped: number } {
	if (files.length <= MAX_BATCH_FILES) {
		return { taken: files, dropped: 0 };
	}
	return {
		taken: files.slice(0, MAX_BATCH_FILES),
		dropped: files.length - MAX_BATCH_FILES,
	};
}

export interface UploadQueueItem {
	id: string;
	file: File;
}

export interface UploadQueueResult {
	uploaded: number;
	notUploaded: number;
	removed: number;
}

/**
 * Sequential upload loop. NEVER parallel: each upload is awaited before the
 * next starts, and a thrown error counts as notUploaded while the loop
 * CONTINUES (one bad file must not sink the rest of the batch).
 *
 * Per item, in order:
 *  1. `isRemoved(id)` → true: count `removed`, never touch the file.
 *  2. `onStart(index, id)` (the item is about to be uploaded).
 *  3. `await upload(file)` → id string counts `uploaded`; null/undefined
 *     (cancelled or failed — the caller's own path already toasted the
 *     reason) counts `notUploaded`. A rejection also counts `notUploaded`.
 */
export async function runUploadQueue(opts: {
	items: UploadQueueItem[];
	upload: (file: File) => Promise<string | null>;
	isRemoved: (id: string) => boolean;
	onStart?: (index: number, id: string) => void;
}): Promise<UploadQueueResult> {
	let uploaded = 0;
	let notUploaded = 0;
	let removed = 0;

	for (let index = 0; index < opts.items.length; index++) {
		const item = opts.items[index];
		if (!item) continue;

		if (opts.isRemoved(item.id)) {
			removed++;
			continue;
		}

		opts.onStart?.(index, item.id);

		try {
			const result = await opts.upload(item.file);
			if (result != null) {
				uploaded++;
			} else {
				notUploaded++;
			}
		} catch {
			// The loop continues: the next file still gets its turn.
			notUploaded++;
		}
	}

	return { uploaded, notUploaded, removed };
}

/**
 * The waiting list after `startingId` begins uploading: shrink the LIVE list,
 * never rebuild it from the original batch — rebuilding would put back a file
 * the user already removed with ✕ (bug caught in review 2026-09-27).
 */
export function queueAfterStart<T extends { id: string }>(
	liveQueue: readonly T[] | undefined,
	startingId: string,
): T[] {
	return (liveQueue ?? []).filter((entry) => entry.id !== startingId);
}
