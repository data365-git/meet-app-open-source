import type { VideoMetadata } from "@cap/database/types";

/**
 * "An AI generation job is running on this video" - extracted 1:1 from
 * CapCard's former inline `aiRunning` expression so the card and the bulk-AI
 * planner (lib/bulk-ai.ts) can never drift apart. Lives in its own tiny module
 * (2026-10-07 review F6) so CapCard does not have to import the pricing code
 * that ships with the planner.
 */
export const isAiJobRunning = (metadata?: VideoMetadata | null): boolean =>
	metadata?.aiGenerationStatus === "PROCESSING" ||
	metadata?.aiGenerationStatus === "QUEUED";
