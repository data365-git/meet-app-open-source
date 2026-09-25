"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { makeCurrentUserLayer, Videos } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { runPromise } from "@/lib/server";

/**
 * Owner order 2026-09-11: a Cancel control on an in-progress import upload,
 * that also removes whatever bytes were already sent — "cancelda yuklangan
 * qism ham o'chib ketishi kk".
 *
 * Permanently discards a video the current user just started uploading and
 * is now cancelling before it finished. Deliberately NOT the Trash path
 * (soft-delete -> 3-day retention, see purge-trashed-videos): there is
 * nothing worth keeping from an upload that never completed, and leaving one
 * in Trash would let a half-file silently occupy quota and confuse "what is
 * this" for three days. Reuses the same proven Videos.permanentlyDelete path
 * `deleteAccount` already calls (storage objects first, row last, idempotent
 * — safe to call twice if the client retries), rather than hand-rolling a
 * second copy of that logic.
 *
 * SAFETY: refuses unless the row is still genuinely mid-upload — never
 * reachable once transcription has started or a processingStartedAt marker
 * exists, so a Cancel button can never discard a real, finished-or-finishing
 * recording, whatever the client sends.
 */
export async function cancelUpload(
	videoId: Video.VideoId,
): Promise<{ ok: true } | { ok: false; error: string }> {
	const user = await getCurrentUser();
	if (!user) return { ok: false, error: "Not authenticated" };

	const [video] = await db()
		.select({
			id: videos.id,
			ownerId: videos.ownerId,
			transcriptionStatus: videos.transcriptionStatus,
			metadata: videos.metadata,
		})
		.from(videos)
		.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)))
		.limit(1);

	// Nothing to cancel is success, not an error: the client may retry a
	// cancel whose response was lost, or race a background purge.
	if (!video) return { ok: true };

	const metadata = video.metadata as VideoMetadata | null;
	const processingStarted =
		video.transcriptionStatus !== null ||
		typeof metadata?.processingStartedAt === "string";
	if (processingStarted) {
		return {
			ok: false,
			error:
				"This recording already started processing and can no longer be cancelled.",
		};
	}

	try {
		await runPromise(
			Effect.gen(function* () {
				const videosService = yield* Videos;
				yield* videosService.permanentlyDelete(videoId);
			}).pipe(Effect.provide(makeCurrentUserLayer(user))),
		);
	} catch (error) {
		console.error("cancelUpload: permanentlyDelete failed", error);
		return {
			ok: false,
			error: "Could not cancel the upload. Please try again.",
		};
	}

	return { ok: true };
}
