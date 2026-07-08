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

export function isQuotaLikeAiError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return /\b429\b|RESOURCE_EXHAUSTED|quota|rate[- ]?limit|too many requests/i.test(
		message,
	);
}
