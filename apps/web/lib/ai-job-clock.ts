import type { VideoMetadata } from "@cap/database/types";

// Pure lifecycle helpers for the per-job 4h "aiJobStartedAt" clock (spec §5 C6,
// bug #8). No side-effect imports so both the workflow set/clear sites and the
// unit tests can use them without a circular dependency.

/**
 * The start of a job's 4h clock. A retry, Batch-collection re-kick, or paid
 * continuation preserves the current job's original start; a genuinely NEW
 * analysis has no existing value (it was cleared on the previous terminal) and
 * gets a fresh start. Keeping the `existing ?? now` shape here documents that
 * intent in one tested place.
 */
export function resolveAiJobStartedAt(
	existing: string | undefined,
	nowIso: string,
): string {
	return existing ?? nowIso;
}

/**
 * Drop the job's 4h clock on a terminal AI phase (transcription or generation
 * COMPLETE) so a LATER brand-new analysis does not inherit a stale timestamp and
 * immediately flip to paid. Retries/re-kicks never call this — they keep the
 * clock via resolveAiJobStartedAt.
 */
export function clearAiJobClock(metadata: VideoMetadata): VideoMetadata {
	return { ...metadata, aiJobStartedAt: undefined };
}
