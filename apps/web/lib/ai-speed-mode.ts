/**
 * Org-level transcription speed/cost mode.
 *   fast  = synchronous Gemini generateContent (default; lowest latency).
 *   cheap = Gemini Batch API (~50% cheaper, slower — minutes not seconds).
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
