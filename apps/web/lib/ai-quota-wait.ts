export class AiQuotaWaitError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "AiQuotaWaitError";
	}
}

export function isAiQuotaWaitError(error: unknown): error is AiQuotaWaitError {
	return (
		error instanceof AiQuotaWaitError ||
		(error instanceof Error && error.name === "AiQuotaWaitError")
	);
}

/**
 * A transcription attempt that died because the AI account is out of credits /
 * rate-limited, in a mode that has NO durable resume (fast). Distinct from
 * AiQuotaWaitError, which parks a cheap job in PROCESSING because its chunk is
 * already sitting in a durable Batch that poll-batch-jobs will collect. Fast
 * mode has no such submission, so it must stay terminal-ERROR — but tagged, so
 * recover-stale-ai-jobs can re-run it once credits return.
 *
 * The signal lives in `name`, not in an extra field: this error crosses the
 * workflow step boundary, where only the standard Error shape survives.
 */
export class TranscriptionQuotaFailureError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TranscriptionQuotaFailureError";
	}
}

export function isTranscriptionQuotaFailureError(
	error: unknown,
): error is TranscriptionQuotaFailureError {
	return (
		error instanceof TranscriptionQuotaFailureError ||
		(error instanceof Error &&
			error.name === "TranscriptionQuotaFailureError")
	);
}

import { isUnusableAiOutputError } from "@/lib/free-tier-health";

export function isQuotaLikeAiError(error: unknown): boolean {
	// Structural exclusion BEFORE any regex (round-16 #1, the same shape as
	// the broken-key classifier): an unusable-output failure's message quotes
	// the MODEL'S OWN CONTENT plus a byte offset, either of which can look
	// quota-shaped ("Rate limit ...", "... column 429"). Reading that as
	// genuine exhaustion bills the paid key with free quota untouched. Every
	// classifier whose verdict can open the paid path must honour this tag.
	if (isUnusableAiOutputError(error)) return false;
	const message = error instanceof Error ? error.message : String(error);
	return /\b429\b|RESOURCE_EXHAUSTED|quota|rate[- ]?limit|too many requests/i.test(
		message,
	);
}
