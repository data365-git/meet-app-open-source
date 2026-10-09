"use client";

import { buildEnv, NODE_ENV } from "@cap/env";
import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	LogoBadge,
} from "@cap/ui";
import { formatPlatformDateRelative } from "@cap/utils";
import Cookies from "js-cookie";
import type { ViewerSettingKey } from "@cap/web-backend";
import {
	faChartSimple,
	faChevronDown,
	faLock,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowLeft,
	AudioLines,
	Check,
	Clock,
	Copy,
	Download,
	Ellipsis,
	FileText,
	Globe2,
	Loader2,
	MessageCircle,
	Moon,
	Music,
	Pencil,
	Scissors,
	Send,
	Share2,
	Sun,
	Video,
	X,
} from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	hideShareableLinkCapLogo,
	selectShareableLinkBrandingOrganization,
} from "@/actions/organization/shareable-link-icon";
import { editTitle } from "@/actions/videos/edit-title";
import type { VideoStatusResult } from "@/actions/videos/get-status";
import { replaceVideoWithAudio } from "@/actions/video/replace-with-audio";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";
import { useDashboardContext } from "@/app/(org)/dashboard/Contexts";
import { SharingDialog } from "@/app/(org)/dashboard/caps/components/SharingDialog";
import type { Spaces } from "@/app/(org)/dashboard/dashboard-data";
import { useCurrentUser } from "@/app/Layout/AuthContext";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { UpgradeModal } from "@/components/UpgradeModal";
import { downloadFilename } from "@/lib/download-filename";
import { usePublicEnv } from "@/utils/public-env";
import { navigateWithTransition } from "@/utils/view-transition";
import { useTranslations } from "next-intl";
import type { SharePageBranding, VideoData } from "../types";

export const ShareHeader = ({
	data,
	customDomain,
	domainVerified,
	sharedSpaces = [],
	spacesData = null,
	branding,
	canManageSharePageBranding = false,
}: {
	data: VideoData;
	customDomain?: string | null;
	domainVerified?: boolean;
	sharedOrganizations?: { id: string; name: string }[];
	userOrganizations?: { id: string; name: string }[];
	sharedSpaces?: {
		id: string;
		name: string;
		iconUrl?: string;
		organizationId: string;
		settings?: Partial<Record<ViewerSettingKey, boolean>> | null;
		hasPassword?: boolean;
	}[];
	userSpaces?: {
		id: string;
		name: string;
		iconUrl?: string;
		organizationId: string;
		settings?: Partial<Record<ViewerSettingKey, boolean>> | null;
		hasPassword?: boolean;
	}[];
	spacesData?: Spaces[] | null;
	branding?: SharePageBranding | null;
	canManageSharePageBranding?: boolean;
}) => {
	const t = useTranslations("share");
	const tNav = useTranslations("nav");
	const user = useCurrentUser();
	const router = useRouter();
	const { push, refresh } = router;
	const queryClient = useQueryClient();
	const { data: videoStatus } = useQuery<VideoStatusResult>({
		queryKey: ["videoStatus", data.id],
		queryFn: skipToken,
	});
	const [isEditing, setIsEditing] = useState(false);
	const [displayTitle, setDisplayTitle] = useState(data.name);
	const [editValue, setEditValue] = useState(data.name);
	const [isTitleRevealing, setIsTitleRevealing] = useState(false);
	const [upgradeModalOpen, setUpgradeModalOpen] = useState(false);
	const [isSharingDialogOpen, setIsSharingDialogOpen] = useState(false);
	const [linkCopied, setLinkCopied] = useState(false);
	const [isDownloading, setIsDownloading] = useState(false);
	const [isDownloadingAudio, setIsDownloadingAudio] = useState(false);
	const [isDownloadingTranscript, setIsDownloadingTranscript] = useState(false);
	const [confirmReplaceWithAudioOpen, setConfirmReplaceWithAudioOpen] =
		useState(false);
	const [isReplacingWithAudio, setIsReplacingWithAudio] = useState(false);
	// The Download trigger is now a menu, so its spinner/disabled state must
	// cover EVERY item behind it. Audio extraction in particular runs ffmpeg
	// over the whole recording on first request (seconds to minutes), and
	// without this the button looked idle the entire time and silently ate
	// re-clicks.
	const isPreparingDownload =
		isDownloading || isDownloadingAudio || isDownloadingTranscript;
	const [showCopyOptions, setShowCopyOptions] = useState(false);
	const [showShareOptions, setShowShareOptions] = useState(false);
	const [capturedTime, setCapturedTime] = useState(0);
	const [shareTheme, setShareTheme] = useState<"light" | "dark">("light");
	const [isHidingBranding, setIsHidingBranding] = useState(false);
	const [isOpeningBrandingSettings, setIsOpeningBrandingSettings] =
		useState(false);
	const copyOptionsRef = useRef<HTMLDivElement>(null);
	const shareOptionsRef = useRef<HTMLDivElement>(null);
	const suppressTitleRevealRef = useRef(false);
	const titleSwapTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);
	const titleRevealEndTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	useEffect(() => {
		if (!showCopyOptions) return;
		const handler = (e: MouseEvent) => {
			if (
				copyOptionsRef.current &&
				!copyOptionsRef.current.contains(e.target as Node)
			) {
				setShowCopyOptions(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [showCopyOptions]);

	useEffect(() => {
		if (!showShareOptions) return;
		const handler = (e: MouseEvent) => {
			if (
				shareOptionsRef.current &&
				!shareOptionsRef.current.contains(e.target as Node)
			) {
				setShowShareOptions(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [showShareOptions]);

	useEffect(() => {
		if (typeof document === "undefined") return;
		setShareTheme(
			document.body.classList.contains("dark") ? "dark" : "light",
		);
	}, []);

	const handleToggleShareTheme = () => {
		const nextTheme: "light" | "dark" =
			shareTheme === "light" ? "dark" : "light";
		document.body.classList.remove(shareTheme);
		document.body.classList.add(nextTheme);
		Cookies.set("theme", nextTheme, { expires: 365 });
		setShareTheme(nextTheme);
	};

	const contextData = useDashboardContext();
	const contextSharedSpaces = contextData?.sharedSpaces || null;
	const effectiveSharedSpaces = contextSharedSpaces || sharedSpaces;

	const isOwner = user && user.id === data.owner.id;

	const { webUrl } = usePublicEnv();

	const resolvedTitle = videoStatus?.name ?? data.name;

	useEffect(() => {
		if (isEditing) return;
		if (resolvedTitle === displayTitle) return;

		if (suppressTitleRevealRef.current) {
			suppressTitleRevealRef.current = false;
			setDisplayTitle(resolvedTitle);
			return;
		}

		const prefersReducedMotion =
			typeof window !== "undefined" &&
			window.matchMedia("(prefers-reduced-motion: reduce)").matches;

		if (prefersReducedMotion) {
			setDisplayTitle(resolvedTitle);
			return;
		}

		setIsTitleRevealing(true);
		if (titleSwapTimeoutRef.current) clearTimeout(titleSwapTimeoutRef.current);
		if (titleRevealEndTimeoutRef.current)
			clearTimeout(titleRevealEndTimeoutRef.current);

		titleSwapTimeoutRef.current = setTimeout(() => {
			setDisplayTitle(resolvedTitle);
		}, 160);
		titleRevealEndTimeoutRef.current = setTimeout(() => {
			setIsTitleRevealing(false);
		}, 1000);
	}, [resolvedTitle, displayTitle, isEditing]);

	useEffect(
		() => () => {
			if (titleSwapTimeoutRef.current)
				clearTimeout(titleSwapTimeoutRef.current);
			if (titleRevealEndTimeoutRef.current)
				clearTimeout(titleRevealEndTimeoutRef.current);
		},
		[],
	);

	const startEditing = () => {
		setEditValue(displayTitle);
		setIsEditing(true);
	};

	const handleBlur = async () => {
		setIsEditing(false);
		const next = editValue.trim();
		if (next === "" || next === displayTitle) return;
		try {
			await editTitle(data.id, next);
			toast.success(t("videoTitleUpdated"));
			suppressTitleRevealRef.current = true;
			queryClient.setQueryData<VideoStatusResult>(
				["videoStatus", data.id],
				(old) => (old ? { ...old, name: next } : old),
			);
			refresh();
		} catch (error) {
			if (error instanceof Error) {
				toast.error(error.message);
			} else {
				toast.error(t("videoTitleUpdateFailed"));
			}
		}
	};

	const handleKeyDown = async (event: { key: string }) => {
		if (event.key === "Enter") {
			handleBlur();
		}
	};

	const getVideoLink = () => {
		if (NODE_ENV === "development" && customDomain && domainVerified) {
			return `https://${customDomain}/s/${data.id}`;
		} else if (NODE_ENV === "development" && !customDomain && !domainVerified) {
			return `${webUrl}/s/${data.id}`;
		} else if (buildEnv.NEXT_PUBLIC_IS_CAP && customDomain && domainVerified) {
			return `https://${customDomain}/s/${data.id}`;
		} else if (
			buildEnv.NEXT_PUBLIC_IS_CAP &&
			!customDomain &&
			!domainVerified
		) {
			return `https://cap.link/${data.id}`;
		} else {
			return `${webUrl}/s/${data.id}`;
		}
	};

	const getDisplayLink = () => {
		if (NODE_ENV === "development" && customDomain && domainVerified) {
			return `${customDomain}/s/${data.id}`;
		} else if (NODE_ENV === "development" && !customDomain && !domainVerified) {
			return `${webUrl}/s/${data.id}`;
		} else if (buildEnv.NEXT_PUBLIC_IS_CAP && customDomain && domainVerified) {
			return `${customDomain}/s/${data.id}`;
		} else if (
			buildEnv.NEXT_PUBLIC_IS_CAP &&
			!customDomain &&
			!domainVerified
		) {
			return `cap.link/${data.id}`;
		} else {
			return `${webUrl}/s/${data.id}`;
		}
	};

	const formatTimestamp = (seconds: number): string => {
		const h = Math.floor(seconds / 3600);
		const m = Math.floor((seconds % 3600) / 60);
		const s = seconds % 60;
		if (h > 0)
			return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
		return `${m}:${String(s).padStart(2, "0")}`;
	};

	const handleCopyClick = () => {
		const video = document.querySelector("video");
		const currentTime = video ? Math.floor(video.currentTime) : 0;

		if (currentTime > 3) {
			setCapturedTime(currentTime);
			setShowCopyOptions(true);
		} else {
			navigator.clipboard.writeText(window.location.href);
			setLinkCopied(true);
			setTimeout(() => setLinkCopied(false), 1200);
		}
	};

	const handleCopyLink = (withTimestamp: boolean) => {
		const link = withTimestamp
			? `${getVideoLink()}?t=${capturedTime}`
			: getVideoLink();
		navigator.clipboard.writeText(link);
		setShowCopyOptions(false);
		setLinkCopied(true);
		setTimeout(() => setLinkCopied(false), 1200);
	};

	const handleDownload = async () => {
		if (isDownloading) return;
		setIsDownloading(true);
		try {
			const res = await fetch(
				`/api/playlist?userId=${data.owner.id}&videoId=${data.id}&videoType=mp4`,
			);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const objectUrl = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			const safeName =
				(displayTitle || "video")
					.trim()
					.replace(/[^\w.-]+/g, "_")
					.slice(0, 80) || "video";
			anchor.download = `${safeName}.mp4`;
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(objectUrl);
		} catch {
			toast.error(t("downloadFailed"));
		} finally {
			setIsDownloading(false);
		}
	};

	// Audio-only download. Signed-in team members only, by the owner's decision
	// (2026-08-05): a meeting's audio travels further than a share link, so it is
	// deliberately NOT offered to anonymous link viewers even though the video
	// download is. The route enforces the same rule server-side — this only hides
	// a button that would otherwise 401.
	const handleDownloadAudio = async () => {
		if (isDownloadingAudio) return;
		setIsDownloadingAudio(true);
		try {
			const res = await fetch(`/api/videos/${data.id}/audio`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const objectUrl = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = downloadFilename(displayTitle, "mp3");
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(objectUrl);
		} catch {
			toast.error(t("downloadFailed"));
		} finally {
			setIsDownloadingAudio(false);
		}
	};

	// Transcript-only download, same signed-in-only rule as the audio download
	// above (the /api/videos/:id/transcript route requires auth too). No
	// pre-check of transcript readiness — just attempt the fetch and toast on
	// 404, which keeps this simple and matches the audio download's pattern.
	const handleDownloadTranscript = async () => {
		if (isDownloadingTranscript) return;
		setIsDownloadingTranscript(true);
		try {
			const res = await fetch(`/api/videos/${data.id}/transcript`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const blob = await res.blob();
			const objectUrl = URL.createObjectURL(blob);
			const anchor = document.createElement("a");
			anchor.href = objectUrl;
			anchor.download = downloadFilename(displayTitle, "txt");
			document.body.appendChild(anchor);
			anchor.click();
			anchor.remove();
			URL.revokeObjectURL(objectUrl);
		} catch {
			toast.error(t("downloadFailed"));
		} finally {
			setIsDownloadingTranscript(false);
		}
	};

	// Replace the video with its own audio — the SAME server action the
	// dashboard card has offered since T4b, surfaced here because the owner
	// wants it where he watches, not only in the list. IRREVERSIBLE: the video
	// file is overwritten by the extracted audio and the raw upload is
	// reclaimed, which is why it goes through the same destructive-styled
	// confirmation the dashboard uses. Transcript and AI analysis survive.
	const handleReplaceWithAudio = async () => {
		if (isReplacingWithAudio) return;
		setIsReplacingWithAudio(true);
		try {
			const result = await replaceVideoWithAudio(data.id);
			if (result.ok) {
				toast.success(t("replaceWithAudioSuccess"));
				setConfirmReplaceWithAudioOpen(false);
				refresh();
				return;
			}
			if (result.reason === "already_audio") {
				setConfirmReplaceWithAudioOpen(false);
				refresh();
				return;
			}
			toast.error(
				result.reason === "unsupported_source"
					? t("replaceWithAudioErrorUnsupported")
					: t("replaceWithAudioError"),
			);
		} catch {
			toast.error(t("replaceWithAudioError"));
		} finally {
			setIsReplacingWithAudio(false);
		}
	};

	const handleSharingUpdated = () => {
		refresh();
	};

	const userIsOwnerAndNotPro = user?.id === data.owner.id && !data.owner.isPro;
	const canEditVideo = isOwner && !data.isScreenshot && !data.hasActiveUpload;
	const handleEditVideo = () => {
		navigateWithTransition("edit-enter", () => push(`/s/${data.id}/edit`));
	};

	const handleHideBranding = async () => {
		if (!user?.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		setIsHidingBranding(true);

		try {
			await hideShareableLinkCapLogo(data.orgId);
			toast.success(t("logoHidden"));
			refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : t("logoHideFailed"),
			);
		} finally {
			setIsHidingBranding(false);
		}
	};

	const handleEditBranding = async () => {
		if (!user?.isPro) {
			setUpgradeModalOpen(true);
			return;
		}

		setIsOpeningBrandingSettings(true);

		try {
			await selectShareableLinkBrandingOrganization(data.orgId);
			push("/dashboard/settings/organization");
		} catch (error) {
			toast.error(
				error instanceof Error
					? error.message
					: t("orgSettingsOpenFailed"),
			);
			setIsOpeningBrandingSettings(false);
		}
	};

	const renderSharedStatus = () => {
		if (isOwner) {
			const hasSpaceSharing = effectiveSharedSpaces?.length > 0;
			const isPublic = data.public;

			if (!hasSpaceSharing && !isPublic) {
				return (
					<button
						type="button"
						onClick={() => setIsSharingDialogOpen(true)}
						className="inline-flex min-h-9 items-center rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-sm text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12 sm:min-h-0 sm:px-2.5 sm:py-0.5 sm:text-xs"
					>
						{t("makeSharableLabel")}
						<FontAwesomeIcon className="ml-1.5 size-2.5" icon={faChevronDown} />
					</button>
				);
			}
			return (
				<button
					type="button"
					onClick={() => setIsSharingDialogOpen(true)}
					className="inline-flex min-h-9 items-center rounded-full border border-gray-6 bg-gray-3 px-3 py-1 text-sm text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12 sm:min-h-0 sm:px-2.5 sm:py-0.5 sm:text-xs"
				>
					{t("sharedLabel")}
					<FontAwesomeIcon className="ml-1.5 size-2.5" icon={faChevronDown} />
				</button>
			);
		}
		return (
			<span className="inline-flex items-center rounded-full border border-gray-6 bg-gray-3 px-2.5 py-0.5 text-xs text-gray-11">
				{t("sharedWithYou")}
			</span>
		);
	};

	const handleBackClick = () => {
		if (typeof window !== "undefined" && window.history.length > 1) {
			router.back();
		} else {
			push("/dashboard/caps");
		}
	};

	const renderBranding = () => {
		if (!branding) return null;

		return (
			<div className="group relative inline-flex shrink-0 items-center">
				{canManageSharePageBranding && (
					<div className="pointer-events-none absolute left-0 top-full z-10 mt-1 flex items-center gap-1 rounded-full border border-gray-5 bg-gray-1 p-1 opacity-0 shadow-sm transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100">
						<Button
							variant="gray"
							size="xs"
							aria-label={t("editBrandingAriaLabel")}
							className="h-7 gap-1 whitespace-nowrap rounded-full px-2 text-[11px]"
							disabled={isOpeningBrandingSettings}
							onClick={handleEditBranding}
						>
							<Pencil className="size-3.5 text-gray-12" />
							{t("changeLogo")}
						</Button>
						{branding.type === "cap" && (
							<Button
								variant="gray"
								size="xs"
								aria-label={t("hideBrandingAriaLabel")}
								className="h-7 gap-1 whitespace-nowrap rounded-full px-2 text-[11px]"
								disabled={isHidingBranding}
								onClick={handleHideBranding}
							>
								<X className="size-3.5 text-gray-12" />
								{t("remove")}
							</Button>
						)}
					</div>
				)}
				{branding.type === "custom" ? (
					<div className="inline-flex h-11 max-w-56 items-center justify-center">
						<Image
							src={branding.imageUrl}
							alt={`${branding.name} logo`}
							width={176}
							height={32}
							unoptimized
							className="max-h-8 w-auto max-w-44 object-contain"
						/>
					</div>
				) : (
					<Link
						href={user ? "/dashboard/caps" : "/"}
						className="inline-flex h-11 items-center gap-2 hover:opacity-80 transition-opacity cursor-pointer"
					>
						<LogoBadge className="h-7 w-7" />
						<span className="text-base font-semibold text-gray-12 tracking-tight">
							data365
						</span>
					</Link>
				)}
			</div>
		);
	};

	return (
		<>
			{userIsOwnerAndNotPro && (
				<div
					id="share-sticky-notice"
					className="flex sticky flex-col sm:flex-row inset-x-0 top-0 z-10 gap-4 justify-center items-center px-3 py-2 mx-auto w-[calc(100%-20px)] max-w-fit rounded-b-xl border bg-gray-4 border-gray-6"
				>
					<p className="text-center text-gray-12">
						{t("freePlanLimitNotice")}
					</p>
					<Button
						type="button"
						onClick={() => setUpgradeModalOpen(true)}
						size="sm"
						variant="blue"
					>
						{t("upgradeToPro")}
					</Button>
				</div>
			)}
			<SharingDialog
				isOpen={isSharingDialogOpen}
				onClose={() => setIsSharingDialogOpen(false)}
				capId={data.id}
				capName={data.name}
				sharedSpaces={effectiveSharedSpaces || []}
				onSharingUpdated={handleSharingUpdated}
				isPublic={data.public}
				spacesData={spacesData}
				hasPassword={!!data.hasPassword}
				inheritedPasswordSources={data.inheritedPasswordSources}
				onPasswordUpdated={() => refresh()}
				user={user}
				onUpgradeRequest={setUpgradeModalOpen}
			/>
			<ConfirmationDialog
				open={confirmReplaceWithAudioOpen}
				icon={<AudioLines className="size-4" />}
				title={t("replaceWithAudioTitle")}
				description={t("replaceWithAudioBody")}
				confirmLabel={
					isReplacingWithAudio
						? t("replacingWithAudio")
						: t("replaceWithAudioConfirm")
				}
				cancelLabel={t("replaceWithAudioCancel")}
				confirmVariant="destructive"
				loading={isReplacingWithAudio}
				onConfirm={handleReplaceWithAudio}
				onCancel={() => setConfirmReplaceWithAudioOpen(false)}
			/>
			<div className="mt-5 sm:mt-8">
				<div className="flex flex-col gap-5">
					<div className="flex items-start justify-between gap-3 sm:flex-col lg:flex-row">
						<div className="flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
							{user && (
								<button
									type="button"
									onClick={handleBackClick}
									className="inline-flex size-11 items-center justify-center rounded-full border border-gray-6 bg-gray-3 text-sm text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12 sm:min-h-0 sm:w-auto sm:gap-1.5 sm:px-2.5 sm:py-0.5 sm:text-xs"
									aria-label={t("goBackAriaLabel")}
								>
									<ArrowLeft className="size-3" />
									<span className="hidden sm:inline">{t("back")}</span>
								</button>
							)}
							{renderBranding()}
							{branding && <div className="h-7 w-px shrink-0 bg-gray-6" />}
							<div className="min-w-0 flex-1">
								{isEditing ? (
									<input
										value={editValue}
										onChange={(e) => setEditValue(e.target.value)}
										onBlur={handleBlur}
										onKeyDown={handleKeyDown}
										className="w-full min-w-0 text-xl font-semibold text-gray-12 sm:text-3xl"
									/>
								) : (
									<div className="relative inline-flex min-w-0 max-w-full align-middle">
										<h1
											role={isOwner ? "button" : undefined}
											tabIndex={isOwner ? 0 : undefined}
											className="truncate text-xl font-semibold text-gray-12 sm:text-3xl"
											title={displayTitle}
											onClick={() => {
												if (isOwner) {
													startEditing();
												}
											}}
											onKeyDown={(event) => {
												if (
													isOwner &&
													(event.key === "Enter" || event.key === " ")
												) {
													event.preventDefault();
													startEditing();
												}
											}}
										>
											{displayTitle}
										</h1>
										{isTitleRevealing && (
											<span aria-hidden className="ai-title-skeleton" />
										)}
									</div>
								)}
							</div>
						</div>

						<div className="flex w-auto shrink-0 items-center justify-end gap-2 sm:w-full lg:w-auto">
							{(data.hasPassword || data.hasInheritedPassword) && (
								<FontAwesomeIcon
									className="text-amber-600 size-4"
									icon={faLock}
								/>
							)}
							<div className="relative" ref={copyOptionsRef}>
								{/* Full pill: visible on sm+ */}
								<button
									type="button"
									onClick={handleCopyClick}
									className="hidden sm:inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-3 px-3 py-1.5 text-sm text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12"
								>
									<span className="max-w-[50vw] truncate sm:max-w-72">
										{getDisplayLink()}
									</span>
									{linkCopied ? (
										<Check className="w-3.5 h-3.5 shrink-0 text-green-600 svgpathanimation" />
									) : (
										<Copy className="w-3.5 h-3.5 shrink-0" />
									)}
								</button>
								{showCopyOptions && (
									<div className="absolute right-0 top-full z-50 mt-1 w-max max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-gray-6 bg-gray-1 shadow-lg">
										<button
											type="button"
											className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3"
											onClick={() => handleCopyLink(false)}
										>
											<Copy className="w-3.5 h-3.5 shrink-0" />
											{t("copyLink")}
										</button>
										<button
											type="button"
											className="flex w-full items-center gap-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3"
											onClick={() => handleCopyLink(true)}
										>
											<Clock className="w-3.5 h-3.5 shrink-0" />
											{t("copyLinkAtTime", { time: formatTimestamp(capturedTime) })}
										</button>
									</div>
								)}
							</div>

							<div className="relative" ref={shareOptionsRef}>
								{/* Share trigger — pill on sm+, icon-only on mobile */}
								<button
									type="button"
									onClick={() => setShowShareOptions((v) => !v)}
									aria-label={t("share")} title={t("share")}
									className="hidden sm:inline-flex items-center gap-2 rounded-full border border-gray-6 bg-gray-3 px-3 py-1.5 text-sm text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12"
								>
									<Share2 className="w-3.5 h-3.5 shrink-0" />
									{t("share")}
								</button>
								<button
									type="button"
									onClick={() => setShowShareOptions((v) => !v)}
									aria-label={t("share")} title={t("share")}
									className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-[var(--brand)] px-4 text-sm font-medium text-[var(--brand-fg)] shadow-sm transition-colors hover:brightness-95 sm:hidden"
								>
									<Share2 className="size-4 shrink-0" />
									<span>{t("share")}</span>
								</button>
								{showShareOptions && (
									<div className="absolute right-0 top-full z-50 mt-1 w-max max-w-[calc(100vw-2rem)] overflow-hidden rounded-lg border border-gray-6 bg-gray-1 shadow-lg">
										<button
											type="button"
											className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3 sm:hidden"
											onClick={() => {
												handleCopyLink(false);
												setShowShareOptions(false);
											}}
										>
											<Copy className="w-3.5 h-3.5 shrink-0" />
											{t("copyLink")}
										</button>
										<button
											type="button"
											className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3"
											onClick={() => {
												const link = getVideoLink();
												const title = displayTitle || data.name;
												window.open(
													`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(title)}`,
													"_blank",
													"noopener,noreferrer",
												);
												setShowShareOptions(false);
											}}
										>
											<Send className="w-3.5 h-3.5 shrink-0" />
											{t("shareOnTelegram")}
										</button>
										<button
											type="button"
											className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3"
											onClick={() => {
												const link = getVideoLink();
												const title = displayTitle || data.name;
												window.open(
													`https://wa.me/?text=${encodeURIComponent(`${title} ${link}`)}`,
													"_blank",
													"noopener,noreferrer",
												);
												setShowShareOptions(false);
											}}
										>
											<MessageCircle className="w-3.5 h-3.5 shrink-0" />
											{t("shareOnWhatsApp")}
										</button>
										<button
											type="button"
											className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3"
											onClick={() => {
												const link = getVideoLink();
												const title = displayTitle || data.name;
												window.open(
													`https://mail.google.com/mail/?view=cm&fs=1&su=${encodeURIComponent(title)}&body=${encodeURIComponent(link)}`,
													"_blank",
													"noopener,noreferrer",
												);
												setShowShareOptions(false);
											}}
										>
											<Share2 className="w-3.5 h-3.5 shrink-0" />
											{t("email")}
										</button>
										<button
											type="button"
											disabled={isDownloading}
											className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-sm text-gray-12 transition-colors hover:bg-gray-3 disabled:opacity-60 sm:hidden"
											onClick={() => {
												setShowShareOptions(false);
												void handleDownload();
											}}
										>
											<Download className="w-3.5 h-3.5 shrink-0" />
											{isDownloading
												? t("downloadPreparing")
												: t("download")}
										</button>
									</div>
								)}
							</div>

							{/* Download trigger — now a dropdown with Video / Audio /
							    Transcript, instead of two separate pill buttons. Audio
							    and Transcript stay signed-in-only (same rule their
							    routes enforce server-side); Video stays open to
							    anonymous share-link viewers, matching today's behavior. */}
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<button
										type="button"
										disabled={isPreparingDownload}
										aria-label={t("downloadAriaLabel")}
										title={t("downloadAriaLabel")}
										className="hidden items-center justify-center gap-1.5 rounded-full border border-gray-6 bg-gray-3 text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12 disabled:opacity-60 sm:inline-flex sm:h-auto sm:w-auto sm:px-3 sm:py-1.5 sm:text-sm"
									>
										{isPreparingDownload ? (
											<Loader2 className="size-3.5 shrink-0 animate-spin" />
										) : (
											<Download className="size-3.5 shrink-0" />
										)}
										<span className="hidden sm:inline">
											{isPreparingDownload
												? t("downloadPreparing")
												: t("download")}
										</span>
									</button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									<DropdownMenuItem onClick={handleDownload}>
										<Video className="size-3.5 shrink-0" />
										{t("downloadVideo")}
									</DropdownMenuItem>
									{user && (
										<DropdownMenuItem onClick={handleDownloadAudio}>
											<Music className="size-3.5 shrink-0" />
											{t("downloadAudio")}
										</DropdownMenuItem>
									)}
									{user && (
										<DropdownMenuItem onClick={handleDownloadTranscript}>
											<FileText className="size-3.5 shrink-0" />
											{t("downloadTranscript")}
										</DropdownMenuItem>
									)}
								</DropdownMenuContent>
							</DropdownMenu>

							{/* Replace-with-audio, in the slot the separate Audio
							    download button used to occupy. The same action the
							    dashboard card offers, with the same destructive
							    confirmation — OWNER only (the server action refuses
							    anyone else) and hidden once the recording is already
							    audio-only, matching how Share.tsx computes
							    `canReplaceWithAudio`. */}
							{isOwner && !data.metadata?.isAudio && (
								<button
									type="button"
									onClick={() => setConfirmReplaceWithAudioOpen(true)}
									disabled={isReplacingWithAudio}
									aria-label={t("replaceWithAudioButton")}
									title={t("replaceWithAudioButton")}
									className="hidden items-center justify-center gap-1.5 rounded-full border border-gray-6 bg-gray-3 text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12 disabled:opacity-60 sm:inline-flex sm:h-auto sm:w-auto sm:px-3 sm:py-1.5 sm:text-sm"
								>
									{isReplacingWithAudio ? (
										<Loader2 className="size-3.5 shrink-0 animate-spin" />
									) : (
										<AudioLines className="size-3.5 shrink-0" />
									)}
									<span className="hidden sm:inline">
										{isReplacingWithAudio
											? t("replacingWithAudio")
											: t("replaceWithAudioButton")}
									</span>
								</button>
							)}

							{/* Overflow menu (owner only) */}
							{isOwner && (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<button
											type="button"
											aria-label={t("moreActionsAriaLabel")}
											className="inline-flex size-11 items-center justify-center rounded-full border border-gray-6 bg-gray-3 text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12 sm:h-auto sm:w-auto sm:p-1.5"
										>
											<Ellipsis className="w-3.5 h-3.5 shrink-0" />
										</button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end">
										<DropdownMenuItem onClick={handleToggleShareTheme}>
											{shareTheme === "light" ? (
												<Moon className="mr-2 size-3.5 text-gray-12" />
											) : (
												<Sun className="mr-2 size-3.5 text-gray-12" />
											)}
											{shareTheme === "light"
												? tNav("toggleDark")
												: tNav("toggleLight")}
										</DropdownMenuItem>
										{canEditVideo && (
											<DropdownMenuItem onClick={handleEditVideo}>
												<Scissors className="mr-2 size-3.5 text-gray-12" />
												{t("editVideo")}
											</DropdownMenuItem>
										)}
										<DropdownMenuItem
											onClick={() =>
												push(`/dashboard/analytics?capId=${data.id}`)
											}
										>
											<FontAwesomeIcon
												className="mr-2 size-3.5 text-gray-12"
												icon={faChartSimple}
											/>
											{t("viewAnalytics")}
										</DropdownMenuItem>
										<DropdownMenuItem
											onClick={() => push("/dashboard/caps?page=1")}
										>
											{t("goToDashboard")}
										</DropdownMenuItem>
										{canManageSharePageBranding && branding && (
											<>
												<DropdownMenuSeparator />
												<DropdownMenuItem
													disabled={isOpeningBrandingSettings}
													onClick={handleEditBranding}
												>
													<Pencil className="mr-2 size-3.5 text-gray-12" />
													{t("changeLogo")}
												</DropdownMenuItem>
												{branding.type === "cap" && (
													<DropdownMenuItem
														disabled={isHidingBranding}
														onClick={handleHideBranding}
													>
														<X className="mr-2 size-3.5 text-gray-12" />
														{t("removeLogo")}
													</DropdownMenuItem>
												)}
											</>
										)}
									</DropdownMenuContent>
								</DropdownMenu>
							)}
						</div>
					</div>

					<div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
						<div className="flex flex-wrap gap-x-4 gap-y-2 items-center">
							<div className="flex gap-2.5 items-center">
								{data.owner.name && (
									<SignedImageUrl
										name={data.owner.name}
										image={data.owner.image}
										className="size-8"
										letterClass="text-base"
									/>
								)}
								<div className="flex flex-col text-left">
									<p className="text-sm font-medium text-gray-12">
										{data.owner.name}
									</p>
									<p className="text-xs text-gray-10">
										{formatPlatformDateRelative(data.createdAt)}
									</p>
								</div>
							</div>
							{user && renderSharedStatus()}
							{userIsOwnerAndNotPro && (
								<button
									type="button"
									className="flex items-center text-sm text-gray-400 duration-200 cursor-pointer hover:text-[var(--brand)]"
									onClick={() => setUpgradeModalOpen(true)}
								>
									<Globe2 className="mr-1 w-4 h-4" />
									{t("connectCustomDomain")}
								</button>
							)}
						</div>

					</div>
				</div>
			</div>
			<UpgradeModal
				open={upgradeModalOpen}
				onOpenChange={setUpgradeModalOpen}
			/>
		</>
	);
};
