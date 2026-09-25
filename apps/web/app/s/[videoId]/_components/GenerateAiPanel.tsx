"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import type { Video } from "@cap/web-domain";
import clsx from "clsx";
import { Clock3, MoreVertical, Sparkles } from "lucide-react";
import { useTranslations } from "next-intl";
import { transcriptionErrorMessageKey } from "./transcription-error-message";
import { useRef, useState } from "react";

// Weighted stage shares for the overall progress bar (owner design contract:
// "AI Status.dc.html" + handoff/status/README.md ask for weighted stages —
// its own weights were a designer's guess for an embedding-centric pipeline
// that doesn't match ours). Chosen from typical wall-clock share on real
// videos: transcription re-processes raw AUDIO through Gemini chunk-by-chunk
// and dominates; summary reads the much smaller resulting transcript text;
// refined is the fastest (near-verbatim reformatting of already-summarized
// chapters). Not measured per-video — a reasonable estimate, like the
// existing cost estimator's factors above it in this pipeline.
const STAGE_WEIGHTS: Record<"transcribe" | "summary" | "refined", number> = {
	transcribe: 65,
	summary: 20,
	refined: 15,
};

type TranscriptionStatus =
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED"
	| "NO_AUDIO";

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

type AiProcessingStep = "transcribe" | "summary" | "refined" | "done";
type AiProcessingSubStep = "extract_audio";

interface GenerateAiPanelProps {
	videoId: Video.VideoId;
	canGenerate: boolean;
	transcriptionStatus: TranscriptionStatus | null | undefined;
	aiGenerationStatus: AiGenerationStatus | null | undefined;
	aiProcessingStep?: AiProcessingStep | null;
	/** Fine sub-phase inside "transcribe", written by the workflow when the
	 * phase really starts — never inferred client-side. */
	aiProcessingSubStep?: AiProcessingSubStep | null;
	/** Why transcription failed. QUOTA = the AI account ran out of credits —
	 * the recording is safe and the recovery cron will re-run it. */
	transcriptionErrorCode?: "QUOTA" | "FAILED" | null;
	/** The recovery cron's retry ladder is spent for a QUOTA death — the
	 * "we retry automatically" promise must not be shown (owner order
	 * 2026-09-25: never a false promise, never a bare "failed"). */
	quotaRetriesExhausted?: boolean;
	/** S4: the run is parked waiting for the FREE quota window (legacy
	 * metadata state) — show the waiting line instead of a bare stepper. */
	aiQuotaWaiting?: boolean;
	/** S5: why the AI GENERATION stage failed, classified from
	 * metadata.aiGenerationError (see classifyAiGenerationError). The monthly
	 * cap (BUDGET) and the provider balance (QUOTA) need different truths. */
	aiGenerationErrorCode?: "BUDGET" | "QUOTA" | "OTHER" | null;
	duration?: number | null;
	/** When true, the completed analysis looks incomplete ("chala") and the
	 * re-analyze affordance should be shown prominently instead of tucked away. */
	aiIncomplete?: boolean;
	/** Fine-grained transcription chunk progress ("Gemini'ga N/M audio yuborildi"). */
	transcriptionChunksCompleted?: number | null;
	transcriptionChunksTotal?: number | null;
	/** Fine-grained summary/refine chunk progress, reset at each stage transition. */
	aiStageChunksCompleted?: number | null;
	aiStageChunksTotal?: number | null;
	/** ISO timestamps used to compute a rate-based ETA for the active stage. */
	processingStartedAt?: string | null;
	aiProcessingStartedAt?: string | null;
	/** The user's press is banked server-side (`metadata.aiStartPendingUpload`)
	 * or not yet claimed by the workflow — see lib/ai-request-pending.ts. It
	 * comes from the same status poll as the other fields, so it survives polls
	 * and remounts until the server says the job started, failed or completed. */
	aiRequestPending?: boolean;
	/** The durable "the user's outstanding run includes AI" fact, from the same
	 * status poll as the other fields (server fallback:
	 * metadata.aiGenerationRequestedAt). It is what keeps the stepper honest
	 * after a remount, when the local memory of which button was pressed is
	 * gone: a transcript-only run must show ONE stage, not three. */
	aiGenerationRequested?: boolean;
	/** Called after a successful POST so the parent can refetch status */
	onStarted?: () => void;
}

// Rate-based ETA: (elapsed / completed) × remaining, in whole minutes.
// Falls back to the crude duration/120 heuristic until a rate is available
// (no chunks completed yet, or the stage start time is missing).
function computeEtaMinutes({
	now,
	startedAt,
	completed,
	total,
	fallbackDurationSec,
}: {
	now: number;
	startedAt?: string | null;
	completed?: number | null;
	total?: number | null;
	fallbackDurationSec?: number | null;
}): number {
	if (startedAt && completed && completed > 0 && total && total > completed) {
		const startedMs = Date.parse(startedAt);
		const elapsedMs = now - startedMs;
		if (!Number.isNaN(startedMs) && elapsedMs > 0) {
			const remaining = total - completed;
			const etaMs = (elapsedMs / completed) * remaining;
			return Math.max(1, Math.round(etaMs / 60000));
		}
	}
	return Math.max(1, Math.round((fallbackDurationSec ?? 120) / 120));
}

export function getAiAnalysisNotice(
	duration?: number | null,
): "long" | "medium" | null {
	if (!duration || duration <= 30 * 60) return null;
	if (duration >= 60 * 60) return "long";
	return "medium";
}

export function GenerateAiPanel({
	videoId,
	canGenerate,
	transcriptionStatus,
	aiGenerationStatus,
	aiProcessingStep,
	aiProcessingSubStep,
	transcriptionErrorCode = null,
	quotaRetriesExhausted = false,
	aiQuotaWaiting = false,
	aiGenerationErrorCode = null,
	duration,
	aiIncomplete = false,
	transcriptionChunksCompleted,
	transcriptionChunksTotal,
	aiStageChunksCompleted,
	aiStageChunksTotal,
	processingStartedAt,
	aiProcessingStartedAt,
	aiRequestPending = false,
	aiGenerationRequested = false,
	onStarted,
}: GenerateAiPanelProps) {
	const tShare = useTranslations("share");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// S2 immediate: set when the generate POST answered HTTP 402
	// AI_BUDGET_EXCEEDED — the press itself did not fail, the monthly cap
	// did, so the raw English error string must never reach the owner.
	const [budgetBlocked, setBudgetBlocked] = useState<{
		spentUsd: number;
		capUsd: number;
	} | null>(null);
	const inFlightRef = useRef(false);
	// Which of the two start buttons was pressed in THIS session (null = the
	// press was not the two-mode chooser, e.g. error retry, or the panel just
	// remounted). Mirrors the mode sent to the generate route so the running
	// stepper below can show only the stages this run will actually do.
	const [chosenMode, setChosenMode] = useState<"transcript" | "full" | null>(
		null,
	);
	// Keeps the min ETA seen for the CURRENT stage so the caption never flaps
	// upward between polls; reset whenever the active stage changes.
	const etaMinRef = useRef<{ step: AiProcessingStep; value: number } | null>(
		null,
	);
	const isRunning =
		transcriptionStatus === "PROCESSING" ||
		aiGenerationStatus === "QUEUED" ||
		aiGenerationStatus === "PROCESSING";

	const isDone =
		transcriptionStatus === "COMPLETE" &&
		(aiGenerationStatus === "COMPLETE" ||
			aiGenerationStatus === "SKIPPED" ||
			aiGenerationStatus === "ERROR");

	// Nothing to show if already complete with data (unless owner can re-analyze)
	if (isDone && aiGenerationStatus === "COMPLETE" && !canGenerate) return null;

	const hasError =
		transcriptionStatus === "ERROR" || aiGenerationStatus === "ERROR";
	const aiNotice = getAiAnalysisNotice(duration);

	// Fires the generation POST directly. `mode` carries the explicit
	// two-mode choice (2026-09-10): "transcript" = transcribe and stop there,
	// "full" = transcribe then summary/tasks in one run with no second press.
	// Buttons that are NOT the two-mode chooser (error retry, the banked
	// "press again") pass null and let the route resolve the user's outstanding
	// intent — but any press that starts AI generation itself says "full" so
	// the stepper never hides stages that really are coming.
	const requestStart = (
		reprocess = false,
		mode: "transcript" | "full" | null = null,
	) => {
		setChosenMode(mode);
		// Synchronous in-flight guard: a very fast double-click can fire before the
		// `loading` state re-renders the disabled buttons, sending two POSTs.
		// The ref blocks the second call instantly.
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setLoading(true);
		setError(null);
		void (async () => {
			try {
				const res = await fetch(`/api/videos/${videoId}/generate`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify(mode ? { reprocess, mode } : { reprocess }),
				});
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					if ((body as { code?: string }).code === "AI_BUDGET_EXCEEDED") {
						// Never default missing money numbers to 0 — a $0.00/$0.00
						// line would be fabricated. Store the pair only when the 402
						// body actually carries BOTH numbers; otherwise keep null so
						// the numbers-free honest variant (aiBudgetBlockedPlain)
						// renders instead.
						const numbers = body as { spentUsd?: number; capUsd?: number };
						if (
							typeof numbers.spentUsd === "number" &&
							typeof numbers.capUsd === "number"
						) {
							setBudgetBlocked({
								spentUsd: numbers.spentUsd,
								capUsd: numbers.capUsd,
							});
						}
						setError(null);
					} else {
						setError((body as { error?: string }).error ?? "An error occurred");
					}
				} else {
					onStarted?.();
				}
			} catch {
				setError("An error occurred");
			} finally {
				setLoading(false);
				inFlightRef.current = false;
			}
		})();
	};

	// ── Running state: persisted pipeline stage ──────────────────────────────
	if (isRunning) {
		const stepOrder: AiProcessingStep[] = [
			"transcribe",
			"summary",
			"refined",
			"done",
		];
		const aiComplete =
			aiGenerationStatus === "COMPLETE" || aiGenerationStatus === "SKIPPED";

		// Drive the stepper from the two AUTHORITATIVE statuses so exactly one
		// step is ever "current" and the header label always matches it. The old
		// logic leaned on aiProcessingStep, which the backend does NOT report
		// during the transcript phase — so every circle looked idle and the
		// status line wrongly claimed "summary" while the transcript was still
		// running.
		const currentStep: AiProcessingStep =
			transcriptionStatus !== "COMPLETE"
				? "transcribe"
				: !aiComplete
					? aiProcessingStep === "refined"
						? "refined"
						: "summary"
					: "done";
		// Index of the CURRENT step within stepOrder. When the pipeline reaches
		// "done" this is 3, which is > every visible-stage index below — so all
		// three rows resolve to "done" for one terminal frame instead of ever
		// leaving a bar stuck at 99%.
		const currentIdx = stepOrder.indexOf(currentStep);

		const stepLabelKey = {
			transcribe: "stepTranscribe",
			summary: "stepSummary",
			refined: "stepRefined",
			done: "stepDone",
		} as const;

		// Rate-based ETA for the active stage, clamped to the min seen so far
		// for THAT stage so the caption never counts back up between polls.
		const rawEtaMin =
			currentStep === "transcribe"
				? computeEtaMinutes({
						now: Date.now(),
						startedAt: processingStartedAt,
						completed: transcriptionChunksCompleted,
						total: transcriptionChunksTotal,
						fallbackDurationSec: duration,
					})
				: computeEtaMinutes({
						now: Date.now(),
						startedAt: aiProcessingStartedAt,
						completed: aiStageChunksCompleted,
						total: aiStageChunksTotal,
						fallbackDurationSec: duration,
					});
		if (etaMinRef.current && etaMinRef.current.step === currentStep) {
			etaMinRef.current.value = Math.min(etaMinRef.current.value, rawEtaMin);
		} else {
			etaMinRef.current = { step: currentStep, value: rawEtaMin };
		}
		const etaMin = etaMinRef.current.value;
		const etaLabel =
			etaMin < 1 ? tShare("aiEtaSoon") : tShare("aiEta", { minutes: etaMin });

		// The 3 REAL tracked stages (tasks/chapters are not separately tracked,
		// so they never get their own row).
		const runningStages: {
			key: "transcribe" | "summary" | "refined";
			nounLabel: string;
			focalLabel: string;
			completed: number;
			total: number;
		}[] = [
			{
				key: "transcribe",
				nounLabel: tShare(stepLabelKey.transcribe),
				focalLabel: tShare("aiFocalTranscribe"),
				completed: transcriptionChunksCompleted ?? 0,
				total: transcriptionChunksTotal ?? 0,
			},
			{
				key: "summary",
				nounLabel: tShare(stepLabelKey.summary),
				focalLabel: tShare("aiFocalSummary"),
				completed: aiStageChunksCompleted ?? 0,
				total: aiStageChunksTotal ?? 0,
			},
			{
				key: "refined",
				nounLabel: tShare(stepLabelKey.refined),
				focalLabel: tShare("aiFocalRefined"),
				completed: aiStageChunksCompleted ?? 0,
				total: aiStageChunksTotal ?? 0,
			},
		];

		// Does THIS run include the AI stages? The two-mode chooser means it may
		// not: a live AI status always wins (those stages are really running),
		// otherwise the locally remembered press decides, and after a remount the
		// server's durable "AI requested" fact does. A transcript-only stepper
		// that still lists summary/refined and weights the bar for stages that
		// will never run is a progress line that lies.
		const aiPhaseLive =
			aiGenerationStatus === "QUEUED" || aiGenerationStatus === "PROCESSING";
		const runIncludesAi =
			aiPhaseLive ||
			chosenMode === "full" ||
			(chosenMode === null && aiGenerationRequested);
		const visibleStages = runIncludesAi
			? runningStages
			: runningStages.filter((stage) => stage.key === "transcribe");
		const visibleIdx = Math.min(currentIdx, visibleStages.length - 1);
		const visibleWeights: typeof STAGE_WEIGHTS = runIncludesAi
			? STAGE_WEIGHTS
			: { transcribe: 100, summary: 0, refined: 0 };

		// Single glance-level readout the owner asked for: WHAT is happening now
		// (the active stage's verb) + WHERE in the whole pipeline we are (stage
		// N/3 + one overall bar) + roughly how long left (ETA). The per-stage list
		// below stays for detail; this header is the "his qilinadigan" summary.
		const focalByStep: Record<AiProcessingStep, string> = {
			transcribe: tShare("aiFocalTranscribe"),
			summary: tShare("aiFocalSummary"),
			refined: tShare("aiFocalRefined"),
			done: tShare("stepDone"),
		};
		const currentFocalLabel = focalByStep[currentStep];
		const activeStage = visibleStages[visibleIdx];
		const withinFraction =
			activeStage && activeStage.total > 0
				? Math.min(1, activeStage.completed / activeStage.total)
				: // Indeterminate (no chunk total reported yet): assume the active
					// stage is ~40% through, same convention the design sample uses,
					// so the bar still visibly advances instead of sitting frozen at
					// the previous stage's boundary.
					0.4;
		// Weighted by STAGE_WEIGHTS instead of even thirds, since transcription
		// genuinely takes most of the wall-clock time. Capped at 99 until the
		// pipeline actually reaches "done" (this branch never renders once it
		// does) so the bar never lies about being finished.
		const overallPct = Math.min(
			99,
			Math.round(
				visibleStages.reduce((sum, stage, i) => {
					const weight = visibleWeights[stage.key];
					if (i < visibleIdx) return sum + weight;
					if (i === visibleIdx) return sum + weight * withinFraction;
					return sum;
				}, 0),
			),
		);
		const stageNumber = Math.min(currentIdx + 1, visibleStages.length);
		// The active stage's detail line ("16 bo'lakdan 5-si yuborilmoqda"),
		// shared by the glance header below and that stage's row in the list.
		const activeDetail =
			activeStage && activeStage.total > 0
				? activeStage.key === "transcribe"
					? tShare("aiFineTranscribing", {
							completed: activeStage.completed,
							total: activeStage.total,
						})
					: tShare("aiFineStageProgress", {
							completed: activeStage.completed,
							total: activeStage.total,
						})
				: null;

		// ONE honest live line under the overall bar — only ever claims a step
		// that is PROVEN by real backend data, in priority order:
		//   1. real chunk progress ("Gemini'ga 3/12 audio yuborildi"),
		//   2. the workflow-written audio-extraction marker.
		// If none of those markers exist, no line is shown — never an invented
		// label or a fake percentage.
		const liveDetailLine =
			activeDetail ??
			(currentStep === "transcribe" && aiProcessingSubStep === "extract_audio"
				? tShare("aiLiveExtractingAudio")
				: null);

		return (
			<div className="flex flex-col gap-4 rounded-2xl border border-gray-5 bg-gray-1 p-4 shadow-[0_18px_50px_-36px_rgba(0,92,177,0.7)] sm:p-5">
				<div className="flex items-start justify-between gap-3">
					<div className="flex min-w-0 items-start gap-3">
						<div className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-wash)] text-[var(--brand)]">
							<Sparkles aria-hidden className="size-5" />
							<span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-gray-1 bg-[var(--brand)] motion-safe:animate-pulse" />
						</div>
						<div className="min-w-0" aria-live="polite">
							<p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-gray-9">
								{tShare("aiAnalysisRunning")}
							</p>
							<h3 className="mt-0.5 text-base font-semibold leading-tight text-gray-12 sm:text-lg">
								{tShare("aiNowDoing", { stage: currentFocalLabel })}
							</h3>
							{activeDetail && (
								<p className="mt-0.5 text-xs text-gray-9">{activeDetail}</p>
							)}
						</div>
					</div>
				</div>

				{/* Overall glance readout: what's happening now + stage N/3 + ETA,
				    over one continuous bar so the whole-pipeline position is felt. */}
				<div className="rounded-xl border border-gray-4 bg-gray-2 p-3.5">
					<div className="flex items-center justify-between gap-2">
						<div>
							<p className="text-xs font-medium text-gray-9">
								{tShare("aiOverallProgress")}
							</p>
							<p className="mt-0.5 text-sm font-semibold text-gray-12">
								{tShare("aiStageOfTotal", {
									current: stageNumber,
									total: visibleStages.length,
								})}
							</p>
						</div>
						<div className="text-right">
							<p className="text-[11px] font-medium text-gray-9">
								{tShare("aiEstimatedTime")}
							</p>
							<p className="mt-0.5 inline-flex items-center gap-1.5 text-sm font-semibold tabular-nums text-gray-12">
								<Clock3 aria-hidden className="size-3.5 text-[var(--brand)]" />
								{etaLabel}
							</p>
						</div>
					</div>
					<div
						role="progressbar"
						aria-label={tShare("aiOverallProgress")}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={overallPct}
						aria-valuetext={`${stageNumber}/${visibleStages.length}, ${etaLabel}`}
						className="mt-3 h-2 w-full overflow-hidden rounded-full bg-gray-5"
					>
						<div
							className="h-full rounded-full bg-[var(--brand)] motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out"
							style={{ width: `${overallPct}%` }}
						/>
					</div>
					<p className="mt-1.5 text-right text-[11px] font-medium tabular-nums text-gray-9">
						{overallPct}%
					</p>
					{liveDetailLine && (
						<p aria-live="polite" className="mt-1 text-xs text-gray-9">
							{liveDetailLine}
						</p>
					)}
				</div>

				{/* Vertical step list per the owner's design contract (AI Status.dc.html):
				    done = green check circle, active = accent circle + spinner, future =
				    dimmed — with an n/m or ✓ readout on the right of each row. */}
				<ol
					className="flex flex-col gap-1"
					aria-label={tShare("aiAnalysisStage")}
				>
					{visibleStages.map((stage, i) => {
						const state =
							i < currentIdx ? "done" : i === currentIdx ? "active" : "pending";
						const hasTotal = stage.total > 0;
						const detail =
							state === "active"
								? hasTotal
									? stage.key === "transcribe"
										? tShare("aiFineTranscribing", {
												completed: stage.completed,
												total: stage.total,
											})
										: tShare("aiFineStageProgress", {
												completed: stage.completed,
												total: stage.total,
											})
									: tShare("aiStarting")
								: null;
						const meta =
							state === "done"
								? "✓"
								: state === "active" && hasTotal
									? `${stage.completed}/${stage.total}`
									: state === "active"
										? "…"
										: "";

						return (
							<li
								key={stage.key}
								className={clsx(
									"flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors",
									state === "active" && "bg-[var(--brand-wash)]",
								)}
							>
								<span
									aria-hidden
									className={clsx(
										"mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full",
										state === "done" && "bg-green-9",
										state === "active" && "bg-[var(--brand)]",
										state === "pending" &&
											"border border-gray-5 bg-gray-2",
									)}
								>
									{state === "done" && (
										<CheckIcon className="size-3 text-white" />
									)}
									{state === "active" && (
										<span className="size-2.5 rounded-full border-2 border-white/40 border-t-white motion-safe:animate-spin" />
									)}
								</span>
								<div className="min-w-0 flex-1">
									<p
										className={clsx(
											"text-sm leading-tight",
											state === "done" && "text-gray-10",
											state === "active" &&
												"font-semibold text-gray-12",
											state === "pending" && "text-gray-8",
										)}
									>
										{stage.nounLabel}
									</p>
									{detail && (
										<p className="mt-0.5 text-xs leading-relaxed text-gray-9">
											{detail}
										</p>
									)}
								</div>
								<span
									className={clsx(
										"shrink-0 font-mono text-[11px]",
										state === "done" && "text-green-11",
										state === "active" && "text-[var(--brand)]",
										state === "pending" && "text-gray-8",
									)}
								>
									{meta}
								</span>
							</li>
						);
					})}
				</ol>

				{error && <p className="text-xs text-red-10">{error}</p>}
				{/* S4 (owner order 2026-09-25): a run parked for the FREE quota
				    window is alive and will continue on its own — the stepper
				    alone cannot say that, and silence reads as "stuck". */}
				{aiQuotaWaiting && (
					<p className="text-xs text-amber-11">
						{tShare("aiQuotaQueueWaiting")}
					</p>
				)}
			</div>
		);
	}

	// ── Error state ───────────────────────────────────────────────────────────
	// The MESSAGE is for everyone: before this, a viewer saw the spinner simply
	// vanish with no explanation. The RETRY BUTTON stays owner-only — it spends
	// real Gemini money.
	if (hasError) {
		// S5: the failure is in AI GENERATION (the transcript itself is fine) —
		// the reason must say WHICH wall was hit: the monthly cap is fixed by an
		// admin in settings, the provider balance by a top-up. Only the owner is
		// ever told the money facts; the public gets a neutral pause line.
		const generationKind =
			transcriptionStatus === "ERROR" ? null : aiGenerationErrorCode;
		let messageKey: string;
		let messageValues: Record<string, string> | undefined;
		let calmLine = false;
		if (generationKind === "BUDGET") {
			calmLine = true;
			if (!canGenerate) {
				messageKey = "aiBudgetBlockedPublic";
			} else {
				// The numbers come only from the 402 response seen in THIS
				// session (budgetBlocked state). No server-side prop feeds them:
				// on a reload the owner gets the numbers-free honest variant
				// rather than a fabricated pair.
				if (budgetBlocked) {
					messageKey = "aiBudgetBlocked";
					messageValues = {
						spent: `$${budgetBlocked.spentUsd.toFixed(2)}`,
						cap: `$${budgetBlocked.capUsd.toFixed(2)}`,
					};
				} else {
					messageKey = "aiBudgetBlockedPlain";
				}
			}
		} else if (generationKind === "QUOTA") {
			calmLine = true;
			// S5-QUOTA, public viewer: the transcript IS made (this branch only
			// renders when transcriptionStatus !== "ERROR"), so the
			// transcription-quota text ("the transcript could not be made — we
			// retry automatically") would be a double lie here. The public gets
			// its own neutral line: recording safe, summary not available yet.
			messageKey = canGenerate
				? "aiSummaryQuotaFailed"
				: "aiSummaryUnavailablePublic";
		} else {
			messageKey = transcriptionErrorMessageKey({
				transcriptionStatus,
				transcriptionErrorCode,
				canGenerate,
				quotaRetriesExhausted,
			});
			calmLine = messageKey.startsWith("aiTranscriptionQuota");
		}
		return (
			<div className="flex flex-col gap-3 rounded-xl border border-red-6 bg-red-3 px-4 py-4">
				<p className="text-sm text-red-11">
					{/* A credits/cap failure is not an "analysis failed" event — the
					    recording is intact, so it gets its own calmer sentence
					    instead of being prefixed with the generic alarm. */}
					{calmLine ? (
						messageValues ? (
							tShare(messageKey, messageValues)
						) : (
							tShare(messageKey)
						)
					) : (
						<>
							{tShare("aiAnalysisFailed")} {tShare(messageKey)}
						</>
					)}
				</p>
				{canGenerate && error && (
					<p className="text-xs text-red-10">{error}</p>
				)}
				{canGenerate && (
					<button
						type="button"
						disabled={loading}
						onClick={() => requestStart(false)}
						className="self-start rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
					>
						{loading ? tShare("aiStarting") : tShare("aiRetry")}
					</button>
				)}
			</div>
		);
	}

	// ── Owner re-analyze when analysis already complete ────────────────────────
	if (
		canGenerate &&
		transcriptionStatus === "COMPLETE" &&
		aiGenerationStatus === "COMPLETE"
	) {
		// Incomplete-looking ("chala") analysis: keep a visible, calm prompt so
		// the owner notices and re-runs it.
		if (aiIncomplete) {
			return (
				<div className="flex flex-col gap-2 rounded-xl border border-gray-4 bg-gray-2 px-4 py-3">
					<p className="text-xs text-gray-10">{tShare("aiIncompleteHint")}</p>
					{error && <p className="text-xs text-red-10">{error}</p>}
					<button
						type="button"
						disabled={loading}
						onClick={() => requestStart(true, "full")}
						className="self-start rounded-lg border border-gray-5 bg-gray-3 px-4 py-2 text-sm font-medium text-gray-12 transition-colors hover:bg-gray-4 disabled:opacity-60"
					>
						{loading ? tShare("aiStarting") : tShare("aiReanalyze")}
					</button>
				</div>
			);
		}

		// Good analysis: don't alarm the owner with a panel — tuck re-analyze
		// into a discreet overflow menu instead.
		return (
			<div className="flex justify-end">
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							aria-label={tShare("aiReanalyze")}
							className="rounded-md p-1.5 text-gray-9 hover:bg-gray-3 hover:text-gray-11"
						>
							<MoreVertical className="size-4" />
						</button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem
							disabled={loading}
							onClick={() => requestStart(true, "full")}
						>
							{tShare("aiReanalyze")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		);
	}

	// ── Banked request: pressed, recorded server-side, not yet claimed ────────
	// Before this branch the panel fell straight through to the start button
	// while the request was genuinely pending, so a press that WAS honoured
	// looked like a press that did nothing — and only a full page reload
	// showed the truth. `aiRequestPending` is false the moment the pipeline
	// claims the row (transcription goes PROCESSING) or anything fails, so the
	// error branch above still owns failures and the retry button stays
	// reachable.
	// `canGenerate` gates it because this panel also renders for public
	// share-link viewers: without the gate a visitor reads "your request is
	// saved…" about a request they never made, and it leaks that the owner
	// started a job. A viewer falls through to the `aiNotAvailable` branch
	// below, exactly as before this feature existed.
	if (canGenerate && aiRequestPending) {
		return (
			<div className="flex items-start gap-3 rounded-xl border border-gray-4 bg-gray-2 px-4 py-4">
				<div className="relative flex size-10 shrink-0 items-center justify-center rounded-xl bg-[var(--brand-wash)] text-[var(--brand)]">
					<Sparkles aria-hidden className="size-5" />
					<span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-gray-1 bg-[var(--brand)] motion-safe:animate-pulse" />
				</div>
				<div className="min-w-0" aria-live="polite">
					<p className="text-sm font-semibold text-gray-12">
						{tShare("aiQueuedTitle")}
					</p>
					<p className="mt-0.5 text-xs text-gray-10">
						{tShare("aiQueuedHint")}
					</p>
					{budgetBlocked && canGenerate ? (
						<p className="mt-1 text-xs text-red-11">
							{tShare("aiBudgetBlocked", {
								spent: `$${budgetBlocked.spentUsd.toFixed(2)}`,
								cap: `$${budgetBlocked.capUsd.toFixed(2)}`,
							})}
						</p>
					) : (
						error && <p className="mt-1 text-xs text-red-10">{error}</p>
					)}
					{/* A screen with no action is a trap. The banked marker is only
					    cleared by a redeemer that takes the job, and the recovery
					    cron deliberately KEEPS it when it refuses for a reason that
					    is not "upload in progress" — no usable key, budget spent.
					    Without this button that state renders "queued" forever with
					    nothing to press. Pressing again simply re-banks the same
					    markers, and the route still refuses to start a duplicate
					    once a job is genuinely QUEUED or PROCESSING. */}
					<button
						type="button"
						disabled={loading}
						onClick={() => requestStart(false)}
						className="mt-2 self-start rounded-lg border border-gray-5 px-3 py-1.5 text-xs font-medium text-gray-12 transition-opacity hover:opacity-90 disabled:opacity-60"
					>
						{tShare("aiStartAnalysis")}
					</button>
				</div>
			</div>
		);
	}

	// ── Start button (admin/owner) ────────────────────────────────────────────
	// Two distinct sub-cases now that generate/route.ts no longer auto-chains
	// AI after transcription: nothing has run yet (button starts transcription
	// only) vs transcript ready and AI is the optional next step (button
	// starts AI generation only, since transcription is already COMPLETE).
	if (canGenerate && !transcriptionStatus) {
		return (
			<div className="flex flex-col gap-3 rounded-xl border border-blue-6 bg-blue-3 px-4 py-4">
				<p className="text-sm text-gray-12">{tShare("transcriptNotRunYet")}</p>
				{aiNotice && (
					<p className="text-xs text-gray-10">
						{tShare(aiNotice === "long" ? "aiNoticeLong" : "aiNoticeMedium")}
					</p>
				)}
				<p className="text-xs text-gray-10">{tShare("aiFreeFirstHint")}</p>
				{budgetBlocked && canGenerate ? (
					<p className="text-xs text-red-11">
						{tShare("aiBudgetBlocked", {
							spent: `$${budgetBlocked.spentUsd.toFixed(2)}`,
							cap: `$${budgetBlocked.capUsd.toFixed(2)}`,
						})}
					</p>
				) : (
					error && <p className="text-xs text-red-10">{error}</p>
				)}
				{/* The explicit two-mode choice (2026-09-10): one press, no hidden
				    second step. "Full AI analysis" = transcript + summary/tasks in
				    one run; "Only transcript" = transcribe and stop there. Stacked
				    on a phone, side by side from sm up — neither label may wrap. */}
				<div className="flex flex-col gap-2 sm:flex-row sm:items-center">
					<button
						type="button"
						disabled={loading}
						onClick={() => requestStart(false, "full")}
						className="rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-60"
					>
						{tShare("aiStartFullAnalysis")}
					</button>
					<button
						type="button"
						disabled={loading}
						onClick={() => requestStart(false, "transcript")}
						className="rounded-lg border border-gray-5 bg-gray-3 px-4 py-2.5 text-sm font-medium text-gray-12 transition-colors hover:bg-gray-4 disabled:opacity-60"
					>
						{tShare("aiStartTranscriptOnly")}
					</button>
				</div>
				{loading && (
					<p className="text-xs text-gray-10">{tShare("aiStarting")}</p>
				)}
			</div>
		);
	}

	if (
		canGenerate &&
		transcriptionStatus === "COMPLETE" &&
		aiGenerationStatus !== "COMPLETE"
	) {
		return (
			<div className="flex flex-col gap-3 rounded-xl border border-blue-6 bg-blue-3 px-4 py-4">
				<p className="text-sm text-gray-12">{tShare("aiSummaryOptionalHint")}</p>
				{aiNotice && (
					<p className="text-xs text-gray-10">
						{tShare(aiNotice === "long" ? "aiNoticeLong" : "aiNoticeMedium")}
					</p>
				)}
				<p className="text-xs text-gray-10">{tShare("aiFreeFirstHint")}</p>
				{budgetBlocked && canGenerate ? (
					<p className="text-xs text-red-11">
						{tShare("aiBudgetBlocked", {
							spent: `$${budgetBlocked.spentUsd.toFixed(2)}`,
							cap: `$${budgetBlocked.capUsd.toFixed(2)}`,
						})}
					</p>
				) : (
					error && <p className="text-xs text-red-10">{error}</p>
				)}
				<button
					type="button"
					disabled={loading}
					onClick={() => requestStart(false, "full")}
					className="self-start rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-60"
				>
					{tShare("aiStartSummary")}
				</button>
				{loading && (
					<p className="text-xs text-gray-10">{tShare("aiStarting")}</p>
				)}
			</div>
		);
	}

	// ── Non-admin viewer with no content ─────────────────────────────────────
	if (!transcriptionStatus && !aiGenerationStatus) {
		return (
			<div className="rounded-xl border border-gray-4 bg-gray-2 px-4 py-6 text-center">
				<p className="text-sm text-gray-10">{tShare("aiNotAvailable")}</p>
			</div>
		);
	}

	return null;
}

function CheckIcon({ className }: { className?: string }) {
	return (
		<svg
			aria-hidden="true"
			className={className}
			xmlns="http://www.w3.org/2000/svg"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth={3}
			strokeLinecap="round"
			strokeLinejoin="round"
		>
			<path d="M5 13l4 4L19 7" />
		</svg>
	);
}
