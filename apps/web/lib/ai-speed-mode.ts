/**
 * Org-level transcription speed/cost mode.
 *   fast  = synchronous Gemini generateContent (default; lowest latency).
 *   cheap = patient free-tier first; quota waits are retried by cron, then
 *           auto-continue on paid after the configured patience window.
 *
 * Stored in `organizations.settings.aiSpeedMode`. Read once at workflow start
 * and threaded through the transcription steps as a plain string (the workflow
 * `"use step"` boundary requires JSON-serializable args).
 */
export type AiSpeedMode = "fast" | "cheap";

export const DEFAULT_AI_SPEED_MODE: AiSpeedMode = "fast";

export function isAiSpeedMode(value: unknown): value is AiSpeedMode {
	return value === "fast" || value === "cheap";
}

/** Normalize any stored/unknown value to a valid mode, defaulting to `fast`. */
export function resolveAiSpeedMode(value: unknown): AiSpeedMode {
	return isAiSpeedMode(value) ? value : DEFAULT_AI_SPEED_MODE;
}
