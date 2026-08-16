import type { VideoMetadata } from "@cap/database/types";

export function requestAiGenerationAfterTranscription({
	metadata,
	requestedAt,
	requestedBy,
}: {
	metadata: VideoMetadata;
	requestedAt: string;
	requestedBy: string;
}): VideoMetadata {
	return {
		...metadata,
		aiGenerationRequestedAt: requestedAt,
		aiGenerationRequestedBy: requestedBy,
	};
}

/**
 * Did a user explicitly ask for AI analysis on this video, with that request
 * still outstanding? The marker is written by the generate route whenever it
 * cannot start the pipeline right away (transcription already PROCESSING, or
 * the upload/processing not finished yet), and it is what makes the request
 * survive the wait — read by the transcription workflow when the transcript
 * lands, by processVideoWorkflow when processing finishes, and by the
 * recover-stale-ai-jobs cron as the restart-proof safety net.
 */
export function hasPendingAiGenerationRequest(
	metadata: VideoMetadata,
): boolean {
	return (
		typeof metadata.aiGenerationRequestedAt === "string" &&
		metadata.aiGenerationRequestedAt.length > 0
	);
}

export function shouldStartAiAfterTranscription({
	metadata,
	aiGenerationEnabled,
}: {
	metadata: VideoMetadata;
	aiGenerationEnabled: boolean;
}): boolean {
	return aiGenerationEnabled || hasPendingAiGenerationRequest(metadata);
}
