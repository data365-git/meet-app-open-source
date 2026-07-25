import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { transcriptChunks, videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { serverEnv } from "@cap/env";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { startAiGeneration } from "@/lib/generate-ai";
import { transcribeVideo } from "@/lib/transcribe";

/**
 * Manual trigger for the full AI pipeline (transcript -> summary -> refined).
 * Transcription/AI no longer run automatically; the owner starts them here.
 * transcribeVideo(..., aiGenerationEnabled=true) transcribes and chains into
 * AI summary/refined generation.
 */
export async function POST(
	_request: Request,
	props: RouteContext<"/api/videos/[videoId]/generate">,
) {
	try {
		const user = await getCurrentUser();
		if (!user) {
			return Response.json({ error: "Unauthorized" }, { status: 401 });
		}

		if (!serverEnv().GEMINI_API_KEY) {
			return Response.json(
				{ error: "AI is not configured (missing GEMINI_API_KEY)" },
				{ status: 400 },
			);
		}

		const { videoId } = (await props.params) as { videoId: Video.VideoId };
		if (!videoId) {
			return Response.json({ error: "Video ID is required" }, { status: 400 });
		}

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

		const currentMeta = (video.metadata as VideoMetadata) || {};
		const {
			aiGenerationStatus: _ai,
			summary: _summary,
			chapters: _chapters,
			aiSummary: _aiSummary,
			aiTitle: _aiTitle,
			...restMeta
		} = currentMeta;

		// If the transcript already exists, regenerate ONLY the AI
		// (summary/tasks/refine) from it — avoids re-transcribing the whole
		// audio, which wastes time and API quota.
		if (video.transcriptionStatus === "COMPLETE") {
			await db()
				.update(videos)
				.set({ metadata: restMeta })
				.where(eq(videos.id, videoId));

			await startAiGeneration(videoId, video.ownerId);
			revalidatePath(`/s/${videoId}`);
			return Response.json({
				success: true,
				message: "Summary generation started",
			});
		}

		// No transcript yet — run the full pipeline (transcribe -> chain into AI).
		await db()
			.delete(transcriptChunks)
			.where(eq(transcriptChunks.videoId, videoId));

		await db()
			.update(videos)
			.set({ transcriptionStatus: null, metadata: restMeta })
			.where(eq(videos.id, videoId));

		const result = await transcribeVideo(
			videoId,
			video.ownerId,
			/* aiGenerationEnabled */ true,
		);

		revalidatePath(`/s/${videoId}`);

		return Response.json({
			success: result.success,
			message: result.message ?? "Generation started",
		});
	} catch (error) {
		console.error("Error starting AI generation:", error);
		return Response.json({ error: "Internal server error" }, { status: 500 });
	}
}
