"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { Effect, Schedule } from "effect";
import { runPromise } from "@/lib/server";
import { startVideoProcessingWorkflow } from "@/lib/video-processing";
import { getStorageAccessForVideo } from "@/lib/video-storage";

async function verifyRawFileUploaded(
	video: typeof videos.$inferSelect,
	rawFileKey: string,
) {
	const [bucket] = await getStorageAccessForVideo(video).pipe(runPromise);
	const head = await bucket
		.headObject(rawFileKey)
		.pipe(
			Effect.retry({ times: 3, schedule: Schedule.exponential("100 millis") }),
			runPromise,
		);

	if ((head.ContentLength ?? 0) <= 0) {
		throw new Error("Uploaded video file is empty");
	}
}

export async function triggerVideoProcessing({
	videoId,
	rawFileKey,
	bucketId,
}: {
	videoId: Video.VideoId;
	rawFileKey: string;
	bucketId: string | null;
}): Promise<{ success: boolean }> {
	const user = await getCurrentUser();
	if (!user) throw new Error("Unauthorized");

	const [video] = await db()
		.select()
		.from(videos)
		.where(eq(videos.id, videoId));

	if (!video) throw new Error("Video not found");
	if (video.ownerId !== user.id) throw new Error("Unauthorized");

	await verifyRawFileUploaded(video, rawFileKey);

	await startVideoProcessingWorkflow({
		videoId,
		userId: user.id,
		rawFileKey,
		bucketId,
		processingMessage: "Starting video processing...",
		startFailureMessage: "Video processing could not start.",
		// The import upload already finished (bytes are fully in storage by the
		// time this runs — verifyRawFileUploaded just confirmed it), so
		// videoUploads.uploaded >= total is already true. Without mode set to
		// "multipart" here, lib/transcribe.ts's isUploadInProgress would treat
		// that byte-complete row as NOT in progress despite phase="processing",
		// letting a manual "AI tahlil" click race in mid-remux. See the matching
		// comment in app/api/upload/[...route]/multipart.ts's finalize branch.
		mode: "multipart",
	});

	return { success: true };
}
