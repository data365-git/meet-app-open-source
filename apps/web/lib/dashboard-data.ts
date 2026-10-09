import { videos } from "@cap/database/schema";
import { sql } from "drizzle-orm";

/**
 * Shared dashboard query predicates.
 *
 * A video lives in exactly one of the two dashboard libraries: Meetings or
 * Recordings (a.k.a. "Caps"/Instructions). `videos.libraryKind` is the
 * authoritative answer, but it is nullable — rows created before the column
 * existed, and rows nobody has ever moved, are still NULL.
 *
 * So classification is: trust `libraryKind` when it is set, and only when it
 * IS NULL fall back to the legacy predicate that infers the library from the
 * immutable `source` JSON (`source.type = 'extensionWeb'` AND
 * `source.context = 'meeting'` means it was captured as a meeting).
 *
 * `source` is the record of HOW a video was captured and is never rewritten;
 * moving a video between libraries writes ONLY `libraryKind`.
 *
 * These two filters are exact complements: every non-deleted video matches
 * exactly one of them, so the Meetings and Recordings lists can never double
 * count or drop a row.
 */

/** True when the video was captured through the extension's meeting flow. */
const capturedAsMeeting = sql`(JSON_UNQUOTE(JSON_EXTRACT(${videos.source}, '$.type')) = 'extensionWeb' AND JSON_UNQUOTE(JSON_EXTRACT(${videos.source}, '$.context')) = 'meeting')`;

/** Rows that belong in the Meetings library. */
export const libraryKindMeetingFilter = sql`(${videos.libraryKind} = 'meeting' OR (${videos.libraryKind} IS NULL AND ${capturedAsMeeting}))`;

/** Rows that belong in the Recordings / Caps library (the exact complement). */
export const libraryKindRecordingFilter = sql`(${videos.libraryKind} = 'recording' OR (${videos.libraryKind} IS NULL AND NOT ${capturedAsMeeting}))`;
