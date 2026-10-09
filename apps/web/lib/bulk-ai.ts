/**
 * Bulk "Faqat transkript" / "To'liq AI tahlil" from the selection bar
 * (ADR docs/adr/2026-10-07-bulk-ai-from-selection.md).
 *
 * Everything here is PURE: the planner decides from the same per-cap fields the
 * grid already has (metadata + duration), the runner takes an injectable
 * `fetch`, and the bar only renders. No server change - the loop just calls the
 * EXISTING `POST /api/videos/:id/generate` one video at a time.
 */
import type { VideoMetadata } from "@cap/database/types";
import { estimateVideoAiCostUsd, priceForMicros } from "@cap/utils";

import { isAiJobRunning } from "@/lib/ai-job-status";

export type BulkAiMode = "transcript" | "full";

/** One bulk press may cover at most this many videos. Every started video runs
 * its own background workflow in parallel (no global limit, `after()` in
 * lib/transcribe.ts) and the host has 4 cores, so 10 keeps the burst to a short
 * slowdown instead of 20 parallel ffmpeg + provider jobs (2026-10-07 review). */
export const BULK_AI_MAX_SELECTION = 10;

/**
 * "Real AI content exists" - the SAME summary/aiSummary.overview rule the
 * generate route uses to answer `alreadyRunning` for a done video
 * (app/api/videos/[videoId]/generate/route.ts, the `hasContent` check). A
 * COMPLETE status with NO content is NOT done - the route itself falls through
 * and retries those.
 */
export const hasAiContent = (metadata?: VideoMetadata | null): boolean =>
	(typeof metadata?.summary === "string" && metadata.summary.length > 0) ||
	(metadata?.aiSummary != null &&
		typeof metadata.aiSummary === "object" &&
		typeof (metadata.aiSummary as { overview?: unknown }).overview ===
			"string" &&
		(metadata.aiSummary as { overview: string }).overview.length > 0);

/** "Full AI analysis is done" - status COMPLETE AND real content, mirroring
 * the generate route exactly. */
export const isFullAiDone = (metadata?: VideoMetadata | null): boolean =>
	metadata?.aiGenerationStatus === "COMPLETE" && hasAiContent(metadata);

export type BulkAiCap = {
	id: string;
	/** Video length in seconds; drives the "taxminan $X" estimate. */
	durationSec?: number | null;
	/**
	 * The `videos.transcriptionStatus` column. Both dashboard queries select it
	 * (caps/page.tsx and lib/folder.ts), so the planner can pre-skip a video
	 * whose transcript is already COMPLETE - without it, posting "transcript"
	 * mode for such a video would make the generate route fall through into a
	 * FULL AI run the owner never asked for (2026-10-07 review F1).
	 */
	transcriptionStatus?: string | null;
	metadata?: VideoMetadata | null;
};

export type BulkAiSkip = { id: string; reason: string };

export type BulkAiPlan = {
	/** Ids worth pressing "Boshlash" for, in selection order. */
	toRun: string[];
	skipped: BulkAiSkip[];
	totalAudioSec: number;
	estimatedUsd: number;
	/**
	 * How many of `toRun` have no known duration: the price above covers only
	 * the rest, so the dialog adds "narx to'liq emas" when this is > 0 (F4).
	 */
	unknownDurationCount: number;
};

/** Plain-Uzbek skip reasons surfaced in the confirm dialog / summary toast. */
export const SKIP_REASON_RUNNING = "ishlanmoqda";
export const SKIP_REASON_TRANSCRIPT_DONE = "transkript tayyor";
export const SKIP_REASON_FULL_DONE = "AI tahlili tayyor";

/**
 * Audio-in price of transcription only, from the SAME price table the AI
 * budget code uses (packages/utils/src/ai-pricing.ts): Gemini audio input is
 * ~32 tokens/sec at the gemini-2.5-flash audio-in rate of $1.00/M. The full
 * pipeline estimate reuses `estimateVideoAiCostUsd` from the same file, so
 * there is no second price source here.
 */
const TRANSCRIPT_AUDIO_TOKENS_PER_SEC = 32;
const TRANSCRIPT_ESTIMATE_MODEL = "gemini-2.5-flash";

const transcriptEstimateUsd = (durationSec: number): number =>
	priceForMicros(TRANSCRIPT_ESTIMATE_MODEL, {
		textInTokens: 0,
		audioInTokens: TRANSCRIPT_AUDIO_TOKENS_PER_SEC * durationSec,
		outputTokens: 0,
	}) / 1_000_000;

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Plan a bulk AI run: which of the selected caps are worth starting, which are
 * skipped (already done / already running), and the rough "taxminan" price of
 * the ones that will run. Pure - safe to call on every render.
 */
export function planBulkAi(caps: BulkAiCap[], mode: BulkAiMode): BulkAiPlan {
	const toRun: string[] = [];
	const skipped: BulkAiSkip[] = [];
	let totalAudioSec = 0;
	let unknownDurationCount = 0;

	for (const cap of caps) {
		const meta = cap.metadata ?? null;
		// A generation job (CapCard's aiRunning rule) or a transcription in
		// flight: never double-start.
		if (isAiJobRunning(meta) || cap.transcriptionStatus === "PROCESSING") {
			skipped.push({ id: cap.id, reason: SKIP_REASON_RUNNING });
			continue;
		}
		if (mode === "transcript") {
			// Transcript already COMPLETE - or the full analysis (which includes
			// the transcript) already done: nothing to transcribe. Skipping
			// COMPLETE here is what keeps a transcript-only request from falling
			// through into a FULL AI run in the generate route (F1).
			if (cap.transcriptionStatus === "COMPLETE" || isFullAiDone(meta)) {
				skipped.push({ id: cap.id, reason: SKIP_REASON_TRANSCRIPT_DONE });
				continue;
			}
		} else if (isFullAiDone(meta)) {
			// No re-run of done videos (owner decision) - and only REAL content
			// counts as done, exactly like the generate route. A COMPLETE
			// transcript WITHOUT AI content is NOT done in full mode: it runs.
			skipped.push({ id: cap.id, reason: SKIP_REASON_FULL_DONE });
			continue;
		}
		toRun.push(cap.id);
		const sec = cap.durationSec ?? 0;
		if (sec > 0) {
			totalAudioSec += sec;
		} else {
			unknownDurationCount++;
		}
	}

	const estimatedUsd =
		mode === "full"
			? round2(estimateVideoAiCostUsd(totalAudioSec))
			: round2(transcriptEstimateUsd(totalAudioSec));

	return { toRun, skipped, totalAudioSec, estimatedUsd, unknownDurationCount };
}

/**
 * Split the skipped list for the confirm dialog (F4): how many are already
 * done vs. currently being processed, so "K tasi allaqachon tayyor · J tasi
 * hozir ishlanmoqda" states the two cases separately instead of one blanket
 * "tayyor" that hides running jobs.
 */
export function splitSkippedReasons(skipped: BulkAiSkip[]): {
	doneCount: number;
	runningCount: number;
} {
	let doneCount = 0;
	let runningCount = 0;
	for (const s of skipped) {
		if (s.reason === SKIP_REASON_RUNNING) runningCount++;
		else doneCount++;
	}
	return { doneCount, runningCount };
}

/**
 * "~H soat audio" for the confirm dialog: whole minutes under an hour, one
 * decimal hour above it, so a 40-minute selection does not read "0.7 soat".
 */
export function formatAudioLengthUz(totalSec: number): string {
	if (totalSec <= 0) return "0 daqiqa";
	const minutes = totalSec / 60;
	if (minutes < 60) return `${Math.round(minutes)} daqiqa`;
	const hours = totalSec / 3600;
	const rounded = hours >= 10 ? Math.round(hours) : Math.round(hours * 10) / 10;
	return `~${rounded} soat`;
}

/**
 * Visibility + enablement of the two bulk-AI buttons on the selection bar.
 * Admin-only (the generate route enforces the same rule server-side), hidden
 * entirely when the caller cannot supply AI state for the selection, disabled
 * with a hint above the BULK_AI_MAX_SELECTION ceiling.
 */
export function bulkAiButtonState(input: {
	isAdmin?: boolean | null;
	selectedCount: number;
	/** Does the caller have per-cap AI data (metadata) for the selection? */
	hasCapData: boolean;
}): { visible: boolean; disabled: boolean; hint: string | null } {
	const visible = Boolean(input.isAdmin) && input.hasCapData;
	const disabled = input.selectedCount > BULK_AI_MAX_SELECTION;
	return {
		visible,
		disabled,
		hint: disabled ? `Bir martada ${BULK_AI_MAX_SELECTION} tagacha` : null,
	};
}

export type BulkAiRunOutcome = {
	/** Videos the generate route accepted (incl. `alreadyRunning` answers). */
	started: number;
	/**
	 * The IDS of the accepted videos, in start order (2026-10-08 review fix 1).
	 * The transcribe-then-download flow waits for exactly these instead of
	 * sniffing URLs; the two menu buttons ignore the field and read `started`.
	 */
	startedIds: string[];
	/** 403 answers - skipped, the loop continues. */
	skipped: number;
	/** Other errors / network failures - failed, the loop continues. */
	failed: number;
	/** A 402 AI_BUDGET_EXCEEDED stopped the loop. */
	budgetStopped: boolean;
	/** How many planned videos never got a start because of that stop. */
	notStartedCount: number;
	/** Total planned videos (the "N" in "N tadan M tasi boshlandi"). */
	total: number;
};

const BUDGET_EXCEEDED_CODE = "AI_BUDGET_EXCEEDED";

/**
 * Start the planned videos ONE AT A TIME via the existing generate route.
 * Sequential on purpose (spec): no concurrency limiter was asked for, and one
 * at a time keeps the server's background-job fan-out bounded by the loop.
 *
 * - 200 (incl. `alreadyRunning`) = started
 * - 402 with code AI_BUDGET_EXCEEDED = STOP the whole loop
 * - 403 = skipped, continue
 * - anything else (incl. a thrown network error) = failed, continue
 *
 * Never sends `reprocess: true`.
 */
export async function runBulkAiStarts(
	ids: string[],
	mode: BulkAiMode,
	fetchImpl: typeof fetch = fetch,
): Promise<BulkAiRunOutcome> {
	const outcome: BulkAiRunOutcome = {
		started: 0,
		startedIds: [],
		skipped: 0,
		failed: 0,
		budgetStopped: false,
		notStartedCount: 0,
		total: ids.length,
	};

	for (let i = 0; i < ids.length; i++) {
		const id = ids[i] as string;
		let res: Response;
		try {
			res = await fetchImpl(`/api/videos/${id}/generate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ mode }),
			});
		} catch {
			outcome.failed++;
			continue;
		}

		if (res.status === 402) {
			let code: string | undefined;
			try {
				code = ((await res.json()) as { code?: string }).code;
			} catch {
				// unparseable body - falls through to the plain-failure branch
			}
			if (code === BUDGET_EXCEEDED_CODE) {
				outcome.budgetStopped = true;
				outcome.notStartedCount = ids.length - i;
				break;
			}
			outcome.failed++;
			continue;
		}

		if (res.status === 403) {
			outcome.skipped++;
			continue;
		}

		if (res.ok) {
			outcome.started++;
			outcome.startedIds.push(id);
			continue;
		}

		outcome.failed++;
	}

	return outcome;
}

/**
 * The ONE toast per run (F3): "N tadan M tasi boshlandi" plus the skipped /
 * failed counts, with the budget-stop line MERGED into the same text. It is a
 * success toast only when something started, nothing failed and the monthly
 * budget did not stop the loop - otherwise the same single toast reports as
 * an error. `runBulkAiStarts` never throws, so this is the only report.
 */
export function buildBulkAiResultToast(outcome: BulkAiRunOutcome): {
	kind: "success" | "error";
	text: string;
} {
	let text = `${outcome.total} tadan ${outcome.started} tasi boshlandi`;
	if (outcome.skipped > 0) {
		text += ` · ${outcome.skipped} tasi o'tkazib yuborildi (ruxsat yo'q yoki ishlanmoqda)`;
	}
	if (outcome.failed > 0) {
		text += ` · ${outcome.failed} tasi xatolik bilan to'xtadi`;
	}
	if (outcome.budgetStopped) {
		text += ` · Oylik AI limiti tugadi - ${outcome.notStartedCount} ta video boshlanmadi`;
	}
	const success =
		outcome.started > 0 && outcome.failed === 0 && !outcome.budgetStopped;
	return { kind: success ? "success" : "error", text };
}
