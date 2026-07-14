"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@cap/ui";
import type { Video } from "@cap/web-domain";
import { MoreVertical } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRef, useState } from "react";

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
type AiSpeedMode = "fast" | "cheap";

interface GenerateAiPanelProps {
	videoId: Video.VideoId;
	canGenerate: boolean;
	transcriptionStatus: TranscriptionStatus | null | undefined;
	aiGenerationStatus: AiGenerationStatus | null | undefined;
	aiProcessingStep?: AiProcessingStep | null;
	aiMode?: AiSpeedMode | null;
	aiQuotaWaiting?: boolean;
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
	aiMode,
	aiQuotaWaiting = false,
	duration,
	aiIncomplete = false,
	transcriptionChunksCompleted,
	transcriptionChunksTotal,
	aiStageChunksCompleted,
	aiStageChunksTotal,
	processingStartedAt,
	aiProcessingStartedAt,
	onStarted,
}: GenerateAiPanelProps) {
	const tShare = useTranslations("share");
	const [loading, setLoading] = useState(false);
	const [continuingPaid, setContinuingPaid] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// Mode chooser step: starting analysis can spend real Gemini API money, so an
	// accidental tap must not fire it. null = no pending request.
	const [confirm, setConfirm] = useState<{ reprocess: boolean } | null>(null);
	const inFlightRef = useRef(false);
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

	// Fires the generation POST. Reached ONLY via the mode chooser block below —
	// every start/re-analyze trigger first sets `confirm`, so an accidental tap
	// never starts the job.
	const requestStart = (reprocess = false, speedMode: AiSpeedMode) => {
		// Synchronous in-flight guard: a very fast double-click can fire before the
		// `loading` state re-renders the disabled buttons, sending two POSTs.
		// The ref blocks the second call instantly.
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setConfirm(null);
		setLoading(true);
		setError(null);
		void (async () => {
			try {
				const res = await fetch(`/api/videos/${videoId}/generate`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ reprocess, speedMode }),
				});
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					setError((body as { error?: string }).error ?? "An error occurred");
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

	const requestContinuePaid = () => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setContinuingPaid(true);
		setError(null);
		void (async () => {
			try {
				const res = await fetch(`/api/videos/${videoId}/continue-paid`, {
					method: "POST",
				});
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					setError((body as { error?: string }).error ?? "An error occurred");
				} else {
					onStarted?.();
				}
			} catch {
				setError("An error occurred");
			} finally {
				setContinuingPaid(false);
				inFlightRef.current = false;
			}
		})();
	};

	// Shared mode chooser block: rendered in place of a trigger button
	// whenever `confirm` is set, across all three start/re-analyze entry points.
	const modeConfirm = confirm ? (
		<div className="flex flex-col gap-2">
			<p className="text-xs font-medium text-gray-10">
				{tShare("aiChooseMode")}
			</p>
			<div className="grid gap-2 sm:grid-cols-2">
				<button
					type="button"
					disabled={loading}
					onClick={() => requestStart(confirm.reprocess, "fast")}
					className="flex flex-col items-start rounded-lg bg-[var(--brand)] px-4 py-2 text-left text-sm font-semibold text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-60"
				>
					<span>{tShare("aiModeFast")}</span>
					<span className="text-xs font-medium opacity-85">
						{tShare("aiModeFastHint")}
					</span>
				</button>
				<button
					type="button"
					disabled={loading}
					onClick={() => requestStart(confirm.reprocess, "cheap")}
					className="flex flex-col items-start rounded-lg border border-gray-5 bg-gray-3 px-4 py-2 text-left text-sm font-semibold text-gray-12 transition-colors hover:bg-gray-4 disabled:opacity-60"
				>
					<span>{tShare("aiModeCheap")}</span>
					<span className="text-xs font-medium text-gray-10">
						{tShare("aiModeCheapHint")}
					</span>
				</button>
			</div>
			<div>
				<button
					type="button"
					onClick={() => setConfirm(null)}
					className="rounded-lg px-3 py-1.5 text-xs font-medium text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-12"
				>
					{tShare("aiConfirmCancel")}
				</button>
			</div>
		</div>
	) : null;

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
			etaMinRef.current.value = Math.min(
				etaMinRef.current.value,
				rawEtaMin,
			);
		} else {
			etaMinRef.current = { step: currentStep, value: rawEtaMin };
		}
		const etaMin = etaMinRef.current.value;
		const etaLabel =
			etaMin < 1 ? tShare("aiEtaSoon") : tShare("aiEta", { minutes: etaMin });

		const currentMode: AiSpeedMode = aiMode === "cheap" ? "cheap" : "fast";
		const modeLabel =
			currentMode === "cheap"
				? tShare("aiModeCheapShort")
				: tShare("aiModeFastShort");

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
		const activeStage = runningStages[currentIdx];
		const withinFraction =
			activeStage && activeStage.total > 0
				? Math.min(1, activeStage.completed / activeStage.total)
				: 0;
		// (completedStages + fraction-through-active-stage) / 3. Advances by whole
		// thirds even when a stage reports no chunk total, so the bar still moves.
		const overallPct = Math.min(
			100,
			Math.round(((Math.min(currentIdx, 3) + withinFraction) / 3) * 100),
		);
		const stageNumber = Math.min(currentIdx + 1, runningStages.length);

		return (
			<div className="flex flex-col gap-3 rounded-xl border border-border bg-gray-2 p-4">
				{/* Indeterminate-slide keyframes, scoped to this card. Defined here
				    (not tailwind.config) to keep the change local to this component. */}
				<style>{`
					@keyframes ustozAiEtaSlide {
						0% { transform: translateX(-100%); }
						100% { transform: translateX(430%); }
					}
				`}</style>

				{/* Header row — quiet, no pill/wash/spinner */}
				<div className="flex items-center justify-between gap-2">
					<span className="text-xs font-medium text-gray-11">
						{tShare("aiStepAiAnalysis")}
					</span>
					<span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-gray-10">
						{modeLabel}
					</span>
				</div>

				{/* Overall glance readout: what's happening now + stage N/3 + ETA,
				    over one continuous bar so the whole-pipeline position is felt. */}
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between gap-2">
						<span className="text-[15px] font-semibold text-gray-12">
							{currentFocalLabel}
						</span>
						<span className="shrink-0 text-[12px] tabular-nums text-gray-10">
							{tShare("aiStageOfTotal", {
								current: stageNumber,
								total: runningStages.length,
							})}{" "}
							· {etaLabel}
						</span>
					</div>
					<div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-5">
						<div
							className="h-full rounded-full bg-[var(--brand)] motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out"
							style={{ width: `${overallPct}%` }}
						/>
					</div>
				</div>

				{/* Vertical stage list — no connector lines, whitespace + dot state
				    carry the sequence. */}
				<div className="flex flex-col gap-3" aria-label={tShare("aiAnalysisStage")}>
					{runningStages.map((stage, i) => {
						const state =
							i < currentIdx
								? "done"
								: i === currentIdx
									? "active"
									: "pending";

						if (state === "done") {
							return (
								<div key={stage.key} className="flex items-center gap-2">
									<span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[var(--brand)]">
										<CheckIcon className="size-2.5 text-[var(--brand-fg)]" />
									</span>
									<span className="text-[13px] font-medium text-gray-11">
										{stage.nounLabel}
									</span>
								</div>
							);
						}

						if (state === "pending") {
							return (
								<div key={stage.key} className="flex items-center gap-2">
									<span className="size-4 shrink-0 rounded-full border-2 border-border" />
									<span className="text-[13px] text-gray-9">
										{stage.nounLabel}
									</span>
								</div>
							);
						}

						// active — the focal row: verb label + determinate/indeterminate bar
						const hasTotal = stage.total > 0;
						const pct = hasTotal
							? Math.min(
									100,
									Math.round((stage.completed / stage.total) * 100),
								)
							: 0;
						return (
							<div key={stage.key} className="flex flex-col gap-1.5">
								<div className="flex items-center gap-2">
									<span className="flex size-4 shrink-0 items-center justify-center rounded-full border-2 border-[var(--brand)]">
										<span className="size-1.5 rounded-full bg-[var(--brand)]" />
									</span>
									<span className="text-[15px] font-semibold text-gray-12">
										{stage.focalLabel}
									</span>
								</div>
								<div className="flex flex-col gap-1 pl-[26px]">
									{hasTotal ? (
										<>
											<div className="h-1 w-full overflow-hidden rounded-full bg-gray-5">
												<div
													className="h-full rounded-full bg-[var(--brand)] motion-safe:transition-[width] motion-safe:duration-700 motion-safe:ease-out"
													style={{ width: `${pct}%` }}
												/>
											</div>
											<div className="flex items-center justify-between text-[12px] tabular-nums text-gray-10">
												<span>
													{stage.completed}/{stage.total}
												</span>
												<span>{etaLabel}</span>
											</div>
										</>
									) : (
										<>
											<div className="relative h-1 w-full overflow-hidden rounded-full bg-gray-5">
												<div className="absolute inset-y-0 left-0 w-[30%] rounded-full bg-[var(--brand)] motion-reduce:w-[25%] motion-safe:animate-[ustozAiEtaSlide_1.6s_ease-in-out_infinite]" />
											</div>
											<span className="text-[12px] text-gray-10">
												{tShare("aiStarting")}
											</span>
										</>
									)}
								</div>
							</div>
						);
					})}
				</div>

				{currentMode === "cheap" && aiQuotaWaiting && (
					<p className="text-[12px] text-amber-11">
						{tShare("aiModeCheapQuotaWaiting")}
					</p>
				)}

				{error && <p className="text-xs text-red-10">{error}</p>}

				{canGenerate && currentMode === "cheap" && (
					<button
						type="button"
						disabled={continuingPaid}
						onClick={requestContinuePaid}
						className="self-start rounded-lg border border-gray-5 px-3 py-1.5 text-xs font-semibold text-gray-12 hover:bg-gray-3 disabled:opacity-60"
					>
						{continuingPaid
							? tShare("aiContinuingPaid")
							: tShare("aiContinuePaid")}
					</button>
				)}
			</div>
		);
	}

	// ── Error state ───────────────────────────────────────────────────────────
	if (hasError && canGenerate) {
		return (
			<div className="flex flex-col gap-3 rounded-xl border border-red-6 bg-red-3 px-4 py-4">
				<p className="text-sm text-red-11">
					{tShare("aiAnalysisFailed")}{" "}
					{transcriptionStatus === "ERROR"
						? tShare("aiTranscriptionFailed")
						: tShare("aiGenerationError")}
				</p>
				{error && <p className="text-xs text-red-10">{error}</p>}
				{confirm ? (
					modeConfirm
				) : (
					<button
						type="button"
						disabled={loading}
						onClick={() => setConfirm({ reprocess: false })}
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
					{confirm ? (
						modeConfirm
					) : (
						<button
							type="button"
							disabled={loading}
							onClick={() => setConfirm({ reprocess: true })}
							className="self-start rounded-lg border border-gray-5 bg-gray-3 px-4 py-2 text-sm font-medium text-gray-12 transition-colors hover:bg-gray-4 disabled:opacity-60"
						>
							{loading ? tShare("aiStarting") : tShare("aiReanalyze")}
						</button>
					)}
				</div>
			);
		}

		// Good analysis: don't alarm the owner with a panel — tuck re-analyze
		// into a discreet overflow menu instead.
		if (confirm) {
			return (
				<div className="flex flex-col gap-2 rounded-xl border border-gray-4 bg-gray-2 px-4 py-3">
					{modeConfirm}
				</div>
			);
		}
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
							onClick={() => setConfirm({ reprocess: true })}
						>
							{tShare("aiReanalyze")}
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
		);
	}

	// ── Start button (admin/owner) ────────────────────────────────────────────
	if (
		canGenerate &&
		(!transcriptionStatus ||
			(transcriptionStatus === "COMPLETE" && aiGenerationStatus !== "COMPLETE"))
	) {
		return (
			<div className="flex flex-col gap-3 rounded-xl border border-blue-6 bg-blue-3 px-4 py-4">
				<p className="text-sm text-gray-12">{tShare("aiNotRunYet")}</p>
				{aiNotice && (
					<p className="text-xs text-gray-10">
						{tShare(aiNotice === "long" ? "aiNoticeLong" : "aiNoticeMedium")}
					</p>
				)}
				{error && <p className="text-xs text-red-10">{error}</p>}
				{confirm ? (
					modeConfirm
				) : (
					<button
						type="button"
						disabled={loading}
						onClick={() => setConfirm({ reprocess: false })}
						className="self-start rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-[var(--brand-fg)] transition-opacity hover:opacity-90 disabled:opacity-60"
					>
						{tShare("aiStartAnalysis")}
					</button>
				)}
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
