import type { VideoMetadata } from "@cap/database/types";

/**
 * Pure core of the "meeting -> Hermes CRM" delivery (ADR 2026-10-08).
 *
 * The Mac-side puller polls GET /api/hermes/meetings/queue with a shared
 * secret, writes `YYYY-MM-DD_<clientName>_<company>_meet.txt` into
 * ~/.hermes/crm-agent/data/meetings/ and POSTs an ack. Everything here is
 * pure: no DB, no env — the routes and server actions pass everything in, so
 * the contract (file name, token gate, selection, ack) is unit-testable
 * without a database. The one clock read is buildHermesMeetingFileName's
 * invalid-date fallback to "now".
 */

export type HermesMeetingState = NonNullable<VideoMetadata["hermes"]>;

/** The dialog's text inputs: both required after trimming, max 60 chars. */
export const HERMES_CLIENT_FIELD_MAX_LENGTH = 60;

export function validateHermesClientFields(
	clientName: unknown,
	company: unknown,
): { clientName: string; company: string } | null {
	if (typeof clientName !== "string" || typeof company !== "string")
		return null;
	const name = clientName.trim();
	const org = company.trim();
	if (name.length === 0 || org.length === 0) return null;
	if (
		name.length > HERMES_CLIENT_FIELD_MAX_LENGTH ||
		org.length > HERMES_CLIENT_FIELD_MAX_LENGTH
	) {
		return null;
	}
	return { clientName: name, company: org };
}

/**
 * Characters a file name must not contain on macOS (/:) or Windows
 * (\ / : * ? " < > | plus C0 control chars). Windows also dislikes leading
 * dots and trailing dots/spaces — leading dots are stripped in the swap,
 * trailing dot/underscore runs after it.
 */
// \p{Cc} = Unicode control characters (the C0 range + DEL) — exactly what a
// Windows file name must not contain, written as a property escape so no
// literal control character appears in the source.
const ILLEGAL_FILENAME_CHARS = /[\p{Cc}\\/:*?"<>|]/gu;

function sanitizeNamePart(raw: string): string {
	return raw
		.replace(ILLEGAL_FILENAME_CHARS, "")
		.replace(/\s+/g, "_")
		.replace(/\.+/g, (dots, i: number, whole: string) =>
			// Strip leading/trailing dot runs; keep interior dots ("A. Co").
			i === 0 || i + dots.length === whole.length ? "" : dots,
		)
		// Strip the trailing run AFTER the space->underscore swap, so a
		// trailing dot hiding behind a stripped trailing space/underscore
		// ("A. " -> "A._") cannot survive ("A").
		.replace(/[._]+$/, "");
}

/** Asia/Tashkent calendar date as YYYY-MM-DD (Tashkent is UTC+5, no DST). */
function tashkentDateLabel(recordedAt: Date): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone: "Asia/Tashkent",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(recordedAt);
}

/**
 * `YYYY-MM-DD_<clientName>_<company>_meet.txt` — the naming convention of the
 * files already sitting in the Hermes CRM folder. Date is the RECORDING date
 * (customCreatedAt ?? createdAt upstream) in Asia/Tashkent, so a meeting held
 * at 21:00 Tashkent time is not filed under the previous day.
 */
export function buildHermesMeetingFileName(input: {
	clientName: string;
	company: string;
	recordedAt: Date | string;
}): string {
	const recordedAt =
		typeof input.recordedAt === "string"
			? new Date(input.recordedAt)
			: input.recordedAt;
	const date = Number.isNaN(recordedAt.getTime())
		? tashkentDateLabel(new Date())
		: tashkentDateLabel(recordedAt);
	const client = sanitizeNamePart(input.clientName) || "Mijoz";
	const company = sanitizeNamePart(input.company) || "Kompaniya";
	return `${date}_${client}_${company}_meet.txt`;
}

/**
 * Pure slice of POST /ack: ONLY queued -> delivered with the file name the Mac
 * actually used. Anything else (a re-acked delivered row, a declined or failed
 * one) comes back unchanged — the route answers 404 for the non-delivered
 * cases instead of resurrecting them.
 */
export function applyHermesAck(
	current: VideoMetadata,
	fileName: string,
	now: string,
): VideoMetadata {
	if (current.hermes?.status !== "queued") return current;
	return {
		...current,
		hermes: {
			...current.hermes,
			status: "delivered",
			deliveredAt: now,
			fileName,
		},
	};
}

/**
 * Same rule as `libraryKindMeetingFilter` in lib/dashboard-data.ts, evaluated
 * in JS on a row already fetched: trust `libraryKind` when set; when NULL fall
 * back to the captured-as-meeting predicate on the immutable `source` JSON.
 */
export function isInMeetingsLibrary(video: {
	libraryKind: string | null;
	source: unknown;
}): boolean {
	if (video.libraryKind === "meeting") return true;
	if (video.libraryKind !== null) return false;
	const source = video.source as
		| { type?: unknown; context?: unknown }
		| null
		| undefined;
	return source?.type === "extensionWeb" && source?.context === "meeting";
}
