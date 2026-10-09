import { createHash, timingSafeEqual } from "node:crypto";

// Server-only on purpose: lib/hermes-meeting.ts is also imported by the
// client dialog, and node:crypto there breaks the production webpack build.

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
