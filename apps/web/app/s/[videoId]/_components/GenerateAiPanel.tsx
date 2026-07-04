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

interface GenerateAiPanelProps {
	videoId: Video.VideoId;
	canGenerate: boolean;
	transcriptionStatus: TranscriptionStatus | null | undefined;
	aiGenerationStatus: AiGenerationStatus | null | undefined;
	aiProcessingStep?: AiProcessingStep | null;
	duration?: number | null;
	aiSpeedMode?: "fast" | "cheap";
	/** When true, the completed analysis looks incomplete ("chala") and the
	 * re-analyze affordance should be shown prominently instead of tucked away. */
	aiIncomplete?: boolean;
	/** Called after a successful POST so the parent can refetch status */
	onStarted?: () => void;
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
	duration,
	aiSpeedMode = "fast",
	aiIncomplete = false,
	onStarted,
}: GenerateAiPanelProps) {
	const tShare = useTranslations("share");
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	// The speed (Arzon/Tez) chooser only appears after the owner presses the
	// first "AI tahlil" button, so starting analysis is a deliberate two-step.
	const [showChooser, setShowChooser] = useState(false);
	const inFlightRef = useRef(false);
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

	// Fire AI generation directly on click — one click is enough. No second
	// confirmation dialog (AI is admin-only and the panel already states it uses
	// extra time + budget). Each price-chooser option IS the one click.
	const requestStart = (reprocess = false, speedMode?: "fast" | "cheap") => {
		// Synchronous in-flight guard: a very fast double-click can fire before the
		// `loading` state re-renders the disabled buttons, sending two POSTs (with
		// possibly different speedModes). The ref blocks the second call instantly.
		if (inFlightRef.current) return;
		inFlightRef.current = true;
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
		const currentIdx = stepOrder.indexOf(currentStep);
		const labelKey =
			currentStep === "transcribe" ? "aiTranscribing" : "aiGenerating";

		const stepLabelKey = {
			transcribe: "stepTranscribe",
			summary: "stepSummary",
			refined: "stepRefined",
			done: "stepDone",
		} as const;
		const steps = stepOrder.map((key) => {
			const idx = stepOrder.indexOf(key);
			const state =
				idx < currentIdx
					? "done"
					: idx === currentIdx
						? currentStep === "done"
							? "done"
							: "current"
						: "pending";
			return { key, label: tShare(stepLabelKey[key]), state };
		});

		const etaMin = Math.max(1, Math.round((duration ?? 120) / 120));

		return (
			<div className="flex flex-col gap-3 rounded-xl border border-border bg-gray-2 px-4 py-4">
				{/* Header row */}
				<div className="flex justify-between items-center gap-2">
					<span className="inline-flex items-center gap-2 rounded-full bg-[var(--brand-wash)] px-2.5 py-1 text-[11px] font-semibold text-[var(--brand)]">
						<SpinnerIcon />
						{tShare("aiBadge")}
					</span>
					{duration != null && (
						<span className="inline-flex items-center rounded-full border border-border px-2.5 py-1 text-[11px] font-semibold text-gray-10">
							{tShare("aiEta", { minutes: etaMin })}
						</span>
					)}
				</div>

				{/* Stepper */}
				<div className="flex" aria-label={tShare("aiAnalysisStage")}>
					{steps.map((step, i) => (
						<div
							key={step.key}
							className="flex flex-1 flex-col items-center gap-1.5 last:flex-none"
						>
							<div className="relative flex w-full items-center justify-center">
								<div
									className={`flex size-[22px] items-center justify-center rounded-full border-2 text-[11px] font-semibold relative z-10 ${
										step.state === "done"
											? "bg-[var(--brand)] border-[var(--brand)] text-[var(--brand-fg)]"
											: step.state === "current"
												? "border-[var(--brand)] text-[var(--brand)] shadow-[0_0_0_4px_var(--brand-wash)] animate-pulse"
												: "border-border text-gray-9"
									}`}
								>
									{step.state === "done" ? "✓" : i + 1}
								</div>
								{i < steps.length - 1 && (
									<span
										aria-hidden="true"
										className={`absolute top-[10px] left-1/2 h-0.5 w-full ${
											step.state === "done" ? "bg-[var(--brand)]" : "bg-border"
										}`}
									/>
								)}
							</div>
							<span
								className={`text-[11.5px] font-semibold ${
									step.state === "pending" ? "text-gray-9" : "text-gray-12"
								}`}
							>
								{step.label}
							</span>
						</div>
					))}
				</div>

				{/* Status row — reflects the CURRENT stage, not a fixed message */}
				<div className="flex items-center gap-2 text-[13.5px] font-medium text-gray-12">
					<SpinnerIcon />
					{tShare(labelKey)}
				</div>

				{/* Skeleton */}
				<div className="flex flex-col gap-2">
					<div
						className="h-3 rounded-md bg-[var(--brand-wash)] animate-pulse"
						style={{ width: "95%" }}
					/>
					<div
						className="h-3 rounded-md bg-[var(--brand-wash)] animate-pulse"
						style={{ width: "88%" }}
					/>
					<div
						className="h-3 rounded-md bg-[var(--brand-wash)] animate-pulse"
						style={{ width: "92%" }}
					/>
					<div
						className="h-3 rounded-md bg-[var(--brand-wash)] animate-pulse"
						style={{ width: "58%" }}
					/>
					<span className="text-[11px] font-semibold uppercase tracking-wide text-gray-10">
						{tShare("skeletonNextSteps")}
					</span>
					<div
						className="h-3 rounded-md bg-[var(--brand-wash)] animate-pulse"
						style={{ width: "78%" }}
					/>
					<div
						className="h-3 rounded-md bg-[var(--brand-wash)] animate-pulse"
						style={{ width: "66%" }}
					/>
				</div>
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
				<button
					type="button"
					disabled={loading}
					onClick={() => requestStart(false)}
					className="self-start rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-red-700 disabled:opacity-60"
				>
					{loading ? tShare("aiStarting") : tShare("aiRetry")}
				</button>
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
						onClick={() => requestStart(true)}
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
							onClick={() => requestStart(true)}
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
				{!showChooser && (
					<button
						type="button"
						onClick={() => setShowChooser(true)}
						className="self-start rounded-lg bg-[var(--brand)] px-4 py-2.5 text-sm font-semibold text-[var(--brand-fg)] transition-opacity hover:opacity-90"
					>
						{tShare("aiStartAnalysis")}
					</button>
				)}
				{showChooser && (
					<>
						<p className="text-xs font-medium text-gray-11">
							{tShare("aiSpeedChooserTitle")}
						</p>
						<div role="radiogroup" className="flex flex-col gap-2 sm:flex-row">
							<button
								type="button"
								role="radio"
								aria-checked={aiSpeedMode === "cheap"}
								disabled={loading}
								onClick={() => requestStart(false, "cheap")}
								className={`flex-1 rounded-lg border px-4 py-2.5 text-left transition-colors disabled:opacity-60 ${
									aiSpeedMode === "cheap"
										? "border-[var(--brand)] bg-[var(--brand-wash)]"
										: "border-blue-6 bg-blue-2 hover:bg-blue-3"
								}`}
							>
								<span className="block text-sm font-medium text-gray-12">
									{tShare("aiSpeedChooserCheapLabel")}
								</span>
								<span className="block text-xs text-gray-10">
									{tShare("aiSpeedChooserCheapHint")}
								</span>
							</button>
							<button
								type="button"
								role="radio"
								aria-checked={aiSpeedMode === "fast"}
								disabled={loading}
								onClick={() => requestStart(false, "fast")}
								className={`flex-1 rounded-lg border px-4 py-2.5 text-left transition-colors disabled:opacity-60 ${
									aiSpeedMode === "fast"
										? "border-[var(--brand)] bg-[var(--brand-wash)]"
										: "border-blue-6 bg-blue-2 hover:bg-blue-3"
								}`}
							>
								<span className="block text-sm font-medium text-gray-12">
									{tShare("aiSpeedChooserFastLabel")}
								</span>
								<span className="block text-xs text-gray-10">
									{tShare("aiSpeedChooserFastHint")}
								</span>
							</button>
						</div>
					</>
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

function SpinnerIcon() {
	return (
		<svg
			className="size-4 animate-spin text-[var(--brand)]"
			xmlns="http://www.w3.org/2000/svg"
			fill="none"
			viewBox="0 0 24 24"
		>
			<circle
				className="opacity-25"
				cx="12"
				cy="12"
				r="10"
				stroke="currentColor"
				strokeWidth="4"
			/>
			<path
				className="opacity-75"
				fill="currentColor"
				d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
			/>
		</svg>
	);
}
