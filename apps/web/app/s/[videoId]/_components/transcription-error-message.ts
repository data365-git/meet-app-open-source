/**
 * Which `share` message explains a failed video, given what actually went wrong
 * and who is looking. Pure so the branch that decides what the user is TOLD can
 * be tested without a browser — the failure path itself cannot be reproduced
 * live while the AI account is out of credits.
 */
export function transcriptionErrorMessageKey({
	transcriptionStatus,
	transcriptionErrorCode,
	canGenerate,
}: {
	transcriptionStatus: string | null | undefined;
	transcriptionErrorCode: "QUOTA" | "FAILED" | null | undefined;
	canGenerate: boolean;
}): string {
	if (transcriptionStatus !== "ERROR") return "aiGenerationError";
	if (transcriptionErrorCode !== "QUOTA") return "aiTranscriptionFailed";
	// Public share links reach strangers: only the owner is told the account is
	// out of money. Everyone else gets the same promise without the billing fact.
	return canGenerate
		? "aiTranscriptionQuotaFailed"
		: "aiTranscriptionQuotaFailedPublic";
}
