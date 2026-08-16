import type { VideoMetadata } from "@cap/database/types";

export type TranscriptionStatusValue =
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED"
	| "NO_AUDIO";

export type AiGenerationStatusValue =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

/**
 * Has the user's explicit "start AI analysis" press been BANKED but not yet
 * claimed by the pipeline?
 *
 * Two server-side facts back this, and nothing else:
 *  - `metadata.aiStartPendingUpload` — the one-shot start order the generate
 *    route writes when the press arrives while the upload is still processing.
 *    A redeemer (processVideoWorkflow / the recover-stale-ai-jobs cron)
 *    JSON_REMOVEs it the moment it takes the job, so it is self-clearing.
 *  - `metadata.aiGenerationRequestedAt` — the durable "the user wants AI" flag.
 *    It is NEVER cleared, so on its own it would pin the panel to "pending"
 *    forever; it only counts here while `transcriptionStatus` is still NULL,
 *    i.e. inside the window between the press and the workflow claiming the
 *    row. That window is closed by SERVER state (the status flipping to
 *    PROCESSING), not by a client-side timeout guess.
 *
 * Anything terminal or already-running wins over this: a real failure
 * (transcription ERROR / SKIPPED / NO_AUDIO, or aiGenerationStatus ERROR)
 * returns false so the panel falls through to its error branch and the owner
 * keeps the retry button — a pending flag must never trap a dead job.
 */
export function isAiRequestPending({
	transcriptionStatus,
	aiGenerationStatus,
	aiStartPendingUpload,
	aiGenerationRequestedAt,
}: {
	transcriptionStatus?: TranscriptionStatusValue | null;
	aiGenerationStatus?: AiGenerationStatusValue | null;
	aiStartPendingUpload?: string | null;
	aiGenerationRequestedAt?: string | null;
}): boolean {
	// Terminal or in-flight AI: the panel's own done/running/error branches are
	// authoritative there.
	if (aiGenerationStatus) return false;
	// A transcription that failed, was skipped, or has no audio is terminal too;
	// and PROCESSING / COMPLETE mean the press was already claimed.
	if (transcriptionStatus) return false;

	if (
		typeof aiStartPendingUpload === "string" &&
		aiStartPendingUpload.length > 0
	)
		return true;

	return (
		typeof aiGenerationRequestedAt === "string" &&
		aiGenerationRequestedAt.length > 0
	);
}

/**
 * The three facts the share page's status poll must report so the panel can
 * render a truthful state without a manual page refresh. Shared by the
 * `/api/video/ai` GET handler and by ShareVideo's first (server-rendered)
 * paint, so both sides derive "pending" from exactly the same rule.
 */
export function buildAiStatusFacts({
	transcriptionStatus,
	metadata,
}: {
	transcriptionStatus?: TranscriptionStatusValue | string | null;
	metadata: VideoMetadata;
}): {
	transcriptionStatus: TranscriptionStatusValue | null;
	aiGenerationStatus: AiGenerationStatusValue | null;
	aiRequestPending: boolean;
} {
	const transcription = (transcriptionStatus ??
		null) as TranscriptionStatusValue | null;
	const aiGenerationStatus =
		(metadata.aiGenerationStatus as AiGenerationStatusValue | undefined) ??
		null;
	return {
		transcriptionStatus: transcription,
		aiGenerationStatus,
		aiRequestPending: isAiRequestPending({
			transcriptionStatus: transcription,
			aiGenerationStatus,
			aiStartPendingUpload: metadata.aiStartPendingUpload ?? null,
			aiGenerationRequestedAt: metadata.aiGenerationRequestedAt ?? null,
		}),
	};
}
