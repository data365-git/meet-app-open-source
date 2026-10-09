"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";

export async function triggerInstantRecordingProcessing({
	videoId,
}: {
	videoId: Video.VideoId;
}): Promise<{ success: boolean }> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Unauthorized");

	const rawFileKey = `${user.id}/${videoId}/result.mp4`;

	await startVideoProcessingWorkflow({
		videoId,
		userId: user.id,
		rawFileKey,
		bucketId: video.bucket ?? null,
		processingMessage: "Starting video processing...",
		startFailureMessage: "Video uploaded, but processing could not start.",
		// The instant-recording single PUT already finished (uploaded >= total)
		// by the time this runs, so "multipart" here isn't about transport — it
		// tells lib/transcribe.ts's isUploadInProgress to trust the "processing"
		// phase over the byte count while processVideoWorkflow remuxes the file,
		// so a manual "AI tahlil" click can't race in mid-overwrite. The share
		// page briefly shows "processing" (CapVideoPlayer) during the — normally
		// fast, copy-path — remux, then plays. See the matching comment in
		// app/api/upload/[...route]/multipart.ts's finalize branch.
		mode: "multipart",
	});

	return { success: true };
}
