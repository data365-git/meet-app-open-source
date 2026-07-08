import { db } from "@cap/database";
import { videos } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import type { Video } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { startAiGeneration } from "@/lib/generate-ai";
import { transcribeVideo } from "@/lib/transcribe";

export type AiJobPhase = "transcription" | "generation";

type ContinueOnPaidResult = {
	success: boolean;
	message: string;
};

export async function continueAiJobOnPaid({
	videoId,
	ownerId,
	phase,
}: {
	videoId: Video.VideoId;
	ownerId: string;
	phase: AiJobPhase;
}): Promise<ContinueOnPaidResult> {
	const [row] = await db()
		.select({
			metadata: videos.metadata,
		})
		.from(videos)
		.where(eq(videos.id, videoId))
		.limit(1);

	if (!row) {
		return { success: false, message: "Video does not exist" };
	}

	const metadata = (row.metadata as VideoMetadata) || {};
	const nextMetadata: VideoMetadata = {
		...metadata,
		aiMode: "fast",
		aiQuotaWaiting: undefined,
		processingStartedAt: undefined,
		aiProcessingStartedAt: undefined,
	};

	if (phase === "transcription") {
		await db()
			.update(videos)
			.set({
				transcriptionStatus: null,
				metadata: nextMetadata,
			})
			.where(eq(videos.id, videoId));
		return transcribeVideo(videoId, ownerId, true, false, "fast");
	}

	await db()
		.update(videos)
		.set({
			metadata: {
				...nextMetadata,
				aiGenerationStatus: undefined,
			} as VideoMetadata,
		})
		.where(eq(videos.id, videoId));
	return startAiGeneration(videoId, ownerId, {
		force: true,
		speedModeOverride: "fast",
	});
}
