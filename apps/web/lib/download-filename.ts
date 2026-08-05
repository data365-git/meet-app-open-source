/**
 * Turn a recording's title into a safe download filename.
 *
 * ONE helper, used by every download in the product. Before this existed the
 * rule was hand-rolled inline in ShareHeader and simply absent everywhere else —
 * transcripts downloaded as the literal "transcript.txt" for every recording, so
 * five meetings produced five identical filenames and became unidentifiable in a
 * downloads folder. A sanitiser copy-pasted into three places drifts on the first
 * edge case; this repo has already been bitten by that exact twin problem (the
 * ffmpeg `-pipe:1` typo lived in two functions and only one was reported).
 *
 * The title is UNTRUSTED: a user can rename a recording to anything, including
 * path separators, so the output must never be able to escape a filename
 * position — hence separators collapse and leading dots are stripped.
 */

/** Windows' MAX_PATH leaves little room; 80 is comfortably inside every OS. */
const MAX_BASE_LENGTH = 80;

/** What a title becomes when it sanitises down to nothing (e.g. "///" or "🎉"). */
const FALLBACK_BASE = "recording";

/**
 * @param title     the recording's current title, as the owner last set it
 * @param extension file extension WITHOUT the dot, e.g. "mp3", "txt", "srt"
 */
export function downloadFilename(
	title: string | null | undefined,
	extension: string,
): string {
	return `${downloadFilenameBase(title)}.${extension}`;
}

/**
 * The sanitised stem, without an extension. Exported for tests and for callers
 * that build their own suffix.
 */
export function downloadFilenameBase(title: string | null | undefined): string {
	const cleaned = (title ?? "")
		.normalize("NFKC")
		// KEEP letters and digits in ANY script — the team titles recordings in
		// Uzbek ("Jahon School CRM Optimallashtirish"), and an ASCII-only rule
		// would reduce a Cyrillic title to a row of underscores. Spaces, dots and
		// hyphens read naturally in a filename, so they stay too. Everything else
		// — path separators, control characters, and the characters Windows
		// reserves (: * ? " < > |) — collapses to a single underscore.
		.replace(/[^\p{L}\p{N}. _-]+/gu, "_")
		.replace(/\s+/g, " ")
		.replace(/_+/g, "_")
		.trim()
		// A leading dot makes a hidden file on unix and can read as a traversal
		// segment; a title of "..\..\etc" must not survive as one.
		.replace(/^[._\s]+/, "")
		.slice(0, MAX_BASE_LENGTH)
		// Both the trim above and the slice can leave a trailing separator.
		.replace(/[._\s]+$/, "");

	return cleaned.length > 0 ? cleaned : FALLBACK_BASE;
}
