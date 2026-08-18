import type { VideoMetadata } from "@cap/database/types";
import { hasPendingAiGenerationRequest } from "./ai-generation-request";

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
/**
 * A stage is treated as ABSENT once its last write is older than this. The
 * writer (workflows/process-video.ts, PROCESSING_PROGRESS_THROTTLE_MS)
 * throttles updates to at most one every 5s while a run is alive, so a live
 * run never goes this long between writes — only a killed worker leaves the
 * three metadata keys stranded that long. A few minutes, not seconds, so a
 * normal gap between throttled writes never gets misread as dead.
 */
export const PROCESSING_STAGE_STALE_MS = 5 * 60 * 1000;

/**
 * Interprets the raw `processingStage`/`processingPercent`/`processingUpdatedAt`
 * metadata trio, discarding a stage whose last write is stale (see
 * `PROCESSING_STAGE_STALE_MS`) rather than showing a phantom overlay forever.
 * Shared by the `/api/video/ai` GET handler so every poll response — and by
 * extension both ShareVideo and CapCard, which only ever read the poll's
 * `processingStage`/`processingPercent` — apply the same rule in one place.
 */
export function buildProcessingProgress({
	metadata,
	now = Date.now(),
}: {
	metadata: Pick<
		VideoMetadata,
		"processingStage" | "processingPercent" | "processingUpdatedAt"
	>;
	now?: number;
}): {
	processingStage: VideoMetadata["processingStage"] | null;
	processingPercent: number | null;
	processingUpdatedAt: string | null;
} {
	const updatedAt = metadata.processingUpdatedAt ?? null;
	const isStale =
		updatedAt != null &&
		now - new Date(updatedAt).getTime() > PROCESSING_STAGE_STALE_MS;
	return {
		processingStage: isStale ? null : (metadata.processingStage ?? null),
		processingPercent: isStale ? null : (metadata.processingPercent ?? null),
		processingUpdatedAt: updatedAt,
	};
}

/**
 * FINDING 1: once the poll has ANY data, it is authoritative — a poll that
 * authoritatively reports `null` must clear a stale server-rendered value
 * rather than falling through to it via `??`. Shared by ShareVideo and
 * CapCard, which each apply this same rule to their own poll/prop pair
 * (processingStage and processingPercent).
 */
export function pollAuthoritativeValue<T>(
	hasPollData: boolean,
	pollValue: T,
	serverValue: T,
): T {
	return hasPollData ? pollValue : serverValue;
}

/**
 * FINDING 4: should a card whose poller is not running yet turn it ON
 * because a LATER prop refresh brought in a fresh `processingStage`? The
 * mount-time seed only covers the FIRST paint's prop — without this, a card
 * that starts processing after the dashboard tab is already open never
 * starts polling, so its indicator never appears.
 */
export function shouldActivateProcessingPoll(
	processingActive: boolean,
	metadataProcessingStage: unknown,
): boolean {
	return !processingActive && metadataProcessingStage != null;
}

/**
 * How long `aiGenerationRequestedAt` may still mean "a generation run is about
 * to start". The real gap is two "use step" boundaries after
 * `transcriptionStatus:"COMPLETE"` — a partial-file delete and a temp-audio
 * cleanup — i.e. seconds. Ten minutes is therefore far outside the normal
 * path on purpose: stopping the poll EARLY would re-create the very freeze
 * this family of fixes exists to remove, while stopping it LATE only costs a
 * few background requests on one open tab.
 */
export const AI_GENERATION_HANDOFF_MAX_MS = 10 * 60 * 1000;

export function buildAiStatusFacts({
	transcriptionStatus,
	metadata,
	now = Date.now(),
}: {
	transcriptionStatus?: TranscriptionStatusValue | string | null;
	metadata: VideoMetadata;
	/** Injectable so the staleness rule is assertable without faking a clock. */
	now?: number;
}): {
	transcriptionStatus: TranscriptionStatusValue | null;
	aiGenerationStatus: AiGenerationStatusValue | null;
	aiRequestPending: boolean;
	/**
	 * FINDING 1: the durable "the user wants AI" flag (`aiGenerationRequestedAt`,
	 * never cleared once set — see ai-generation-request.ts). Distinct from
	 * `aiRequestPending`, which only covers the one-shot upload-in-progress
	 * banking order: the pipeline writes `transcriptionStatus:"COMPLETE"` several
	 * "use step" boundaries before `generate-ai.ts` finally writes
	 * `aiGenerationStatus:"QUEUED"`, and a poll landing in that gap must not
	 * treat the video as terminal just because nothing has appeared yet.
	 */
	aiGenerationRequested: boolean;
	/**
	 * Is that durable flag too OLD to still mean "a run is about to start"?
	 * Without this the flag above is a one-way latch: nothing clears
	 * `aiGenerationRequestedAt`, so a workflow KILLED inside the handoff gap
	 * would hold the client's poll open for as long as the tab stays open.
	 * Computed HERE, on the server, against the same clock that wrote the
	 * marker — the client's device clock can be hours off.
	 */
	aiGenerationRequestStale: boolean;
} {
	const transcription = (transcriptionStatus ??
		null) as TranscriptionStatusValue | null;
	const aiGenerationStatus =
		(metadata.aiGenerationStatus as AiGenerationStatusValue | undefined) ??
		null;
	// An unparseable or missing marker is NOT stale: `aiGenerationRequested` is
	// false in that case anyway, so nothing is holding the poll open to bound.
	const requestedAtMs = Date.parse(
		typeof metadata.aiGenerationRequestedAt === "string"
			? metadata.aiGenerationRequestedAt
			: "",
	);
	return {
		transcriptionStatus: transcription,
		aiGenerationStatus,
		aiRequestPending: isAiRequestPending({
			transcriptionStatus: transcription,
			aiGenerationStatus,
			aiStartPendingUpload: metadata.aiStartPendingUpload ?? null,
		}),
		aiGenerationRequested: hasPendingAiGenerationRequest(metadata),
		aiGenerationRequestStale:
			Number.isFinite(requestedAtMs) &&
			now - requestedAtMs > AI_GENERATION_HANDOFF_MAX_MS,
	};
}
