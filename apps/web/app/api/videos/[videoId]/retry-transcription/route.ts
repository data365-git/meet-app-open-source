import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { transcriptChunks, videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { transcribeVideo } from "@/lib/transcribe";

export async function POST(
	request: Request,
	props: RouteContext<"/api/videos/[videoId]/retry-transcription">,
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

		// Verify user owns the video
		const videoQuery = await db()
			.select()
			.from(videos)
			.where(eq(videos.id, videoId))
			.limit(1);

		if (videoQuery.length === 0) {
			return Response.json({ error: "Video not found" }, { status: 404 });
		}

		const video = videoQuery[0];
		if (!video || video.ownerId !== user.id) {
			return Response.json({ error: "Unauthorized" }, { status: 403 });
		}

		// Re-running transcription re-spends paid AI budget. If a transcript
		// already completed, require an explicit confirm/force flag before
		// deleting it and paying to redo the work.
		let confirmed = false;
		try {
			const body = (await request.json()) as
				| { confirm?: unknown; force?: unknown }
				| null;
			confirmed = body?.confirm === true || body?.force === true;
		} catch {
			// No/invalid JSON body — treat as not confirmed (fail closed).
		}

		if (video.transcriptionStatus === "COMPLETE" && !confirmed) {
			return Response.json(
				{
					error:
						"This video already has a transcript. Pass confirm to re-run (this costs money).",
				},
				{ status: 409 },
			);
		}

		await db()
			.delete(transcriptChunks)
			.where(eq(transcriptChunks.videoId, videoId));

		// Reset the status, then START the pipeline ourselves. Nothing auto-
		// triggers on a NULL status anymore (get-status.ts stopped doing that —
		// its comment says "no auto-trigger"), so leaving the row NULL here left
		// the video permanently not-started. The reset is still required first:
		// transcribeVideo refuses COMPLETE rows outright, and this is the one
		// path where re-running a COMPLETE transcript is an explicit, confirmed
		// owner decision.
		await db()
			.update(videos)
			.set({ transcriptionStatus: null })
			.where(eq(videos.id, videoId));

		const result = await transcribeVideo(videoId, user.id, true);
		if (!result.success) {
			return Response.json({ error: result.message }, { status: 500 });
		}

		// Revalidate the video page to ensure UI updates with fresh data
		revalidatePath(`/s/${videoId}`);

		return Response.json({
			success: true,
			message: "Transcription retry triggered",
		});
	} catch (error) {
		console.error("Error resetting transcription status:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
