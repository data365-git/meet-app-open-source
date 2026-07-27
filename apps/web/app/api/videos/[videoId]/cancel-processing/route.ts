import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/**
 * Cooperative cancellation of an in-flight transcription. Sets
 * `metadata.cancelRequested = true`; the transcribe workflow checks this between
 * chunk batches and settles the video as CANCELLED at its next checkpoint (a
 * running background job can't be force-killed, but it stops making further
 * Gemini calls). Owner-only.
 */
export async function POST(
	_request: Request,
	props: RouteContext<"/api/videos/[videoId]/cancel-processing">,
) {
	try {
		const user = await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		const { videoId } = (await props.params) as { videoId: Video.VideoId };
		if (!videoId) {
			return Response.json({ error: "Video ID is required" }, { status: 400 });
		}

		const videoQuery = await db()
			.select({
				ownerId: videos.ownerId,
				transcriptionStatus: videos.transcriptionStatus,
			})
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);

		const video = videoQuery[0];
		if (!video) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}
		if (video.ownerId !== user.id) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		// Only meaningful while transcription is running.
		if (video.transcriptionStatus !== "PROCESSING") {
			return Response.json(
				{ error: "Nothing to cancel", transcriptionStatus: video.transcriptionStatus },
				{ status: 409 },
			);
		}

		await db()
			.update(videos)
			.set({
				metadata: sql`JSON_SET(COALESCE(${videos.metadata}, '{}'), '$.cancelRequested', true)`,
			})
			.where(eq(videos.id, videoId));

		revalidatePath(`/s/${videoId}`);

		return Response.json({ success: true, message: "Cancellation requested" });
	} catch (error) {
		console.error("Error cancelling processing:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
