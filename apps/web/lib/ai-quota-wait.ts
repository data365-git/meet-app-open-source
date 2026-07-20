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

export function isQuotaLikeAiError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b429\b|RESOURCE_EXHAUSTED|quota|rate[- ]?limit|too many requests/i.test(
		message,
	);
}
