"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos, videoUploads } from "@cap/database/schema";
import { Video } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";
import { persistableProcessingError } from "@/lib/processing-error";

/**
 * Marks a videoUploads row as phase="error" for a video the current user owns.
 * Called on mid-upload failure to prevent the row staying stuck at "uploading".
 * Safe to call even if the row has already been removed.
 */
export async function markUploadFailed(videoId: Video.VideoId): Promise<void> {
	const user = await getCurrentUser();
	if (!user) return;

	// Verify ownership before touching any row.
	const [owned] = await db()
		.select({ id: videos.id })
		.from(videos)
		.where(and(eq(videos.id, videoId), eq(videos.ownerId, user.id)))
		.limit(1);

	if (!owned) return;

	// A failure must be VISIBLE (round-19 #2): a bare { phase: "error" } left
	// both text columns NULL, so the owner never learned his upload died.
	// The stage is named statically; the cause is known here (the client
	// reported a mid-upload failure) and goes through the same allowlist as
	// every other writer.
	await db()
		.update(videoUploads)
		.set({
			phase: "error",
			processingMessage: "Uploading",
			processingError: persistableProcessingError("Upload interrupted"),
			updatedAt: new Date(),
		})
		.where(eq(videoUploads.videoId, videoId));
}
