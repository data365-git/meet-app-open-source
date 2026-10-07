/**
 * Bulk transcript download from the selection bar (spec 2026-10-07): one ZIP,
 * inside it one .txt per selected video with a transcript — the SAME content
 * the existing per-video download serves (GET /api/videos/:id/transcript),
 * fetched one video at a time. Videos without a transcript (404) and fetch
 * failures are named in a `transkript-yoq.txt` note inside the ZIP and in the
 * toast.
 *
 * The naming helpers are PURE (unit-tested in
 * __tests__/unit/bulk-transcript-zip.test.ts); the fetch loop mirrors
 * `runBulkAiStarts` (sequential, injectable fetch, never throws for one
 * failure); the ZIP assembly uses the already-present `jszip`.
 */
import JSZip from "jszip";

/**
 * Characters no mainstream file system allows in a name, plus control/format
 * characters (`\p{C}` = control, format, surrogate, private-use, unassigned —
 * written as a unicode class so no literal control character sits in the
 * regex source).
 */
const ILLEGAL_FILENAME_CHARS = /[\\/:*?"<>|\p{C}]/gu;

export const MISSING_NOTE_FILE_NAME = "transkript-yoq.txt";

/**
 * Make a video name safe as a file name: strip `\/:*?"<>|` and control
 * characters, collapse whitespace runs, trim, cap at 120 characters, and fall
 * back to "nomsiz" when nothing readable is left.
 */
export function sanitizeTranscriptFileName(name: string): string {
	const cleaned = name
		.replace(ILLEGAL_FILENAME_CHARS, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 120)
		.trim();
	return cleaned.length > 0 ? cleaned : "nomsiz";
}

/**
 * De-duplicate a list of file names in order: the first "a.txt" stays, the
 * next becomes "a (2).txt", then "a (3).txt"… The counter is inserted before
 * the LAST extension (none at all for extension-less names), and generated
 * names are reserved too, so a video genuinely called "a (2)" cannot collide.
 */
export function dedupeFileNames(names: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];

	for (const name of names) {
		if (!seen.has(name)) {
			seen.add(name);
			result.push(name);
			continue;
		}
		const dot = name.lastIndexOf(".");
		const rawBase = dot > 0 ? name.slice(0, dot) : name;
		const ext = dot > 0 ? name.slice(dot) : "";
		// Strip a trailing " (N)" so "a (2).txt" colliding with the generated
		// "a (2).txt" becomes "a (3).txt", not "a (2) (2).txt".
		const base = rawBase.replace(/ \(\d+\)$/, "");
		for (let n = 2; ; n++) {
			const candidate = `${base} (${n})${ext}`;
			if (!seen.has(candidate)) {
				seen.add(candidate);
				result.push(candidate);
				break;
			}
		}
	}

	return result;
}

/**
 * The content of `transkript-yoq.txt`: one video name per line, missing
 * transcripts ("transkripti yo'q") and fetch failures ("xato") under separate
 * headings. Null when every transcript made it into the ZIP — no empty note
 * file should sit between real transcripts.
 */
export function buildMissingNote(input: {
	missing: string[];
	failed: string[];
}): string | null {
	if (input.missing.length === 0 && input.failed.length === 0) return null;

	const sections: string[] = [];
	if (input.missing.length > 0) {
		sections.push(
			["Quyidagi videolarning transkripti yo'q:", ...input.missing].join("\n"),
		);
	}
	if (input.failed.length > 0) {
		sections.push(
			[
				"Quyidagi videolarning transkripti yuklab olinmadi (xato):",
				...input.failed,
			].join("\n"),
		);
	}
	return sections.join("\n\n");
}

export type BulkTranscriptCap = {
	id: string;
	/** The video's display name — becomes the .txt file name (sanitized). */
	name: string;
};

export type BulkTranscriptResults = {
	/** Successful transcripts in selection order, with raw video names. */
	files: { name: string; text: string }[];
	/** Videos that answered 404 — no transcript (yet). */
	missing: string[];
	/** Videos whose fetch failed (other status / network error). */
	failed: string[];
};

/**
 * Fetch every selected video's transcript SEQUENTIALLY via the existing
 * per-video download route (one at a time, on purpose — same rule as
 * `runBulkAiStarts`). 200 with a text/plain body -> text; 404 -> missing;
 * anything else -> failed, including a 200 that was redirected (a login
 * page) or answers with a non-text/plain content type, a fetch that throws
 * (network error) and a per-request 60s timeout (AbortSignal). One bad
 * video never aborts the batch, and the loop itself never throws.
 * `onProgress(done, total)` fires after each video for the progress toast.
 */
export async function fetchBulkTranscripts(
	caps: BulkTranscriptCap[],
	onProgress?: (done: number, total: number) => void,
	fetchImpl: typeof fetch = fetch,
): Promise<BulkTranscriptResults> {
	const results: BulkTranscriptResults = {
		files: [],
		missing: [],
		failed: [],
	};

	for (const [i, cap] of caps.entries()) {
		try {
			const res = await fetchImpl(`/api/videos/${cap.id}/transcript`, {
				// Per-request timeout: a hung connection must fail THAT video,
				// never hang the whole batch (a timeout abort throws and is
				// caught below as a normal failure).
				signal: AbortSignal.timeout(60_000),
			});
			if (!res.ok) {
				if (res.status === 404) results.missing.push(cap.name);
				else results.failed.push(cap.name);
			} else {
				// A wrong 200 — a redirect to a login page or an HTML error body —
				// must never be saved as a .txt transcript.
				const contentType = res.headers.get("content-type") ?? "";
				if (res.redirected || !contentType.toLowerCase().startsWith("text/plain")) {
					results.failed.push(cap.name);
				} else {
					results.files.push({ name: cap.name, text: await res.text() });
				}
			}
		} catch {
			results.failed.push(cap.name);
		}
		onProgress?.(i + 1, caps.length);
	}

	return results;
}

/**
 * Assemble the ZIP: one sanitized, de-duplicated `<video name>.txt` per
 * successful transcript, plus the `transkript-yoq.txt` note when anything is
 * missing/failed. Returns null when ZERO transcripts succeeded — the caller
 * shows one toast.error instead of downloading an empty archive.
 */
export async function buildBulkTranscriptZip(
	results: BulkTranscriptResults,
): Promise<Blob | null> {
	if (results.files.length === 0) return null;

	const zip = new JSZip();
	const note = buildMissingNote({
		missing: results.missing,
		failed: results.failed,
	});
	// Reserve the note's name FIRST when a note will be written, so a video
	// literally called "transkript-yoq" is renamed to "transkript-yoq (2).txt"
	// instead of silently overwriting the note (or being overwritten by it).
	const deduped = dedupeFileNames([
		...(note ? [MISSING_NOTE_FILE_NAME] : []),
		...results.files.map((f) => `${sanitizeTranscriptFileName(f.name)}.txt`),
	]);
	const fileNames = note ? deduped.slice(1) : deduped;
	results.files.forEach((file, i) => {
		zip.file(fileNames[i] as string, file.text);
	});

	if (note) zip.file(MISSING_NOTE_FILE_NAME, note);

	return zip.generateAsync({ type: "blob" });
}

/** `transkriptlar-YYYY-MM-DD.zip` in local time, like the owner asked. */
export function bulkTranscriptZipName(now: Date = new Date()): string {
	const y = now.getFullYear();
	const m = `${now.getMonth() + 1}`.padStart(2, "0");
	const d = `${now.getDate()}`.padStart(2, "0");
	return `transkriptlar-${y}-${m}-${d}.zip`;
}

/**
 * Trigger the browser download from a Blob object URL and revoke the URL
 * right after (no anchor left pointing at memory).
 */
export function downloadBlob(blob: Blob, fileName: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = fileName;
	document.body.appendChild(a);
	a.click();
	a.remove();
	// Revoking in the same tick can cancel the download in Firefox.
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}
