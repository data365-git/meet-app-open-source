/**
 * The title a newly uploaded recording starts with.
 *
 * Lives OUTSIDE the server action that uses it, and that is not a style choice:
 * `actions/video/create-for-processing.ts` is a `"use server"` module, and such a
 * module may export ONLY async functions. Exporting a plain helper from it passes
 * `tsc` and fails `next build` with rule 71011 — a framework rule, not a type
 * rule, so no amount of typechecking catches it. That exact mistake shipped and
 * had to be undone earlier the same day (see `lib/library-kind.ts`).
 */

/** Longer than any title anyone reads; guards the column and the UI. */
const MAX_TITLE_LENGTH = 120;

/**
 * Remove control characters without touching anything a human typed.
 *
 * A code-point loop rather than a regex character class, deliberately: while this
 * was being written the line was rewritten twice — once by a scripted patch, once
 * by the formatter — and each time it became a different character range whose
 * effect was not obvious by eye (one of them would have deleted spaces, turning
 * "Bitrix24 meeting" into "Bitrix24meeting"). A loop cannot be mangled that way
 * and says exactly what it does.
 */
function stripControlChars(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.codePointAt(0) ?? 0;
		if (code >= 0x20 && code !== 0x7f) out += ch;
	}
	return out;
}

/**
 * Derive a recording's starting title from the file the user actually chose.
 *
 * Returns null when there is nothing usable, so the caller falls back to its
 * template name rather than creating a blank-titled recording. The filename is
 * CLIENT input: any path is stripped, so a crafted name cannot smuggle a
 * directory into the title, and the extension goes because ".mp4" is noise in a
 * list of meetings.
 */
export function titleFromFileName(fileName?: string): string | null {
	if (!fileName) return null;
	const base = stripControlChars(fileName)
		// Both separators: a Windows client sends "C:\Users\me\meeting.mp4".
		.split(/[\\/]/)
		.pop()
		?.replace(/\.[^.]+$/, "")
		.trim()
		.slice(0, MAX_TITLE_LENGTH)
		.trim();
	return base && base.length > 0 ? base : null;
}
