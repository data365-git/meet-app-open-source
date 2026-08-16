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
 * EXACTLY ONE server-side fact backs this: `metadata.aiStartPendingUpload` —
 * the one-shot start order the generate route writes when the press arrives
 * while the upload is still processing. A redeemer (processVideoWorkflow / the
 * recover-stale-ai-jobs cron) JSON_REMOVEs it the moment it takes the job, so
 * it is self-clearing, and its presence means something really will run.
 *
 * `metadata.aiGenerationRequestedAt` is deliberately NOT a source here, and the
 * first version of this file got that wrong. It is the durable "the user once
 * wanted AI" flag; nothing ever clears it and NO redeemer reads it (both the
 * recover-stale-ai-jobs cron and `ai-generation-request.ts` key on
 * `aiStartPendingUpload` alone, for exactly this reason). Keying on it renders
 * a permanent "queued" screen with no button on any row whose
 * `transcriptionStatus` is NULL while no job exists — e.g. after an operator
 * resets a row.
 *
 * The owner's original bug stays fixed without it — but be precise about WHY,
 * because "the generate route writes both markers" is NOT true of every branch.
 * Only the UPLOAD_IN_PROGRESS branch writes `aiStartPendingUpload` beside
 * `aiGenerationRequestedAt`, and that is exactly the reported case: the press
 * arrived while the upload was still processing. The other banking branch
 * (transcription already PROCESSING) writes `aiGenerationRequestedAt` alone and
 * needs nothing here — its `transcriptionStatus` is truthy, so this function
 * returns false at the guard below and the panel's running branch owns that
 * screen.
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
}: {
	transcriptionStatus?: TranscriptionStatusValue | null;
	aiGenerationStatus?: AiGenerationStatusValue | null;
	aiStartPendingUpload?: string | null;
}): boolean {
	// Terminal or in-flight AI: the panel's own done/running/error branches are
	// authoritative there.
	if (aiGenerationStatus) return false;
	// A transcription that failed, was skipped, or has no audio is terminal too;
	// and PROCESSING / COMPLETE mean the press was already claimed.
	if (transcriptionStatus) return false;

	return (
		typeof aiStartPendingUpload === "string" && aiStartPendingUpload.length > 0
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
		}),
	};
}
