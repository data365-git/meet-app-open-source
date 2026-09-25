/**
 * Which `share` message explains a failed video, given what actually went wrong
 * and who is looking. Pure so the branch that decides what the user is TOLD can
 * be tested without a browser — the failure path itself cannot be reproduced
 * live while the AI account is out of credits.
 */
import { isQuotaLikeAiError } from "@/lib/ai-quota-wait";

export function transcriptionErrorMessageKey({
	transcriptionStatus,
	transcriptionErrorCode,
	canGenerate,
	quotaRetriesExhausted,
}: {
	transcriptionStatus: string | null | undefined;
	transcriptionErrorCode: "QUOTA" | "FAILED" | null | undefined;
	canGenerate: boolean;
	/** The recovery cron's retry ladder is spent (quotaRetryAttempts >= 12):
	 * the "we retry automatically" promise would be a lie from here on. */
	quotaRetriesExhausted?: boolean;
}): string {
	if (transcriptionStatus !== "ERROR") return "aiGenerationError";
	if (transcriptionErrorCode !== "QUOTA") return "aiTranscriptionFailed";
	// The retry budget is gone: the honest next step is a MANUAL retry after
	// the account is topped up, and the public line must stop promising retries.
	if (quotaRetriesExhausted) {
		return canGenerate
			? "aiTranscriptionQuotaExhausted"
			: "aiTranscriptionQuotaExhaustedPublic";
	}
	// Public share links reach strangers: only the owner is told the account is
	// out of money. Everyone else gets the same promise without the billing fact.
	return canGenerate
		? "aiTranscriptionQuotaFailed"
		: "aiTranscriptionQuotaFailedPublic";
}

export type AiGenerationErrorKind = "BUDGET" | "QUOTA" | "OTHER";

/**
 * Why the AI GENERATION stage failed (metadata.aiGenerationError), for the
 * owner's "pul tugasa pul tugadi desin" order (2026-09-25): the monthly cap
 * (BUDGET) and the provider balance (QUOTA) need different honest sentences —
 * the first is fixed by an admin in settings, the second by topping up the AI
 * account. ONE classifier, no second quota copy: budget is the exact string
 * both workflows write (transcribe.ts "AI budget exceeded", generate-ai.ts
 * markBudgetExceeded), everything money/provider-shaped goes through the
 * existing isQuotaLikeAiError, the rest is OTHER.
 */
export function classifyAiGenerationError(
	message: string | null | undefined,
): AiGenerationErrorKind {
	if (!message) return "OTHER";
	if (/budget exceeded/i.test(message)) return "BUDGET";
	if (isQuotaLikeAiError(new Error(message))) return "QUOTA";
	return "OTHER";
}

/**
 * "Bu joylarda matn yo'q: 1:42:41-1:47:01, …" — the S3 gap line under the
 * transcript. Times are h:mm:ss (owner-approved format), gaps joined with
 * ", ", capped at `limit` spans with an ellipsis so a pathological VTT
 * cannot turn this into a wall of numbers.
 */
export function formatTranscriptGapRanges(
	gaps: Array<{ startSec: number; endSec: number }>,
	limit = 4,
): string {
	const fmt = (sec: number) => {
		const h = Math.floor(sec / 3600);
		const m = Math.floor((sec % 3600) / 60);
		const s = Math.floor(sec % 60);
		return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
	};
	const shown = gaps.slice(0, limit).map((g) => `${fmt(g.startSec)}-${fmt(g.endSec)}`);
	return shown.join(", ") + (gaps.length > limit ? ", …" : "");
}
