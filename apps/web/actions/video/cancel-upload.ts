"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { makeCurrentUserLayer, Videos } from "@cap/web-backend";
import type { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import { getAffectedRows } from "@/lib/affected-rows";
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
 * SAFETY: refuses unless the row is still genuinely mid-upload — a
 * video_uploads row in phase 'uploading' must exist, and transcription must
 * not have started nor a processingStartedAt marker exist — so a Cancel
 * button can never discard a real, finished-or-finishing recording, whatever
 * the client sends.
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
	const refused = {
		ok: false as const,
		error:
			"This recording already started processing and can no longer be cancelled.",
	};
	if (processingStarted) return refused;

	// Race-safety: claim the upload by a CONDITIONAL delete of its
	// video_uploads row (only while phase = 'uploading') and proceed only if
	// that delete hit a row. A separate read-then-delete would leave a window
	// where /complete flips the row to 'processing' between the two; the
	// conditional delete is one atomic statement. Once the row is gone,
	// transitionVideoToProcessing (lib/video-processing.ts) updates zero rows
	// and throws "No upload record found", so processing can no longer start
	// on a video this call is about to erase. The row is read first only to
	// restore it if the erase below fails, so a retried Cancel still works.
	const [upload] = await db()
		.select()
		.from(videoUploads)
		.where(eq(videoUploads.videoId, videoId))
		.limit(1);
	if (!upload || upload.phase !== "uploading") return refused;

	const claim = await db()
		.delete(videoUploads)
		.where(
			and(
				eq(videoUploads.videoId, videoId),
				eq(videoUploads.phase, "uploading"),
			),
		);
	if (getAffectedRows(claim) === 0) return refused;

	try {
		await runPromise(
			Effect.gen(function* () {
				const videosService = yield* Videos;
				yield* videosService.permanentlyDelete(videoId);
			}).pipe(Effect.provide(makeCurrentUserLayer(user))),
		);
	} catch (error) {
		console.error("cancelUpload: permanentlyDelete failed", error);
		try {
			await db().insert(videoUploads).values(upload);
		} catch (restoreError) {
			console.error("cancelUpload: restoring upload row failed", restoreError);
		}
		return {
			ok: false,
			error: "Could not cancel the upload. Please try again.",
		};
	}

	return { ok: true };
}
