/**
 * Daily per-browser (or per-user) question limit for the share-page AI chat.
 * The counter lives in the `ai_chat_usage` table keyed by
 * (videoId, clientId, dateUtc) and is incremented atomically before each
 * request; a request that pushes the count past the limit is rejected.
 */
export const DAILY_CHAT_LIMIT = 20;

/** Error code returned (HTTP 429) when the daily chat limit is exhausted. */
export const DAILY_CHAT_LIMIT_CODE = "daily_limit";

/** Cookie that identifies an anonymous browser for chat rate limiting. */
export const AI_CHAT_CLIENT_COOKIE = "ai_chat_cid";

export function isOverDailyChatLimit(count: number): boolean {
	return count > DAILY_CHAT_LIMIT;
}

/**
 * Per-video daily TOTAL cap across ALL anonymous guests combined (A3 —
 * spoof-proof guest-chat backstop, no IP trust). The per-client cap above is
 * keyed by clientId, which for a guest is just a cookie value — clearing
 * cookies resets it to zero. This second cap is keyed by videoId ALONE: the
 * sum of every guest clientId's `requestCount` for (videoId, dateUtc) in the
 * same `ai_chat_usage` table. A cookie-clearing abuser keeps resetting their
 * own per-client count, but every reset still adds to this video-wide total,
 * so they eventually hit a wall no cookie reset can escape.
 *
 * Deliberately 10x DAILY_CHAT_LIMIT so a single legitimate guest conversation
 * is never blocked by it — only many multiples of the per-client cap on one
 * video trips it. Enforce this ALONGSIDE isOverDailyChatLimit (both must
 * pass); it does not replace the per-client check.
 *
 * Signed-in members must NOT count toward this total. No schema migration is
 * needed to exclude them: a signed-in request's clientId is always that
 * user's real `users.id`, while a guest clientId is a random per-browser
 * value that never collides with one, so the caller can compute `totalCount`
 * as SUM(requestCount) for (videoId, dateUtc) restricted to clientIds that do
 * NOT match any row in `users` (e.g. a LEFT JOIN users ... WHERE users.id IS
 * NULL, or an equivalent NOT IN/NOT EXISTS against `users.id`).
 */
export const GUEST_VIDEO_DAILY_CHAT_LIMIT = 200;

export function isOverGuestVideoDailyLimit(totalCount: number): boolean {
	return totalCount > GUEST_VIDEO_DAILY_CHAT_LIMIT;
}
