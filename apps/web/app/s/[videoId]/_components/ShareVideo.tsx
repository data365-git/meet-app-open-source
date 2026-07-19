import type { comments as commentsSchema } from "@cap/database/schema";
import type { ShareLanguage } from "@cap/database/types";
import { Logo } from "@cap/ui";
import type { ImageUpload } from "@cap/web-domain";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { useAiStatus } from "hooks/use-ai-status";
import { useAiTranslation } from "hooks/use-ai-translation";
import { useTranscript } from "hooks/use-transcript";
import { CheckCircle2, Info, Loader2Icon } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import {
	forwardRef,
	startTransition,
	useCallback,
	useEffect,
	useImperativeHandle,
	useMemo,
	useRef,
	useState,
} from "react";
import { toast } from "sonner";
import { finalizeDesktopSegmentsRecording } from "@/actions/video/finalize-desktop-segments";
import { getTranscript } from "@/actions/videos/get-transcript";
import { Tooltip } from "@/components/Tooltip";
import { UpgradeModal } from "@/components/UpgradeModal";
import { isRetryableDesktopSegmentsFinalizationError } from "@/lib/desktop-segments-retryable-errors";
import type { VideoData } from "../types";
import { AIChatPopup } from "./AIChatPopup";
import { AIFab } from "./AIFab";
import { useCaptionContext } from "./CaptionContext";
import { CapVideoPlayer } from "./CapVideoPlayer";
import { DockableVideo } from "./DockableVideo";
import { GenerateAiPanel } from "./GenerateAiPanel";
import { detectShareLanguage } from "./LanguagePicker";
import {
	shouldDeferPlaybackSource,
	shouldReloadPlaybackAfterUploadCompletes,
	useUploadProgress,
} from "./ProgressCircle";
import { RefinedTranscriptPanel } from "./panels/RefinedTranscriptPanel";
import { SummaryPanel } from "./panels/SummaryPanel";
import { TasksPanel } from "./panels/TasksPanel";
import { TranscriptPanel } from "./panels/TranscriptPanel";
import {
	PreparingVideoOverlay,
	RecordingInProgressOverlay,
} from "./RecordingInProgress";
import { SharePanel } from "./SharePanel";
import { toStandardWebVtt } from "./utils/caption-vtt";
import { clampStartSec, formatChaptersAsVTT } from "./utils/transcript-utils";

type CommentWithAuthor = typeof commentsSchema.$inferSelect & {
	authorName: string | null;
	authorImage: ImageUpload.ImageUrl | null;
};

type AiGenerationStatus =
	| "QUEUED"
	| "PROCESSING"
	| "COMPLETE"
	| "ERROR"
	| "SKIPPED";

export const ShareVideo = forwardRef<
	HTMLVideoElement,
	{
		data: VideoData & {
			hasActiveUpload?: boolean;
		};
		comments: MaybePromise<CommentWithAuthor[]>;
		chapters?: { title: string; start: number }[];
		areChaptersDisabled?: boolean;
		areCaptionsDisabled?: boolean;
		areCommentStampsDisabled?: boolean;
		areReactionStampsDisabled?: boolean;
		aiGenerationStatus?: AiGenerationStatus | null;
		canRetryProcessing?: boolean;
		canReplaceWithAudio?: boolean;
		canFinalizeDesktopSegments?: boolean;
		showPlaybackStatusBadge?: boolean;
		isEditProcessing: boolean;
		recordingStopped?: boolean;
		defaultPlaybackSpeed?: number;
		canGenerate?: boolean;
		/** Owner/member-only cost card rendered above the share panel. */
		costPanel?: React.ReactNode;
		/** Comments/activity content for the panel's "Izohlar" tab. */
		commentsPanel?: React.ReactNode;
	}
>(
	(
		{
			data,
			comments,
			chapters = [],
			areCaptionsDisabled,
			areChaptersDisabled,
			areCommentStampsDisabled,
			areReactionStampsDisabled,
			aiGenerationStatus,
			canRetryProcessing,
			canReplaceWithAudio,
			canFinalizeDesktopSegments = false,
			showPlaybackStatusBadge = false,
			isEditProcessing,
			recordingStopped = false,
			defaultPlaybackSpeed,
			canGenerate = false,
			costPanel,
			commentsPanel,
		},
		ref,
	) => {
		const t = useTranslations("share");
		const videoRef = useRef<HTMLVideoElement | null>(null);
		useImperativeHandle(ref, () => videoRef.current as HTMLVideoElement, []);
		const router = useRouter();
		const searchParams = useSearchParams();
		// Chat UI: the blue-FAB → dialog chat is the DEFAULT (owner choice
		// 2026-07-13). `?variant=inline` still opts into the in-panel inline chat.
		const chatVariant: "modal" | "inline" =
			searchParams.get("variant") === "inline" ? "inline" : "modal";

		const safeChapters = useMemo(
			() =>
				chapters.map((c) => ({
					...c,
					start: clampStartSec(c.start, data.duration ?? undefined),
				})),
			[chapters, data.duration],
		);
		const handleUploadComplete = useCallback(() => {
			router.refresh();
		}, [router]);

		const captionContext = useCaptionContext();

		const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
		const [subtitleUrl, setSubtitleUrl] = useState<string | null>(null);
		const [chaptersUrl, setChaptersUrl] = useState<string | null>(null);
		const [commentsData, setCommentsData] = useState<CommentWithAuthor[]>([]);
		const [userConfirmedStopped, setUserConfirmedStopped] =
			useState(recordingStopped);
		const [isConfirmingStopped, setIsConfirmingStopped] = useState(false);
		const [confirmStoppedError, setConfirmStoppedError] = useState<
			string | null
		>(null);
		const [currentTime, setCurrentTime] = useState(0);
		const [aiChatOpen, setAiChatOpen] = useState(false);
		const autoFinalizeAttemptedRef = useRef(false);
		const segmentUploadProgress = useUploadProgress(
			data.id,
			data.source.type === "desktopSegments" && (data.hasActiveUpload ?? false),
		);

		const { data: transcript, error: transcriptError } = useTranscript(
			data.id,
			data.transcriptionStatus,
		);

		const [selectedLanguage, setSelectedLanguage] = useState<
			"base" | ShareLanguage
		>(data.metadata?.preferredLanguage ?? "base");
		const [generatingLanguage, setGeneratingLanguage] =
			useState<ShareLanguage | null>(null);
		const [activeTranscriptVtt, setActiveTranscriptVtt] = useState<
			string | null
		>(null);
		const translationGeneratedRef = useRef(false);

		const [optimisticAiStatus, setOptimisticAiStatus] =
			useState<AiGenerationStatus | null>(null);
		const [aiPollEnabled, setAiPollEnabled] = useState(
			aiGenerationStatus === "QUEUED" || aiGenerationStatus === "PROCESSING",
		);
		const aiStatusQuery = useAiStatus(data.id, aiPollEnabled);
		const aiRefreshedRef = useRef(false);
		const aiTranslationQuery = useAiTranslation(
			data.id,
			generatingLanguage,
			generatingLanguage !== null,
		);

		const handleAiStarted = useCallback(() => {
			aiRefreshedRef.current = false;
			setOptimisticAiStatus("QUEUED");
			setAiPollEnabled(true);
		}, []);

		const handleGenerateTranslation = useCallback(
			async (lang: ShareLanguage) => {
				translationGeneratedRef.current = false;
				setGeneratingLanguage(lang);
				try {
					const res = await fetch("/api/video/ai/translate", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ videoId: data.id, language: lang }),
					});
					if (!res.ok) {
						setGeneratingLanguage(null);
						toast.error(t("translationError"));
					}
				} catch {
					setGeneratingLanguage(null);
					toast.error(t("translationError"));
				}
			},
			[data.id, t],
		);

		// Stop polling + pull server-rendered content once generation reaches a terminal state.
		useEffect(() => {
			const d = aiStatusQuery.data;
			if (!d || !aiPollEnabled) return;
			const terminal =
				d.hasContent ||
				d.aiGenerationStatus === "COMPLETE" ||
				d.aiGenerationStatus === "ERROR" ||
				d.aiGenerationStatus === "SKIPPED";
			if (terminal && !aiRefreshedRef.current) {
				aiRefreshedRef.current = true;
				setAiPollEnabled(false);
				setOptimisticAiStatus(null);
				router.refresh();
			}
		}, [aiStatusQuery.data, aiPollEnabled, router]);

		useEffect(() => {
			if (!generatingLanguage) return;
			const d = aiTranslationQuery.data;
			if (!d) return;
			const lang = generatingLanguage;
			if (d.status === "ERROR") {
				setGeneratingLanguage(null);
				toast.error(t("translationError"));
				return;
			}
			const terminal = d.hasContent || d.status === "COMPLETE";
			if (terminal && !translationGeneratedRef.current) {
				translationGeneratedRef.current = true;
				router.refresh();
				setSelectedLanguage(lang);
				setGeneratingLanguage(null);
			}
		}, [aiTranslationQuery.data, generatingLanguage, router, t]);

		// Clear optimistic state when the server prop settles to a terminal status.
		useEffect(() => {
			if (
				aiGenerationStatus === "COMPLETE" ||
				aiGenerationStatus === "ERROR" ||
				aiGenerationStatus === "SKIPPED"
			) {
				setOptimisticAiStatus(null);
			}
		}, [aiGenerationStatus]);

		const effectiveAiStatus =
			aiStatusQuery.data?.aiGenerationStatus ??
			optimisticAiStatus ??
			aiGenerationStatus;

		const effectiveAiProcessingStep =
			aiStatusQuery.data?.aiProcessingStep ??
			data.metadata?.aiProcessingStep ??
			null;
		const effectiveAiMode =
			aiStatusQuery.data?.aiMode ?? data.metadata?.aiMode ?? null;
		const effectiveAiQuotaWaiting =
			aiStatusQuery.data?.aiQuotaWaiting ??
			data.metadata?.aiQuotaWaiting === true;

		// Mirrors GenerateAiPanel's `isRunning` predicate so SharePanel can lock
		// the other tabs / AI input while transcription or AI generation is busy.
		const aiProcessing =
			data.transcriptionStatus === "PROCESSING" ||
			effectiveAiStatus === "QUEUED" ||
			effectiveAiStatus === "PROCESSING";

		// AI GENERATION (summary/tasks/refined) is finished — lets SharePanel keep
		// the Tasks/Refined tabs reachable independently of the transcript.
		const aiContentReady =
			effectiveAiStatus === "COMPLETE" || effectiveAiStatus === "SKIPPED";

		// Whether the AI chat can actually answer questions: mirrors what
		// `ensureTranscriptIndex` (chat/route.ts) requires — a non-empty
		// transcript. When false, the ask box is disabled with a friendly note
		// instead of sending and surfacing the raw "index is not ready" error.
		const transcriptReady =
			data.transcriptionStatus === "COMPLETE" &&
			!!(transcript?.content && transcript.content.trim().length > 0);

		// NOTE (Wave 2.1): a periodic `router.refresh()` used to live here to keep
		// GenerateAiPanel's fine per-chunk summary/refine counter
		// (`aiStageChunksCompleted/Total`) live, because that data only lived in
		// `data.metadata` (server-rendered, stale until a full round-trip). Now
		// that `/api/video/ai` (the `aiStatusQuery` poll above, already running
		// every 4s while `aiPollEnabled`) returns those same fields directly, the
		// panel sources them straight from the poll (see `aiStatusQuery.data?.*`
		// below) and the periodic refresh was removed — nothing else depended on
		// it (checked: the other `router.refresh()` calls in this file are each
		// one-shot, tied to a distinct terminal/complete event, not to this
		// interval).

		// "chala" (incomplete-looking) analysis: empty-but-complete, or refined
		// sections fewer than summary chapters (misaligned old-data case).
		const aiIncomplete = useMemo(() => {
			const ai = data.metadata?.aiSummary;
			if (!ai) return false;
			const chapters = ai.chapters?.length ?? 0;
			const refined = ai.refinedTranscript?.chapters?.length ?? 0;
			const hasContent =
				(ai.overview?.trim()?.length ?? 0) > 0 ||
				(ai.topics?.length ?? 0) > 0 ||
				chapters > 0;
			return !hasContent || (chapters > 0 && refined > 0 && refined < chapters);
		}, [data.metadata?.aiSummary, effectiveAiStatus]);

		// Handle comments data
		useEffect(() => {
			if (comments) {
				if (Array.isArray(comments)) {
					setCommentsData(comments);
				} else {
					comments.then(setCommentsData);
				}
			}
		}, [comments]);

		useEffect(() => {
			if (recordingStopped) {
				setUserConfirmedStopped(true);
			}
		}, [recordingStopped]);

		const handleSeek = (time: number) => {
			if (videoRef.current) {
				videoRef.current.currentTime = time;
				setCurrentTime(time);
			}
		};

		// Panels (transcript/refined/summary chapters) jump AND start playback.
		const handleSeekAndPlay = (time: number) => {
			handleSeek(time);
			videoRef.current?.play()?.catch(() => {});
		};

		useEffect(() => {
			// The <video> mounts inside CapVideoPlayer AFTER this effect first
			// runs, so retry until the ref is populated — otherwise currentTime
			// never follows playback (karaoke/active-chapter follow stays frozen).
			//
			// T6 (resume position): also persist currentTime to localStorage
			// (throttled ~5s + on pause/beforeunload) keyed by videoId, and
			// restore it once on loadedmetadata — unless a `?t=` deep-link is
			// present (Share.tsx owns that seek) or the saved time is within
			// ~10s of the end.
			let attached: HTMLVideoElement | null = null;
			let raf = 0;
			const resumeKey = `data365:resume:${data.id}`;
			const hasDeepLink = searchParams.has("t");
			let restoredOnce = false;
			let lastSavedAt = 0;

			const saveResumeTime = (time: number) => {
				try {
					window.localStorage.setItem(resumeKey, String(Math.floor(time)));
				} catch {
					// ignore (storage disabled/full)
				}
			};

			const onTimeUpdate = () => {
				const video = videoRef.current;
				if (!video) return;
				setCurrentTime(video.currentTime);
				const now = Date.now();
				if (now - lastSavedAt >= 5000) {
					lastSavedAt = now;
					saveResumeTime(video.currentTime);
				}
			};

			const onPause = () => {
				if (videoRef.current) saveResumeTime(videoRef.current.currentTime);
			};

			const onBeforeUnload = () => {
				if (videoRef.current) saveResumeTime(videoRef.current.currentTime);
			};

			const onLoadedMetadata = () => {
				const video = videoRef.current;
				if (!video || restoredOnce || hasDeepLink) return;
				restoredOnce = true;
				try {
					const raw = window.localStorage.getItem(resumeKey);
					if (!raw) return;
					const saved = Number(raw);
					if (!Number.isFinite(saved) || saved <= 0) return;
					const duration =
						Number.isFinite(video.duration) && video.duration > 0
							? video.duration
							: (data.duration ?? 0);
					if (duration > 0 && saved >= duration - 10) return;
					video.currentTime = saved;
				} catch {
					// ignore
				}
			};

			const attach = () => {
				const video = videoRef.current;
				if (!video) {
					raf = requestAnimationFrame(attach);
					return;
				}
				attached = video;
				video.addEventListener("timeupdate", onTimeUpdate);
				video.addEventListener("pause", onPause);
				video.addEventListener("loadedmetadata", onLoadedMetadata);
				if (video.readyState >= 1) onLoadedMetadata();
				window.addEventListener("beforeunload", onBeforeUnload);
			};
			attach();
			return () => {
				cancelAnimationFrame(raf);
				attached?.removeEventListener("timeupdate", onTimeUpdate);
				attached?.removeEventListener("pause", onPause);
				attached?.removeEventListener("loadedmetadata", onLoadedMetadata);
				window.removeEventListener("beforeunload", onBeforeUnload);
			};
		}, [data.id, data.duration, searchParams]);

		useEffect(() => {
			if (selectedLanguage === "base") {
				setActiveTranscriptVtt(null);
				return;
			}
			let cancelled = false;
			startTransition(() => {
				getTranscript(data.id, selectedLanguage).then((result) => {
					if (cancelled) return;
					if (result.success && result.content) {
						setActiveTranscriptVtt(result.content);
					}
				});
			});
			return () => {
				cancelled = true;
			};
		}, [data.id, selectedLanguage]);

		useEffect(() => {
			const vttContent =
				selectedLanguage === "base" ? transcript?.content : activeTranscriptVtt;
			if (vttContent) {
				captionContext.setOriginalVttContent(vttContent);
			} else if (selectedLanguage === "base" && transcriptError) {
				console.error(
					"[Transcript] Transcript error from React Query:",
					transcriptError.message,
				);
			}
		}, [
			transcript,
			transcriptError,
			captionContext.setOriginalVttContent,
			selectedLanguage,
			activeTranscriptVtt,
		]);

		useEffect(() => {
			const vttContent = captionContext.currentVttContent;

			if (captionContext.selectedLanguage === "off") {
				setSubtitleUrl((prev) => {
					if (prev) {
						URL.revokeObjectURL(prev);
					}
					return null;
				});
				return;
			}

			if (data.transcriptionStatus === "COMPLETE" && vttContent) {
				const blob = new Blob([toStandardWebVtt(vttContent)], {
					type: "text/vtt",
				});
				const newUrl = URL.createObjectURL(blob);
				setSubtitleUrl((prev) => {
					if (prev) {
						URL.revokeObjectURL(prev);
					}
					return newUrl;
				});

				return () => {
					URL.revokeObjectURL(newUrl);
				};
			}
			setSubtitleUrl((prev) => {
				if (prev) {
					URL.revokeObjectURL(prev);
				}
				return null;
			});
		}, [
			data.transcriptionStatus,
			captionContext.currentVttContent,
			captionContext.selectedLanguage,
		]);

		useEffect(() => {
			if (chapters?.length > 0) {
				const vttContent = formatChaptersAsVTT(safeChapters);
				const blob = new Blob([vttContent], { type: "text/vtt" });
				const newUrl = URL.createObjectURL(blob);
				setChaptersUrl((prev) => {
					if (prev) {
						URL.revokeObjectURL(prev);
					}
					return newUrl;
				});

				return () => {
					URL.revokeObjectURL(newUrl);
				};
			}
			setChaptersUrl((prev) => {
				if (prev) {
					URL.revokeObjectURL(prev);
				}
				return null;
			});
		}, [safeChapters, chapters?.length]);

		const isSegmentsSource = data.source.type === "desktopSegments";
		const previousSegmentUploadProgressRef = useRef(segmentUploadProgress);
		const isActivelyRecording =
			isSegmentsSource &&
			(data.hasActiveUpload ?? false) &&
			!userConfirmedStopped &&
			(segmentUploadProgress?.status === "fetching" ||
				segmentUploadProgress?.status === "uploading");

		const isProcessingInProgress =
			isSegmentsSource &&
			(data.hasActiveUpload ?? false) &&
			!userConfirmedStopped &&
			!isActivelyRecording &&
			shouldDeferPlaybackSource(segmentUploadProgress);
		const handleConfirmStopped = useCallback(async () => {
			if (
				!canFinalizeDesktopSegments ||
				data.source.type !== "desktopSegments" ||
				!data.hasActiveUpload
			) {
				setUserConfirmedStopped(true);
				return;
			}

			setIsConfirmingStopped(true);
			setConfirmStoppedError(null);

			try {
				await finalizeDesktopSegmentsRecording({ videoId: data.id });
				setUserConfirmedStopped(true);
				router.refresh();
			} catch (error) {
				setConfirmStoppedError(
					error instanceof Error ? error.message : t("recordingFinalizeFailed"),
				);
			} finally {
				setIsConfirmingStopped(false);
			}
		}, [
			canFinalizeDesktopSegments,
			data.hasActiveUpload,
			data.id,
			data.source.type,
			router,
		]);
		const shouldAutoFinalizeFailedSegments =
			isSegmentsSource &&
			(data.hasActiveUpload ?? false) &&
			canFinalizeDesktopSegments &&
			!userConfirmedStopped &&
			segmentUploadProgress?.status === "error" &&
			isRetryableDesktopSegmentsFinalizationError(
				segmentUploadProgress.errorMessage,
			);
		useEffect(() => {
			if (
				!shouldAutoFinalizeFailedSegments ||
				autoFinalizeAttemptedRef.current ||
				isConfirmingStopped
			) {
				return;
			}

			autoFinalizeAttemptedRef.current = true;
			void handleConfirmStopped();
		}, [
			handleConfirmStopped,
			isConfirmingStopped,
			shouldAutoFinalizeFailedSegments,
		]);
		const showFinalizeRecordingControl =
			isSegmentsSource &&
			(data.hasActiveUpload ?? false) &&
			canFinalizeDesktopSegments &&
			!userConfirmedStopped &&
			segmentUploadProgress?.status === "failed";
		useEffect(() => {
			if (!isSegmentsSource || !data.hasActiveUpload || !userConfirmedStopped) {
				previousSegmentUploadProgressRef.current = segmentUploadProgress;
				return;
			}

			if (
				shouldReloadPlaybackAfterUploadCompletes(
					previousSegmentUploadProgressRef.current,
					segmentUploadProgress,
					{ includeFetching: true },
				)
			) {
				router.refresh();
			}

			previousSegmentUploadProgressRef.current = segmentUploadProgress;
		}, [
			data.hasActiveUpload,
			isSegmentsSource,
			router,
			segmentUploadProgress,
			userConfirmedStopped,
		]);

		const available: ShareLanguage[] = (
			Object.keys(data.metadata?.aiSummaryByLanguage ?? {}) as ShareLanguage[]
		).filter((lang) => !!data.metadata?.aiSummaryByLanguage?.[lang]);

		// Detect from the BASE summary (not activeAiSummary) so the base label
		// never changes when the user switches to a translated language.
		const baseLanguage = useMemo(
			() =>
				data.metadata?.aiBaseLanguage ??
				detectShareLanguage(data.metadata?.aiSummary?.overview),
			[data.metadata?.aiBaseLanguage, data.metadata?.aiSummary?.overview],
		);

		// All source types use the native <video> player via the mp4 playlist endpoint.
		// The /api/playlist?videoType=mp4 route returns a signed redirect to result.mp4.
		const videoSrc = `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=mp4`;
		const rawFallbackSrc =
			data.source.type === "webMP4" || data.source.type === "extensionWeb"
				? `/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=raw-preview`
				: undefined;
		const enableCrossOrigin = true;

		const playerBlock = (
			<>
				<div
					className={`relative overflow-hidden rounded-2xl border border-gray-5 bg-gray-1 ${
						data.metadata?.isAudio
							? "h-[190px] sm:h-[210px]"
							: "aspect-video"
					}`}
					style={{ viewTransitionName: "cap-edit-video" }}
				>
					{isActivelyRecording ? (
						<div className="relative h-full overflow-hidden rounded-xl bg-black">
							<CapVideoPlayer
								videoId={data.id}
								mediaPlayerClassName="w-full h-full max-w-full max-h-full rounded-xl"
								videoSrc={videoSrc}
								duration={data.duration}
								disableCaptions
								disableCommentStamps
								disableReactionStamps
								disablePreviewGif
								chaptersSrc=""
								captionsSrc=""
								videoRef={videoRef}
								enableCrossOrigin={enableCrossOrigin}
								hasActiveUpload={data.hasActiveUpload}
								autoplay
								isAudio={data.metadata?.isAudio}
								videoName={data.name}
							/>
							<div className="absolute inset-0 z-20">
								<RecordingInProgressOverlay
									onConfirmStopped={handleConfirmStopped}
									isConfirmingStopped={isConfirmingStopped}
									confirmStoppedError={confirmStoppedError}
									className="h-full"
									variant="overlay"
								/>
							</div>
						</div>
					) : isProcessingInProgress ? (
						<PreparingVideoOverlay className="h-full" />
					) : (
						<CapVideoPlayer
							videoId={data.id}
							mediaPlayerClassName="w-full h-full max-w-full max-h-full rounded-xl overflow-visible"
							videoSrc={videoSrc}
							rawFallbackSrc={rawFallbackSrc}
							duration={data.duration}
							defaultPlaybackSpeed={defaultPlaybackSpeed}
							showPlaybackStatusBadge={showPlaybackStatusBadge}
							disableCaptions={areCaptionsDisabled ?? false}
							disableCommentStamps={areCommentStampsDisabled ?? false}
							disableReactionStamps={areReactionStampsDisabled ?? false}
							chaptersSrc={areChaptersDisabled ? "" : chaptersUrl || ""}
							captionsSrc={areCaptionsDisabled ? "" : subtitleUrl || ""}
							videoRef={videoRef}
							enableCrossOrigin={enableCrossOrigin}
							hasActiveUpload={data.hasActiveUpload}
							blockPlaybackDuringProcessing={isEditProcessing}
							onUploadComplete={handleUploadComplete}
							comments={commentsData.map((comment) => ({
								id: comment.id,
								type: comment.type,
								timestamp: comment.timestamp,
								content: comment.content,
								authorName: comment.authorName,
								authorImage: comment.authorImage ?? undefined,
							}))}
							onSeek={handleSeek}
							canRetryProcessing={canRetryProcessing}
							canReplaceWithAudio={canReplaceWithAudio}
							chapters={
								areChaptersDisabled
									? []
									: safeChapters.map((ch) => ({
											startSec: ch.start,
											title: ch.title,
										}))
							}
							isAudio={data.metadata?.isAudio}
							videoName={data.name}
							transcriptLanguages={{
								baseLanguage,
								available,
								selected: selectedLanguage,
								onSelect: setSelectedLanguage,
								canGenerate,
								generatingLanguage,
								onGenerate: handleGenerateTranslation,
							}}
						/>
					)}
					{showFinalizeRecordingControl && (
						<div className="absolute bottom-3 left-3 z-30 flex max-w-[calc(100%-1.5rem)] flex-col items-start gap-1.5">
							<div className="flex items-center gap-1.5">
								<button
									type="button"
									onClick={handleConfirmStopped}
									disabled={isConfirmingStopped}
									className="inline-flex h-7 items-center gap-1.5 rounded-md border border-white/15 bg-black/65 px-2.5 text-[11px] font-medium text-white shadow-sm backdrop-blur-sm transition-colors hover:bg-black/80 disabled:cursor-not-allowed disabled:opacity-70"
								>
									{isConfirmingStopped ? (
										<Loader2Icon className="size-3 animate-spin" />
									) : (
										<CheckCircle2 className="size-3" />
									)}
									{isConfirmingStopped
										? t("markingAsCompleted")
										: t("markAsCompleted")}
								</button>
								<TooltipPrimitive.Provider delayDuration={150}>
									<Tooltip
										position="top"
										className="max-w-[260px] items-start text-left leading-relaxed"
										content={t("markCompletedTooltip")}
									>
										<button
											type="button"
											aria-label={t("markCompletedAriaLabel")}
											className="inline-flex size-7 items-center justify-center rounded-md border border-white/15 bg-black/65 text-white/80 shadow-sm backdrop-blur-sm transition-colors hover:bg-black/80 hover:text-white"
										>
											<Info className="size-3.5" />
										</button>
									</Tooltip>
								</TooltipPrimitive.Provider>
							</div>
							{confirmStoppedError && (
								<p className="max-w-56 rounded-md bg-black/70 px-2 py-1 text-[11px] text-red-100">
									{confirmStoppedError}
								</p>
							)}
						</div>
					)}
					{!data.owner.isPro && (
						<div className="absolute top-4 left-4 z-30">
							<button
								type="button"
								className="block"
								onClick={(e) => {
									e.stopPropagation();
									setUpgradeModalOpen(true);
								}}
							>
								<div className="relative">
									<div className="opacity-50 transition-opacity hover:opacity-100 peer">
										<Logo className="w-auto h-4 sm:h-8" white={true} />
									</div>

									<div className="absolute left-0 top-8 transition-transform duration-300 ease-in-out origin-top scale-y-0 peer-hover:scale-y-100">
										<p className="text-white text-xs font-medium whitespace-nowrap bg-black bg-opacity-50 px-2 py-0.5 rounded">
											{t("removeWatermark")}
										</p>
									</div>
								</div>
							</button>
						</div>
					)}
				</div>

				<UpgradeModal
					open={upgradeModalOpen}
					onOpenChange={setUpgradeModalOpen}
				/>
			</>
		);

		const activeAiSummary =
			selectedLanguage !== "base"
				? (data.metadata?.aiSummaryByLanguage?.[selectedLanguage] ??
					data.metadata?.aiSummary)
				: data.metadata?.aiSummary;

		// Stable identity for the tasks array so TasksPanel's `initialTasks`
		// re-sync effect does NOT fire on every parent re-render (currentTime
		// updates many times/sec during playback) and clobber an in-flight
		// optimistic checkbox toggle. Only changes when the summary actually changes.
		const activeTasks = useMemo(
			() => activeAiSummary?.tasks ?? [],
			[activeAiSummary],
		);

		const hasCleanTranscript =
			(activeAiSummary?.refinedTranscript?.chapters?.length ?? 0) > 0;

		// Chapter group headers in the raw-transcript tab: use the TRANSLATED
		// chapter titles when a non-base language is selected (so the headers match
		// the translated cue text + the rest of the analysis), else the base ones.
		const transcriptChapters = useMemo(
			() =>
				selectedLanguage !== "base" &&
				(activeAiSummary?.chapters?.length ?? 0) > 0
					? (activeAiSummary?.chapters ?? []).map((c) => ({
							startSec: clampStartSec(c.startSec, data.duration ?? undefined),
							title: c.title,
						}))
					: safeChapters.map((c) => ({ startSec: c.start, title: c.title })),
			[selectedLanguage, activeAiSummary, safeChapters, data.duration],
		);

		return (
			<>
				<div className="flex flex-col gap-4 lg:grid lg:grid-cols-[1.55fr_1fr] lg:items-start lg:gap-6">
					{/* All widths: video on top, AI panel right below it — one normal
					    full-page scroll (owner spec 2026-07-14, restores the
					    pre-3c3d78a arrangement). Desktop's right sidebar holds only
					    the light cost + comments cards. */}
					<div className="flex min-w-0 flex-col gap-3">
						<div className="min-w-0">
							<DockableVideo isAudio={data.metadata?.isAudio} title={data.name}>
								{playerBlock}
							</DockableVideo>
						</div>
						<div className="min-w-0">
							<SharePanel
								videoId={data.id}
								onVideoJump={handleSeekAndPlay}
								processing={aiProcessing}
								transcriptReady={transcriptReady}
								aiContentReady={aiContentReady}
								chatVariant={chatVariant}
								summary={
									<>
										<GenerateAiPanel
											videoId={data.id}
											canGenerate={canGenerate}
											transcriptionStatus={
												data.transcriptionStatus as
													| "PROCESSING"
													| "COMPLETE"
													| "ERROR"
													| "SKIPPED"
													| "NO_AUDIO"
													| null
													| undefined
											}
											aiGenerationStatus={effectiveAiStatus}
											aiProcessingStep={effectiveAiProcessingStep}
											aiMode={effectiveAiMode}
											aiQuotaWaiting={effectiveAiQuotaWaiting}
											aiIncomplete={aiIncomplete}
											duration={data.duration}
											transcriptionChunksCompleted={
												transcript?.progress?.completed ??
												aiStatusQuery.data?.transcriptionChunksCompleted ??
												data.metadata?.transcriptionChunksCompleted
											}
											transcriptionChunksTotal={
												transcript?.progress?.total ??
												aiStatusQuery.data?.transcriptionChunksTotal ??
												data.metadata?.transcriptionChunksTotal
											}
											aiStageChunksCompleted={
												aiStatusQuery.data?.aiStageChunksCompleted ??
												data.metadata?.aiStageChunksCompleted
											}
											aiStageChunksTotal={
												aiStatusQuery.data?.aiStageChunksTotal ??
												data.metadata?.aiStageChunksTotal
											}
											processingStartedAt={data.metadata?.processingStartedAt}
											aiProcessingStartedAt={
												data.metadata?.aiProcessingStartedAt
											}
											onStarted={handleAiStarted}
										/>
										{!aiProcessing && (
											<SummaryPanel
												data={{
													duration: data.duration ?? undefined,
													aiSummary: activeAiSummary ?? undefined,
													speakerCount: undefined,
												}}
												onVideoJump={handleSeekAndPlay}
											/>
										)}
									</>
								}
								tasks={
									<div>
										<p className="mb-2 text-[12px] font-semibold uppercase tracking-wide text-gray-10">
											{t("tabTasks")} · {activeTasks.length}
										</p>
										<TasksPanel
											videoId={data.id}
											tasks={activeTasks}
											canEdit={canGenerate}
										/>
									</div>
								}
								transcript={
									<>
										{transcript?.partial &&
											(transcript.progress?.total ?? 0) > 0 && (
												<div className="mb-2 inline-flex items-center rounded-full border border-amber-6 bg-amber-3 px-3 py-1 text-xs font-medium text-amber-11">
													{t("transcribingProgress", {
														completed: transcript.progress?.completed ?? 0,
														total: transcript.progress?.total ?? 0,
													})}
												</div>
											)}
										{(
											selectedLanguage === "base"
												? transcript?.content
												: activeTranscriptVtt
										) ? (
											<TranscriptPanel
												transcriptContent={
													(selectedLanguage === "base"
														? transcript?.content
														: activeTranscriptVtt) ?? undefined
												}
												currentTime={currentTime}
												onVideoJump={handleSeekAndPlay}
												duration={data.duration}
												chapters={transcriptChapters}
											/>
										) : hasCleanTranscript ? (
											<div className="rounded-xl border border-blue-6 bg-blue-3 px-4 py-5">
												<p className="text-sm font-semibold text-gray-12">
													{t("rawTranscriptUnavailable")}
												</p>
												<p className="mt-1 text-sm leading-relaxed text-gray-11">
													{t("cleanTranscriptReady")}
												</p>
											</div>
										) : (
											<TranscriptPanel
												transcriptContent={undefined}
												currentTime={currentTime}
												onVideoJump={handleSeekAndPlay}
												duration={data.duration}
												chapters={transcriptChapters}
											/>
										)}
									</>
								}
								refined={
									<RefinedTranscriptPanel
										refinedTranscript={
											activeAiSummary?.refinedTranscript ?? undefined
										}
										onVideoJump={handleSeekAndPlay}
										duration={data.duration}
										currentTime={currentTime}
									/>
								}
							/>
						</div>
					</div>

					<div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-4 lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto">
						{costPanel}
						{commentsPanel}
					</div>
				</div>
				{/* T9 prototype: ?variant=modal — restored blue-FAB → dialog chat,
			    hidden by default in favor of the current inline chat above. */}
				{chatVariant === "modal" && (
					<>
						<div className={`ai-aura${aiChatOpen ? " show" : ""}`} />
						<AIChatPopup
							videoId={data.id}
							onVideoJump={handleSeekAndPlay}
							onClose={() => setAiChatOpen(false)}
							isOpen={aiChatOpen}
							processing={aiProcessing}
							transcriptReady={transcriptReady}
						/>
						<AIFab
							onClick={() => setAiChatOpen((v) => !v)}
							isOpen={aiChatOpen}
						/>
					</>
				)}
			</>
		);
	},
);
