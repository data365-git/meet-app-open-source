import { db } from "@cap/database";
import { users } from "@cap/database/schema";
import { makeCurrentUserLayer, Videos } from "@cap/web-backend";
import type { User, Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";
import { runPromiseExit } from "@/lib/server";

export type PurgeOutcome = "purged" | "skipped_no_owner" | "failed";

/**
 * Permanently delete ONE trashed video by running the SAME
 * Videos.permanentlyDelete the user-facing delete-permanent route and account
 * erasure use — storage FIRST, database row LAST, idempotent, with ownership
 * re-checked against the video's own row.
 *
 * The cron impersonates the video's OWNER via makeCurrentUserLayer on
 * purpose: that is REQUIRED reuse of the authorization-checking path, not a
 * bypass — permanentlyDelete verifies video.ownerId === CurrentUser.id, so a
 * mis-paired identity fails before any storage or row access. Do NOT
 * "simplify" this into a raw repo/db delete; that twin would skip the
 * ownership check and the storage-first ordering.
 *
 * A failed purge leaves the row in place (permanentlyDelete deletes storage
 * before the row), so the video stays eligible and the next nightly run
 * retries it.
 */
export async function purgeTrashedVideo(
	videoId: Video.VideoId,
	ownerId: User.UserId,
): Promise<PurgeOutcome> {
	const [owner] = await db().select().from(users).where(eq(users.id, ownerId));

	// No owner row means no honest CurrentUser can be built. Skip rather than
	// delete under another identity — cleaning up ownerless rows belongs to
	// the account-erasure flow, not a cron that bypasses the ownership check.
	if (!owner) return "skipped_no_owner";

	const exit = await Effect.gen(function* () {
		const videos = yield* Videos;
		yield* videos.permanentlyDelete(videoId);
	}).pipe(Effect.provide(makeCurrentUserLayer(owner)), runPromiseExit);

	return Exit.isSuccess(exit) ? "purged" : "failed";
}
