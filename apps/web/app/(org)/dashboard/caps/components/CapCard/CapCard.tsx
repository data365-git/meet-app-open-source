"use client";

import type { videos as videosSchema } from "@cap/database/schema";
import type { VideoMetadata } from "@cap/database/types";
import { buildEnv, NODE_ENV } from "@cap/env";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@cap/ui";
import { calculateStrokeDashoffset, getProgressCircleConfig } from "@cap/utils";
import type { SpaceRuleSource, ViewerSettingKey } from "@cap/web-backend";
import type { ImageUpload, Video } from "@cap/web-domain";
import { HttpClient } from "@effect/platform";
import {
  faChartSimple,
  faCheck,
  faCopy,
  faDownload,
  faEllipsis,
  faGear,
  faLink,
  faLock,
  faScissors,
  faShare,
  faTrash,
  faUnlock,
  faVideo,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import clsx from "clsx";
import { Effect, Option } from "effect";
import { AudioLines, Music, TimerReset } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { type PropsWithChildren, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useAiStatus } from "hooks/use-ai-status";
import { refineVideoTimestamps } from "@/actions/video/refine-timestamps";
import { replaceVideoWithAudio } from "@/actions/video/replace-with-audio";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { useUploadProgress } from "@/app/s/[videoId]/_components/ProgressCircle";
import {
  type ImageLoadingStatus,
  VideoThumbnail,
} from "@/components/VideoThumbnail";
import {
  pollAuthoritativeValue,
  shouldActivateProcessingPoll,
} from "@/lib/ai-request-pending";
import { downloadFilename } from "@/lib/download-filename";
import { useEffectMutation, useRpcClient } from "@/lib/EffectRuntime";
import { type LibraryKind, libraryDragType } from "@/lib/library-kind";
import { ThumbnailRequest } from "@/lib/Requests/ThumbnailRequest";
import { usePublicEnv } from "@/utils/public-env";

import { PasswordDialog } from "../PasswordDialog";
import { SettingsDialog } from "../SettingsDialog";
import { SharingDialog } from "../SharingDialog";
import { CapCardContent } from "./CapCardContent";

const { circumference } = getProgressCircleConfig();

// A background timestamp-refinement stuck in PROCESSING past this age is treated
// as crashed → the card unsticks and the owner can retry (no polling/job system).
const REFINE_STALE_MS = 30 * 60 * 1000;

function getProgressStatusText(
  status: "uploading" | "processing" | "generating_thumbnail",
) {
  switch (status) {
    case "processing":
      return "Processing";
    case "generating_thumbnail":
      return "Finishing up";
    default:
      return "Uploading";
  }
}

export interface CapCardProps extends PropsWithChildren {
  cap: {
    id: Video.VideoId;
    ownerId: string;
    name: string;
    createdAt: Date;
    public?: boolean;
    totalComments: number;
    totalReactions: number;
    sharedOrganizations?: {
      id: string;
      name: string;
      iconUrl?: ImageUpload.ImageUrl | null;
    }[];
    sharedSpaces?: {
      id: string;
      name: string;
      iconUrl?: ImageUpload.ImageUrl | null;
      organizationId: string;
      isOrg?: boolean;
      settings?: Partial<Record<ViewerSettingKey, boolean>> | null;
      hasPassword?: boolean;
    }[];
    ownerName: string | null;
    metadata?: VideoMetadata;
    source?: typeof videosSchema.$inferSelect.source;
    isScreenshot?: boolean;
    hasPassword?: boolean;
    hasInheritedPassword?: boolean;
    inheritedPasswordSources?: SpaceRuleSource[];
    inheritedSpaceSettings?: Partial<
      Record<ViewerSettingKey, SpaceRuleSource[]>
    >;
    hasActiveUpload: boolean | undefined;
    duration?: number;
    settings?: {
      disableComments?: boolean;
      disableSummary?: boolean;
      disableCaptions?: boolean;
      disableChapters?: boolean;
      disableReactions?: boolean;
      disableTranscript?: boolean;
    } | null;
  };
  analytics: number;
  isLoadingAnalytics: boolean;
  onDelete?: () => void;
  userId?: string;
  sharedCapCard?: boolean;
  isSelected?: boolean;
  onSelectToggle?: () => void;
  hideSharedStatus?: boolean;
  anyCapSelected?: boolean;
  /**
   * The ids currently multi-selected on the page this card lives on. When this
   * card is part of that selection, dragging it drags the WHOLE selection —
   * so drag moves exactly what the Move menu already moves. Pass it from every
   * library grid (Recordings, Meetings, folder view).
   */
  draggableSelection?: Video.VideoId[];
  /**
   * Which library this card is being dragged FROM. Travels with the drag as its
   * own MIME type so a drop target can tell, while the drag is still in the air,
   * that dropping here would be a no-op (a recording dropped on Recordings) and
   * therefore must not light up. Omit it where the source library is unknown —
   * every target then accepts, which is the safe default.
   */
  libraryKind?: LibraryKind;
  isDeleting?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
}

export const CapCard = ({
  cap,
  analytics,
  children,
  onDelete,
  userId,
  sharedCapCard = false,
  hideSharedStatus = false,
  isSelected = false,
  onSelectToggle,
  anyCapSelected = false,
  draggableSelection,
  libraryKind,
  isDeleting = false,
}: CapCardProps) => {
  const t = useTranslations("library");
  // replaceWithAudio* keys live in the "share" namespace (CapVideoPlayer),
  // reused here rather than duplicated.
  const tShare = useTranslations("share");
  const { activeOrganization } = useDashboardContext();
  const customDomain = activeOrganization?.organization.customDomain;
  const domainVerified = activeOrganization?.organization.domainVerified;

  const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
  const [isPasswordDialogOpen, setIsPasswordDialogOpen] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [passwordProtected, setPasswordProtected] = useState(
    cap.hasPassword || false,
  );
  const effectivePasswordProtected =
    passwordProtected || Boolean(cap.hasInheritedPassword);
  const { webUrl } = usePublicEnv();

  const [copyPressed, setCopyPressed] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const { user, setUpgradeModalOpen } = useDashboardContext();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [confirmReplaceWithAudioOpen, setConfirmReplaceWithAudioOpen] =
    useState(false);
  const [isReplacingWithAudio, setIsReplacingWithAudio] = useState(false);
  const [isDownloadingAudio, setIsDownloadingAudio] = useState(false);
  const [confirmTimestampRefinementOpen, setConfirmTimestampRefinementOpen] =
    useState(false);
  // A PROCESSING refinement older than this is treated as stale (a crashed
  // background run) so the owner can retry instead of being stuck forever
  // (Codex 2026-07-15 correctness boundary — smallest recovery, no job system).
  const refinement = cap.metadata?.timestampRefinement;
  const refinementActive =
    refinement?.status === "PROCESSING" &&
    (!refinement.requestedAt ||
      Date.now() - new Date(refinement.requestedAt).getTime() <
        REFINE_STALE_MS);
  const [isRefiningTimestamps, setIsRefiningTimestamps] =
    useState(refinementActive);
  // Sync the local pending flag with the server-refreshed status so a card that
  // finishes (COMPLETE) or fails (ERROR) in the background unsticks on the next
  // refresh instead of staying visually stuck until a full reload. COMPLETE/ERROR
  // and stale-PROCESSING all clear it → the menu item re-enables (ERROR retryable).
  useEffect(() => {
    setIsRefiningTimestamps(refinementActive);
  }, [refinementActive]);

  const [isFreshlyUploaded, setIsFreshlyUploaded] = useState(() => {
    if (!cap.createdAt) return false;
    const ageMs = Date.now() - new Date(cap.createdAt).getTime();
    return ageMs < 30_000;
  });

  useEffect(() => {
    if (!isFreshlyUploaded || !cap.createdAt) return;
    const ageMs = Date.now() - new Date(cap.createdAt).getTime();
    const remaining = 30_000 - ageMs;
    if (remaining <= 0) {
      setIsFreshlyUploaded(false);
      return;
    }
    const t = setTimeout(() => setIsFreshlyUploaded(false), remaining);
    return () => clearTimeout(t);
  }, [cap.createdAt, isFreshlyUploaded]);

  const router = useRouter();
  const rpc = useRpcClient();

  const downloadMutation = useEffectMutation({
    mutationFn: () =>
      Effect.gen(function* () {
        const result = yield* rpc.VideoGetDownloadInfo(cap.id);
        const httpClient = yield* HttpClient.HttpClient;
        if (Option.isSome(result)) {
          const fetchResponse = yield* httpClient.get(result.value.downloadUrl);
          const blob = yield* fetchResponse.arrayBuffer;

          const blobUrl = window.URL.createObjectURL(new Blob([blob]));
          const link = document.createElement("a");
          link.href = blobUrl;
          link.download = result.value.fileName;
          link.style.display = "none";
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);

          window.URL.revokeObjectURL(blobUrl);
        } else {
          throw new Error("Failed to get download URL");
        }
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      await onDelete?.();
    },
    onError: (error) => {
      console.error("Error deleting cap:", error);
    },
    onSuccess: () => {
      router.refresh();
    },
    onSettled: () => {
      setConfirmOpen(false);
    },
  });

  const duplicateMutation = useEffectMutation({
    mutationFn: () => rpc.VideoDuplicate(cap.id),
    onSuccess: () => {
      router.refresh();
    },
  });

  const handleSharingUpdated = () => {
    router.refresh();
  };

  const handlePasswordUpdated = (protectedStatus: boolean) => {
    setPasswordProtected(protectedStatus);
    router.refresh();
  };

  const isOwner = userId === cap.ownerId;

  const queryClient = useQueryClient();
  const uploadProgress = useUploadProgress(
    cap.id,
    cap.hasActiveUpload || false,
  );

  // Granular AI status (Wave 2.1): a glance-clear "stage + Bo'lak N/M" line
  // while AI is running, so the owner doesn't have to open the video to see
  // whether it's stuck. `cap.metadata.aiGenerationStatus` is already known
  // synchronously from the server-rendered grid data, so polling is enabled
  // ONLY for cards with an active run — a grid of dozens of caps never opens
  // more than a handful of pollers at once (one per currently-processing
  // video), and each polls at a gentler 6s (vs the single-video share page's
  // 4s) to keep the fan-out cost sensible.
  const aiRunning =
    cap.metadata?.aiGenerationStatus === "PROCESSING" ||
    cap.metadata?.aiGenerationStatus === "QUEUED";
  // The silent pre-AI optimize/save stage (2026-08-18 wave 2, Change B):
  // `videoUploads` is already deleted by the time this runs, so
  // `metadata.processingStage` is the only signal. Seeded from the
  // server-rendered prop (mirrors the `aiRunning` gate above — no poller
  // opens on a card that was never processing) and turned back off by the
  // effect below the moment a poll response reports the stage cleared, so an
  // idle card never keeps polling forever just because it once processed.
  const [processingActive, setProcessingActive] = useState(
    !!cap.metadata?.processingStage,
  );
  const aiStatus = useAiStatus(cap.id, aiRunning || processingActive, 6000);

  useEffect(() => {
    if (!processingActive || !aiStatus.data) return;
    if (aiStatus.data.processingStage == null) setProcessingActive(false);
  }, [processingActive, aiStatus.data]);
  // FINDING 4: the mount-time seed above only covers a card that was already
  // processing on first paint. On an already-open dashboard tab, a LATER
  // prop refresh (e.g. `router.refresh()` elsewhere on the grid) can bring
  // in a fresh `cap.metadata.processingStage` for a card that started
  // processing after mount — without this, that card never turns its
  // poller on and the indicator never starts.
  useEffect(() => {
    if (shouldActivateProcessingPoll(processingActive, cap.metadata?.processingStage)) {
      setProcessingActive(true);
    }
  }, [processingActive, cap.metadata?.processingStage]);
  const aiStep =
    aiStatus.data?.aiProcessingStep ??
    cap.metadata?.aiProcessingStep ??
    "transcribe";
  const aiStageLabel =
    aiStep === "transcribe"
      ? tShare("aiFocalTranscribe")
      : aiStep === "refined"
        ? tShare("aiFocalRefined")
        : aiStep === "done"
          ? tShare("stepDone")
          : tShare("aiFocalSummary");
  const aiChunkCompleted =
    aiStep === "transcribe"
      ? (aiStatus.data?.transcriptionChunksCompleted ??
        cap.metadata?.transcriptionChunksCompleted)
      : (aiStatus.data?.aiStageChunksCompleted ??
        cap.metadata?.aiStageChunksCompleted);
  const aiChunkTotal =
    aiStep === "transcribe"
      ? (aiStatus.data?.transcriptionChunksTotal ??
        cap.metadata?.transcriptionChunksTotal)
      : (aiStatus.data?.aiStageChunksTotal ?? cap.metadata?.aiStageChunksTotal);
  const aiLineText =
    aiChunkTotal && aiChunkTotal > 0
      ? `${aiStageLabel} · ${tShare("aiCardChunkProgress", {
          completed: aiChunkCompleted ?? 0,
          total: aiChunkTotal,
        })}`
      : `${aiStageLabel}…`;
  // FINDING 1: once the poll has ANY data, it is authoritative — a poll
  // that authoritatively reports `null` must clear the overlay, not fall
  // through to the stale server-rendered prop via `??`.
  const processingStage = pollAuthoritativeValue(
    !!aiStatus.data,
    aiStatus.data?.processingStage ?? null,
    cap.metadata?.processingStage ?? null,
  );
  const processingPercent = pollAuthoritativeValue(
    !!aiStatus.data,
    aiStatus.data?.processingPercent ?? null,
    cap.metadata?.processingPercent ?? null,
  );
  const processingStageLabel =
    processingStage === "saving"
      ? tShare("processingStageSaving")
      : tShare("processingStageOptimizing");
  const processingLineText =
    processingPercent != null
      ? `${processingStageLabel} · ${processingPercent}%`
      : `${processingStageLabel}…`;
  const hasRawFallback =
    uploadProgress?.status === "error" && uploadProgress.hasRawFallback;
  const hasVisibleUploadProgress =
    uploadProgress !== null &&
    uploadProgress.status !== "fetching" &&
    !hasRawFallback;
  const [imageStatus, setImageStatus] = useState<ImageLoadingStatus>("loading");
  const prevUploadProgressRef = useRef(uploadProgress);

  useEffect(() => {
    const prev = prevUploadProgressRef.current;
    const wasActive =
      prev !== null &&
      prev.status !== "fetching" &&
      prev.status !== "failed" &&
      prev.status !== "error";
    const isNowComplete = uploadProgress === null;

    if (wasActive && isNowComplete) {
      queryClient.invalidateQueries({
        queryKey: ThumbnailRequest.queryKey(cap.id),
      });
      setImageStatus("loading");
    }

    prevUploadProgressRef.current = uploadProgress;
  }, [uploadProgress, queryClient, cap.id]);

  // Helper function to create a drag preview element
  const createDragPreview = (text: string): HTMLElement => {
    // Create the element
    const element = document.createElement("div");

    // Add text content
    element.textContent = text;

    // Apply Tailwind-like styles directly
    element.className =
      "px-2 py-1.5 text-sm font-medium rounded-lg shadow-md text-gray-1 bg-gray-12";

    // Position off-screen
    element.style.position = "absolute";
    element.style.top = "-9999px";
    element.style.left = "-9999px";

    return element;
  };

  // A card is draggable when the viewer owns it and either nothing is selected
  // (drag just that card) or this card IS part of the selection (drag them all).
  // An unselected card while a selection is active stays undraggable — its whole
  // surface is the "add to selection" click target.
  const isDraggable = isOwner && (!anyCapSelected || isSelected);

  // The ids this card drags: the whole multi-selection when it belongs to one,
  // otherwise just itself. `id`/`name` stay on the payload so the drop targets
  // that already read them (Folder, breadcrumb, My Caps, spaces) keep working.
  const dragIds: Video.VideoId[] =
    isSelected && draggableSelection && draggableSelection.length > 0
      ? draggableSelection.includes(cap.id)
        ? draggableSelection
        : [cap.id, ...draggableSelection]
      : [cap.id];

  const handleDragStart = (e: React.DragEvent<HTMLElement>) => {
    if (!isDraggable) {
      e.preventDefault();
      return;
    }

    // Set the data transfer
    e.dataTransfer.setData(
      "application/cap",
      JSON.stringify({
        id: cap.id,
        name: cap.name,
        ids: dragIds,
        count: dragIds.length,
      }),
    );

    // The source library rides along as its own MIME type — `types` is the only
    // thing a drop target can read during `dragover`, so this is what lets a
    // target refuse (and stay unhighlighted) before the user lets go.
    if (libraryKind) {
      e.dataTransfer.setData(libraryDragType(libraryKind), libraryKind);
    }

    // Set drag effect to 'move' to avoid showing the + icon
    e.dataTransfer.effectAllowed = "move";

    // Set the drag image using the helper function
    try {
      const dragPreview = createDragPreview(
        // Mirrors SelectedCapsBar's count label so the drag preview reads the
        // same way as the selection bar the owner already sees.
        dragIds.length > 1
          ? `${dragIds.length} cap${dragIds.length === 1 ? "" : "s"}`
          : cap.name,
      );
      document.body.appendChild(dragPreview);
      e.dataTransfer.setDragImage(dragPreview, 10, 10);

      // Clean up after a short delay
      setTimeout(() => document.body.removeChild(dragPreview), 100);
    } catch (error) {
      console.error("Error setting drag image:", error);
    }

    setIsDragging(true);
  };

  const handleDragEnd = () => {
    setIsDragging(false);
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopyPressed(true);
    setTimeout(() => {
      setCopyPressed(false);
    }, 2000);
  };

  const handleDownload = async () => {
    if (downloadMutation.isPending) return;

    toast.promise(downloadMutation.mutateAsync(), {
      loading: t("downloadPreparing"),
      success: t("downloadStarted"),
      error: (error) => {
        if (error instanceof Error) {
          return error.message;
        }
        return t("downloadFailed");
      },
    });
  };

  // Audio-only download from the dashboard card. Same read-only route the share
  // page uses — the video is never touched. Deliberately NOT the neighbouring
  // "replace with audio", which destroys the video permanently; the two sit in
  // the same menu, so they must never share a handler or a wording.
  const handleDownloadAudio = async () => {
    if (isDownloadingAudio) return;
    setIsDownloadingAudio(true);
    // Extraction can take a while on a long meeting, so a toast carries the wait
    // instead of the menu looking frozen.
    const waiting = toast.loading(t("downloadPreparing"));
    try {
      const res = await fetch(`/api/videos/${cap.id}/audio`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = downloadFilename(cap.name, "mp3");
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
      toast.success(t("downloadStarted"), { id: waiting });
    } catch {
      toast.error(t("downloadAudioFailed"), { id: waiting });
    } finally {
      setIsDownloadingAudio(false);
    }
  };

  const handleSelectClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (onSelectToggle) {
      onSelectToggle();
    }
  };

  const copyLinkHandler = () => {
    handleCopy(
      NODE_ENV === "development"
        ? `${webUrl}/s/${cap.id}`
        : buildEnv.NEXT_PUBLIC_IS_CAP && customDomain && domainVerified
          ? `https://${customDomain}/s/${cap.id}`
          : buildEnv.NEXT_PUBLIC_IS_CAP && !customDomain && !domainVerified
            ? `https://cap.link/${cap.id}`
            : `${webUrl}/s/${cap.id}`,
    );
  };
  const canEditVideo =
    isOwner &&
    !sharedCapCard &&
    cap.isScreenshot !== true &&
    !cap.hasActiveUpload &&
    Boolean(cap.duration && cap.duration > 0);
  const handleEditVideo = () => {
    if (!canEditVideo) return;
    router.push(`/s/${cap.id}/edit`);
  };

  // Mirrors CapVideoPlayer's former handleReplaceWithAudio (T4b), moved here
  // into the dashboard card's ⋮ menu.
  const handleReplaceWithAudio = async () => {
    if (isReplacingWithAudio) return;

    setIsReplacingWithAudio(true);
    try {
      const result = await replaceVideoWithAudio(cap.id);
      if (result.ok) {
        toast.success(tShare("replaceWithAudioSuccess"));
        router.refresh();
        return;
      }
      if (result.reason === "already_audio") {
        router.refresh();
        return;
      }
      toast.error(
        result.reason === "unsupported_source"
          ? tShare("replaceWithAudioErrorUnsupported")
          : tShare("replaceWithAudioError"),
      );
    } catch (error) {
      console.error("Failed to replace video with audio", error);
      toast.error(tShare("replaceWithAudioError"));
    } finally {
      setIsReplacingWithAudio(false);
      setConfirmReplaceWithAudioOpen(false);
    }
  };

  const handleTimestampRefinement = async () => {
    if (isRefiningTimestamps) return;

    setIsRefiningTimestamps(true);
    try {
      const result = await refineVideoTimestamps(cap.id);
      if (result.ok) {
        toast.success(t("timestampRefineStarted"));
        setConfirmTimestampRefinementOpen(false);
        router.refresh();
        return;
      }

      setIsRefiningTimestamps(false);
      if (result.reason === "missing_key") {
        toast.error(t("timestampRefineUnavailable"));
      } else if (result.reason === "missing_transcript") {
        toast.error(t("timestampRefineNeedsTranscript"));
      } else if (result.reason === "already_processing") {
        toast.info(t("timestampRefineAlreadyProcessing"));
      } else if (result.reason === "budget_exceeded") {
        toast.error(t("timestampRefineBudgetExceeded"));
      } else {
        toast.error(t("timestampRefineError"));
      }
    } catch (error) {
      console.error("Failed to start timestamp refinement", error);
      setIsRefiningTimestamps(false);
      toast.error(t("timestampRefineError"));
    }
  };

  return (
    <>
      <SharingDialog
        isOpen={isSharingDialogOpen}
        onClose={() => setIsSharingDialogOpen(false)}
        capId={cap.id}
        capName={cap.name}
        sharedSpaces={cap.sharedSpaces || []}
        onSharingUpdated={handleSharingUpdated}
        isPublic={cap.public}
        hasPassword={passwordProtected}
        inheritedPasswordSources={cap.inheritedPasswordSources}
        onPasswordUpdated={handlePasswordUpdated}
      />
      <SettingsDialog
        isOpen={isSettingsDialogOpen}
        settingsData={cap.settings ?? undefined}
        inheritedSpaceSettings={cap.inheritedSpaceSettings}
        capId={cap.id}
        onClose={() => setIsSettingsDialogOpen(false)}
      />
      <PasswordDialog
        isOpen={isPasswordDialogOpen}
        onClose={() => setIsPasswordDialogOpen(false)}
        videoId={cap.id}
        hasPassword={passwordProtected}
        onPasswordUpdated={handlePasswordUpdated}
      />
      <fieldset
        aria-label={cap.name}
        draggable={isDraggable}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        className={clsx(
          "flex relative overflow-hidden transition-colors duration-200 flex-col w-full h-full rounded-xl cursor-default bg-gray-1 border border-gray-4 group z-10",
          isSelected
            ? "!border-[var(--brand)]"
            : anyCapSelected
              ? "border-[var(--brand)] hover:border-[var(--brand)]"
              : "hover:border-gray-6",
          isDragging && "opacity-50",
          isDraggable && "cursor-grab active:cursor-grabbing",
        )}
      >
        {anyCapSelected && !sharedCapCard && (
          <button
            type="button"
            aria-label={`Select ${cap.name}`}
            className="absolute inset-0 z-10"
            onClick={handleSelectClick}
          />
        )}

        <div
          className={clsx(
            "absolute top-2 right-2 z-[51] transition-opacity duration-200",
            anyCapSelected ? "opacity-0 pointer-events-none" : "opacity-100",
          )}
        >
          <DropdownMenu modal={false} onOpenChange={setIsDropdownOpen}>
            <DropdownMenuTrigger asChild suppressHydrationWarning>
              <button
                type="button"
                aria-label={t("moreOptions")}
                // 44x44 hit target, but the VISIBLE part is the small disc
                // below. It used to be `text-gray-12` with only a drop-shadow:
                // that colour follows the THEME, while the thing behind it is a
                // THUMBNAIL, whose brightness has nothing to do with the theme —
                // so in light mode a near-black ellipsis sat on a dark screen
                // recording and vanished (owner, 2026-08-05). A fixed white
                // glyph on a fixed dark disc is legible over any thumbnail in
                // either theme, and stays circular + small so the open/focus
                // state still cannot read as a selected-checkbox surface
                // (the Codex 2026-07-15 constraint that shaped the original).
                className="flex size-11 items-center justify-center rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand)]"
                onClick={(e) => e.stopPropagation()}
              >
                <span className="flex size-7 items-center justify-center rounded-full bg-black/45 text-white backdrop-blur-[2px] transition-colors group-hover:bg-black/65">
                  <FontAwesomeIcon icon={faEllipsis} className="size-3.5" />
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              sideOffset={5}
              suppressHydrationWarning
            >
              {isOwner && (
                <>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsSettingsDialogOpen(true);
                    }}
                    className="flex gap-2 items-center rounded-lg"
                  >
                    <FontAwesomeIcon className="size-3" icon={faGear} />
                    <p className="text-sm text-gray-12">{t("settings")}</p>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      router.push(`/dashboard/analytics?capId=${cap.id}`);
                    }}
                    className="flex gap-2 items-center rounded-lg"
                  >
                    <FontAwesomeIcon className="size-3" icon={faChartSimple} />
                    <p className="text-sm text-gray-12">{t("analytics")}</p>
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setIsSharingDialogOpen(true);
                    }}
                    className="flex gap-2 items-center rounded-lg"
                  >
                    <FontAwesomeIcon className="size-3" icon={faShare} />
                    <p className="text-sm text-gray-12">{t("share")}</p>
                  </DropdownMenuItem>
                </>
              )}
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownload();
                }}
                className="flex gap-2 items-center rounded-lg"
              >
                <FontAwesomeIcon icon={faDownload} />
                <p className="text-sm text-gray-12">{t("download")}</p>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  handleDownloadAudio();
                }}
                disabled={isDownloadingAudio}
                className="flex gap-2 items-center rounded-lg"
              >
                <Music className="size-3" />
                <p className="text-sm text-gray-12">
                  {t("downloadAudio")}
                </p>
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={(e) => {
                  e.stopPropagation();
                  copyLinkHandler();
                  toast.success(t("linkCopied"));
                }}
                className="flex gap-2 items-center rounded-lg"
              >
                <FontAwesomeIcon className="size-3" icon={faLink} />
                <p className="text-sm text-gray-12">
                  {copyPressed ? t("copied") : t("copyLink")}
                </p>
              </DropdownMenuItem>
              {isOwner && (
                <>
                  <DropdownMenuItem
                    onClick={() => {
                      toast.promise(duplicateMutation.mutateAsync(), {
                        loading: t("duplicating"),
                        success: t("duplicateSuccess"),
                        error: t("duplicateFailed"),
                      });
                    }}
                    disabled={
                      duplicateMutation.isPending || cap.hasActiveUpload
                    }
                    className="flex gap-2 items-center rounded-lg"
                  >
                    <FontAwesomeIcon className="size-3" icon={faCopy} />
                    <p className="text-sm text-gray-12">{t("duplicate")}</p>
                  </DropdownMenuItem>
                  {canEditVideo && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        handleEditVideo();
                      }}
                      className="flex gap-2 items-center rounded-lg"
                    >
                      <FontAwesomeIcon className="size-3" icon={faScissors} />
                      <p className="text-sm text-gray-12">{t("editVideo")}</p>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={() => {
                      if (!user.isPro && buildEnv.NEXT_PUBLIC_IS_CAP)
                        setUpgradeModalOpen(true);
                      else setIsPasswordDialogOpen(true);
                    }}
                    className="flex gap-2 items-center rounded-lg"
                  >
                    <FontAwesomeIcon
                      className="size-3"
                      icon={effectivePasswordProtected ? faLock : faUnlock}
                    />
                    <p className="text-sm text-gray-12">
                      {passwordProtected ? t("editPassword") : t("addPassword")}
                    </p>
                  </DropdownMenuItem>
                  {!cap.metadata?.isAudio && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmReplaceWithAudioOpen(true);
                      }}
                      className="flex gap-2 items-center rounded-lg"
                    >
                      <AudioLines className="size-3" />
                      <p className="text-sm text-gray-12">
                        {tShare("replaceWithAudioButton")}
                      </p>
                    </DropdownMenuItem>
                  )}
                  {cap.isScreenshot !== true && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmTimestampRefinementOpen(true);
                      }}
                      disabled={isRefiningTimestamps || cap.hasActiveUpload}
                      className="flex gap-2 items-center rounded-lg"
                    >
                      <TimerReset className="size-3" />
                      <p className="text-sm text-gray-12">
                        {isRefiningTimestamps
                          ? t("timestampRefineProcessing")
                          : t("timestampRefineButton")}
                      </p>
                    </DropdownMenuItem>
                  )}
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      setConfirmOpen(true);
                    }}
                    className="flex gap-2 items-center rounded-lg"
                  >
                    <FontAwesomeIcon className="size-3" icon={faTrash} />
                    <p className="text-sm text-gray-12">
                      {t("deleteRecording")}
                    </p>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          <ConfirmationDialog
            open={confirmOpen}
            icon={<FontAwesomeIcon icon={faVideo} />}
            title="Delete recording"
            description={`Are you sure you want to delete the recording "${cap.name}"? This action cannot be undone.`}
            confirmLabel={deleteMutation.isPending ? t("deleting") : t("delete")}
            cancelLabel="Cancel"
            loading={deleteMutation.isPending}
            onConfirm={() => deleteMutation.mutate()}
            onCancel={() => setConfirmOpen(false)}
          />

          <ConfirmationDialog
            open={confirmReplaceWithAudioOpen}
            icon={<AudioLines className="size-4" />}
            title={tShare("replaceWithAudioTitle")}
            description={tShare("replaceWithAudioBody")}
            confirmLabel={
              isReplacingWithAudio
                ? tShare("replacingWithAudio")
                : tShare("replaceWithAudioConfirm")
            }
            cancelLabel={tShare("replaceWithAudioCancel")}
            confirmVariant="destructive"
            loading={isReplacingWithAudio}
            onConfirm={handleReplaceWithAudio}
            onCancel={() => setConfirmReplaceWithAudioOpen(false)}
          />

          <ConfirmationDialog
            open={confirmTimestampRefinementOpen}
            icon={<TimerReset className="size-4" />}
            title={t("timestampRefineTitle")}
            description={t("timestampRefineBody")}
            confirmLabel={
              isRefiningTimestamps
                ? t("timestampRefineProcessing")
                : t("timestampRefineConfirm")
            }
            cancelLabel={tShare("replaceWithAudioCancel")}
            loading={isRefiningTimestamps}
            onConfirm={handleTimestampRefinement}
            onCancel={() => setConfirmTimestampRefinementOpen(false)}
          />
        </div>

        {!sharedCapCard && onSelectToggle && (
          <button
            type="button"
            aria-label={isSelected ? "Deselect cap" : "Select cap"}
            className={clsx(
              "absolute top-2 left-2 z-[49] duration-200",
              isSelected || anyCapSelected || isDropdownOpen
                ? "opacity-100"
                : "group-hover:opacity-100 opacity-0",
            )}
            onClick={(e) => {
              e.stopPropagation();
              handleSelectClick(e);
            }}
          >
            <div
              className={clsx(
                "flex justify-center items-center w-6 h-6 rounded-md border transition-colors cursor-pointer hover:bg-gray-3/60",
                isSelected
                  ? "bg-[var(--brand)] border-[var(--brand)]"
                  : "border-white-95 bg-gray-1/80",
              )}
            >
              {isSelected && (
                <FontAwesomeIcon icon={faCheck} className="text-white size-3" />
              )}
            </div>
          </button>
        )}

        <div className="relative aspect-[16/10] w-full">
          <Link
            className={clsx(
              "relative block w-full h-full",
              // "block group",
              anyCapSelected && "cursor-pointer pointer-events-none",
            )}
            onClick={(e) => {
              if (isDeleting) e.preventDefault();
            }}
            href={`/s/${cap.id}`}
          >
            {hasVisibleUploadProgress && (
              <>
                <div className="absolute inset-0 z-20 transition-all duration-300 bg-black/60 rounded-t-xl" />
                <div className="flex absolute bottom-3 left-3 gap-2 items-center z-30">
                  {uploadProgress.status === "failed" ||
                  uploadProgress.status === "error" ? (
                    <span className="text-sm font-semibold text-red-400">
                      {uploadProgress.status === "error"
                        ? t("processingFailed")
                        : t("uploadFailed")}
                    </span>
                  ) : (
                    <>
                      <span className="text-sm font-semibold text-white">
                        {getProgressStatusText(
                          uploadProgress.status === "processing"
                            ? "processing"
                            : uploadProgress.status === "generating_thumbnail"
                              ? "generating_thumbnail"
                              : "uploading",
                        )}
                        {(uploadProgress.status === "uploading" ||
                          uploadProgress.status === "processing" ||
                          uploadProgress.status === "generating_thumbnail") &&
                          uploadProgress.progress > 0 &&
                          ` ${Math.round(uploadProgress.progress)}%`}
                      </span>
                      {(uploadProgress.status === "processing" ||
                        uploadProgress.status === "generating_thumbnail") &&
                      uploadProgress.progress === 0 ? (
                        <svg
                          className="w-4 h-4 animate-spin"
                          viewBox="0 0 20 20"
                          aria-hidden="true"
                        >
                          <circle
                            cx="10"
                            cy="10"
                            r="8"
                            stroke="currentColor"
                            strokeWidth="3"
                            fill="none"
                            className="text-white/30"
                          />
                          <circle
                            cx="10"
                            cy="10"
                            r="8"
                            stroke="currentColor"
                            strokeWidth="3"
                            fill="none"
                            strokeLinecap="round"
                            className="text-white"
                            strokeDasharray="12.5 37.5"
                          />
                        </svg>
                      ) : (
                        <svg
                          className="w-4 h-4 transform -rotate-90"
                          viewBox="0 0 20 20"
                          aria-hidden="true"
                        >
                          <circle
                            cx="10"
                            cy="10"
                            r="8"
                            stroke="currentColor"
                            strokeWidth="3"
                            fill="none"
                            className="text-white/30"
                          />
                          <circle
                            cx="10"
                            cy="10"
                            r="8"
                            stroke="currentColor"
                            strokeWidth="3"
                            fill="none"
                            strokeLinecap="round"
                            className="text-white transition-all duration-200 ease-out"
                            style={{
                              strokeDasharray: `${circumference} ${circumference}`,
                              strokeDashoffset: `${calculateStrokeDashoffset(
                                uploadProgress.progress,
                                circumference,
                              )}`,
                            }}
                          />
                        </svg>
                      )}
                    </>
                  )}
                </div>
              </>
            )}

            {!hasVisibleUploadProgress && processingStage && (
              <>
                <div className="absolute inset-0 z-20 transition-all duration-300 bg-black/60 rounded-t-xl" />
                <div className="flex absolute bottom-3 left-3 gap-2 items-center z-30">
                  <span className="text-sm font-semibold text-white">
                    {processingLineText}
                  </span>
                  <svg
                    className="w-4 h-4 animate-spin"
                    viewBox="0 0 20 20"
                    aria-hidden="true"
                  >
                    <circle
                      cx="10"
                      cy="10"
                      r="8"
                      stroke="currentColor"
                      strokeWidth="3"
                      fill="none"
                      className="text-white/30"
                    />
                    <circle
                      cx="10"
                      cy="10"
                      r="8"
                      stroke="currentColor"
                      strokeWidth="3"
                      fill="none"
                      strokeLinecap="round"
                      className="text-white"
                      strokeDasharray="12.5 37.5"
                    />
                  </svg>
                </div>
              </>
            )}

            <VideoThumbnail
              videoDuration={
                hasVisibleUploadProgress ? undefined : cap.duration
              }
              imageClass={clsx(
                anyCapSelected
                  ? "opacity-50"
                  : isDropdownOpen
                    ? "opacity-80"
                    : "opacity-100",
                "transition-opacity duration-200",
              )}
              containerClass="absolute inset-0 aspect-[16/10]"
              videoId={cap.id}
              ownerId={cap.ownerId}
              alt={`${cap.name} Thumbnail`}
              imageStatus={imageStatus}
              setImageStatus={setImageStatus}
              hasActiveUpload={
                uploadProgress !== null &&
                uploadProgress.status !== "fetching" &&
                uploadProgress.status !== "failed" &&
                uploadProgress.status !== "error"
              }
              isAudio={cap.metadata?.isAudio}
              videoName={cap.name}
            />
            {effectivePasswordProtected && (
              <div
                className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-full bg-black/70 text-white"
                title={
                  cap.hasInheritedPassword
                    ? "Password required by space"
                    : "Password protected"
                }
              >
                <FontAwesomeIcon icon={faLock} className="size-3" />
              </div>
            )}
          </Link>
        </div>
        <div
          className={clsx(
            "flex flex-col flex-grow px-4 py-3 w-full",
            !sharedCapCard ? "cursor-pointer" : "cursor-default",
          )}
        >
          <CapCardContent
            cap={cap}
            userId={userId}
            sharedCapCard={sharedCapCard}
            hideSharedStatus={hideSharedStatus}
            isOwner={isOwner}
            views={analytics}
            setIsSharingDialogOpen={setIsSharingDialogOpen}
          />
          {aiRunning && (
            <p
              className="mt-1 flex items-center gap-1.5 truncate text-[11px] font-medium text-[var(--brand)]"
              aria-live="polite"
            >
              <span
                aria-hidden
                className="size-2 shrink-0 rounded-full border-[1.5px] border-[var(--brand)]/40 border-t-[var(--brand)] motion-safe:animate-spin"
              />
              <span className="truncate">{aiLineText}</span>
            </p>
          )}
          {isFreshlyUploaded && canEditVideo && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                handleEditVideo();
              }}
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-[var(--brand-wash)] text-[var(--brand)] border border-[var(--brand)]/30 hover:bg-[var(--brand-wash)]/80 transition-colors self-start"
              title="Trim this video"
            >
              <FontAwesomeIcon icon={faScissors} className="size-2.5" />
              Edit
              <span className="ml-0.5 animate-pulse">✨</span>
            </button>
          )}
          {children}
        </div>
      </fieldset>
    </>
  );
};
