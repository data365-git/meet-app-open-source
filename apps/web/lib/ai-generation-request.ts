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

/**
 * Is there an OUTSTANDING one-shot order to start the pipeline for a request
 * the user made while the upload was still processing? Unlike
 * `aiGenerationRequestedAt` — a durable "the user wants AI" flag that nothing
 * ever clears — this marker is written only by the generate route's
 * UPLOAD_IN_PROGRESS branch and is JSON_REMOVE'd the moment either redeemer
 * (processVideoWorkflow, the recover-stale-ai-jobs cron) takes it. Without
 * that split, the cron's pending-request query meant "every video that ever
 * had a request and is currently unclaimed" and re-started paid work forever.
 */
export function hasPendingUploadStartOrder(metadata: VideoMetadata): boolean {
	return (
		typeof metadata.aiStartPendingUpload === "string" &&
		metadata.aiStartPendingUpload.length > 0
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
