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

/**
 * CREDIT exhaustion, the paid-vendor twin of a free-tier quota wall
 * (round-18 #4). Google answers exhaustion with 429/RESOURCE_EXHAUSTED;
 * OpenRouter answers "you are out of money" with HTTP 402 and an
 * "insufficient credits" body. Left unclassified, that surfaced as a generic
 * failure — the user was told the AI broke when in fact the account needs a
 * top-up, and the job was not tagged for the credits-returned re-run.
 *
 * Deliberately NARROW, because this verdict can open the paid path from a free
 * failure (transcribe.ts) exactly like the 429 arm: a bare "402" is never
 * evidence — the number must arrive as an HTTP status, or the text must name
 * credits outright. Output-shaped failures are excluded structurally by the
 * caller below, the same as every other classifier here.
 */
export function isCreditExhaustedAiError(error: unknown): boolean {
	if (isUnusableAiOutputError(error)) return false;
	const message = error instanceof Error ? error.message : String(error);
	return (
		/HTTP 402\b/i.test(message) ||
		/insufficient[_ -]?credits?|not enough credits|credit balance|out of credits|requires more credits/i.test(
			message,
		)
	);
}

export function isQuotaLikeAiError(error: unknown): boolean {
	// Structural exclusion BEFORE any regex (round-16 #1, the same shape as
	// the broken-key classifier): an unusable-output failure's message quotes
	// the MODEL'S OWN CONTENT plus a byte offset, either of which can look
	// quota-shaped ("Rate limit ...", "... column 429"). Reading that as
	// genuine exhaustion bills the paid key with free quota untouched. Every
	// classifier whose verdict can open the paid path must honour this tag.
	if (isUnusableAiOutputError(error)) return false;
	const message = error instanceof Error ? error.message : String(error);
	// Credit exhaustion IS quota-like for every consumer of this verdict: the
	// paid provider refuses to serve until money returns, which is precisely
	// what TranscriptionQuotaFailureError ("re-run it once credits return")
	// and the "quota/credits exhausted" user message already describe.
	if (isCreditExhaustedAiError(error)) return true;
	return /\b429\b|RESOURCE_EXHAUSTED|quota|rate[- ]?limit|too many requests/i.test(
		message,
	);
}
