/**
 * Which dashboard library a video belongs to: Recordings or Meetings.
 *
 * This lives OUTSIDE the server action on purpose. `actions/videos/set-library-kind.ts`
 * is a `"use server"` module, and such a module may only export async functions —
 * exporting a plain const from it fails the Next build (71011) even though `tsc`
 * is happy, because it is a framework rule rather than a type rule.
 *
 * `null` in the column means "never explicitly moved": classification then falls
 * back to the original `videos.source` JSON, which is how every video recorded
 * before this column existed keeps landing in the right library.
 */
export const LIBRARY_KINDS = ["recording", "meeting"] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

/**
 * A drag payload carries the library the card is being dragged FROM as its own
 * MIME type, e.g. `application/cap-from-recording`.
 *
 * It has to be a type rather than a field on the JSON payload because during
 * `dragover` the browser runs in "protected mode": only `dataTransfer.types` is
 * readable, `getData()` returns "" until the actual drop. Encoding the source
 * library in the type name is therefore the only way a drop target can decide
 * MID-DRAG whether it would accept — which is what lets Recordings stay unlit
 * while a recording is dragged over it.
 */
export function libraryDragType(kind: LibraryKind): string {
	return `application/cap-from-${kind}`;
}

export function isLibraryKind(value: unknown): value is LibraryKind {
	return (
		typeof value === "string" &&
		(LIBRARY_KINDS as readonly string[]).includes(value)
	);
}
