import { createHash, timingSafeEqual } from "node:crypto";
import type { VideoMetadata } from "@cap/database/types";

/**
 * Pure core of the "meeting -> Hermes CRM" delivery (ADR 2026-10-08).
 *
 * The Mac-side puller polls GET /api/hermes/meetings/queue with a shared
 * secret, writes `YYYY-MM-DD_<clientName>_<company>_meet.txt` into
 * ~/.hermes/crm-agent/data/meetings/ and POSTs an ack. Everything here is
 * pure: no DB, no env, no clock reads — the routes and server actions pass
 * everything in, so the contract (file name, token gate, selection, ack) is
 * unit-testable without a database.
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
 * dots and trailing dots/spaces — both are stripped after the swap.
 */
// \p{Cc} = Unicode control characters (the C0 range + DEL) — exactly what a
// Windows file name must not contain, written as a property escape so no
// literal control character appears in the source.
const ILLEGAL_FILENAME_CHARS = /[\p{Cc}/:"*?<>|]/gu;

function sanitizeNamePart(raw: string): string {
	return raw
		.replace(ILLEGAL_FILENAME_CHARS, "")
		.replace(/\s+/g, "_")
		.replace(/\.+/g, (dots, i: number, whole: string) =>
			// Strip leading/trailing dot runs; keep interior dots ("A. Co").
			i === 0 || i + dots.length === whole.length ? "" : dots,
		)
		.replace(/_+$/, "");
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
 * Gate for both queue routes. Unset token = the feature is off (503, not a
 * broken 500); wrong/missing token = 401. The comparison is constant-time via
 * SHA-256 digests + timingSafeEqual, so an attacker measuring response time
 * learns nothing about the token's contents or length.
 */
export function checkHermesQueueToken(
	authorizationHeader: string | null,
	expectedToken: string | undefined,
): { ok: true } | { ok: false; status: 401 | 503 } {
	if (typeof expectedToken !== "string" || expectedToken.length === 0) {
		return { ok: false, status: 503 };
	}
	const header = authorizationHeader ?? "";
	// The auth-scheme is case-insensitive per RFC 9110; the token itself is not.
	const match = /^bearer\s+(.+)$/i.exec(header.trim());
	if (!match) return { ok: false, status: 401 };
	const presented = match[1] ?? "";
	const a = createHash("sha256").update(presented).digest();
	const b = createHash("sha256").update(expectedToken).digest();
	return timingSafeEqual(a, b) ? { ok: true } : { ok: false, status: 401 };
}

/** Queue selection predicate: queued for Hermes AND transcript COMPLETE. */
export function isHermesQueueEligible(row: {
	transcriptionStatus: string | null;
	metadata: VideoMetadata | null;
}): boolean {
	return (
		row.transcriptionStatus === "COMPLETE" &&
		row.metadata?.hermes?.status === "queued"
	);
}

/** Pure slice of GET /queue: only queued+COMPLETE rows, at most `max`. */
export function selectHermesQueueItems<
	T extends {
		transcriptionStatus: string | null;
		metadata: VideoMetadata | null;
	},
>(rows: T[], max = 20): T[] {
	return rows.filter(isHermesQueueEligible).slice(0, max);
}

/**
 * Pure slice of POST /ack: queued -> delivered with the file name the Mac
 * actually used. Idempotent — an already-delivered row comes back unchanged
 * (the route answers success without rewriting deliveredAt).
 */
export function applyHermesAck(
	current: VideoMetadata,
	fileName: string,
	now: string,
): VideoMetadata {
	if (current.hermes?.status === "delivered") return current;
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

type LibraryKindLike = string | null;

/**
 * Same rule as `libraryKindMeetingFilter` in lib/dashboard-data.ts, evaluated
 * in JS on a row already fetched: trust `libraryKind` when set; when NULL fall
 * back to the captured-as-meeting predicate on the immutable `source` JSON.
 */
export function isInMeetingsLibrary(video: {
	libraryKind: LibraryKindLike;
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
