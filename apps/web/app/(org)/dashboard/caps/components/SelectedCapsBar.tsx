"use client";

import {
	Button,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@cap/ui";
import {
	faArrowRightArrowLeft,
	faFileLines,
	faFilm,
	faFolder,
	faTrash,
	faUsers,
	faVideo,
	faVolumeHigh,
	faWandMagicSparkles,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import NumberFlow from "@number-flow/react";
import { AnimatePresence, motion } from "framer-motion";
import { ConfirmationDialog } from "@/app/(org)/dashboard/_components/ConfirmationDialog";

interface SelectedCapsBarProps {
	selectedCaps: string[];
	setSelectedCaps: (caps: Video.VideoId[]) => void;
	deleteSelectedCaps: () => void;
	isDeleting: boolean;
	/**
	 * Which library the bar is currently rendered in. The Move menu hides the
	 * library you are already in, so the only options offered are real moves.
	 */
	currentLibrary?: LibraryKind;
	/** Folders the selection can be moved into. Omitted = no folder options. */
	folders?: FolderDataType[];
	/**
	 * Title + audio-state of every video on the page, used ONLY to name what the
	 * bulk replace-with-audio confirmation is about to destroy. Omitted = that
	 * control is not offered, because an irreversible action must never be
	 * confirmed against a bare count.
	 */
	capDetails?: {
		id: string;
		name: string;
		isAudio?: boolean;
		/**
		 * Video length in seconds + AI metadata for the selected caps. The two
		 * bulk-AI buttons need both (done/running state + the "taxminan" price
		 * estimate), so they stay HIDDEN where a caller does not supply them.
		 */
		durationSec?: number | null;
		/**
		 * The `videos.transcriptionStatus` column. Both dashboard queries now
		 * select it, letting the planner pre-skip finished transcripts instead
		 * of letting the generate route turn them into a full AI run (F1).
		 */
		transcriptionStatus?: string | null;
		metadata?: VideoMetadata | null;
	}[];
	/**
	 * The signed-in user's admin flag. The bulk-AI buttons are owner/admin only
	 * (ADR 2026-10-07 decision 1) — the generate route enforces the same rule
	 * server-side; this only keeps the buttons off non-admin screens.
	 */
	isAdmin?: boolean;
}

import type { VideoMetadata } from "@cap/database/types";
import type { Folder, Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { toast } from "sonner";
import { moveVideosToFolder } from "@/actions/folders/moveVideosToFolder";
import { replaceVideosWithAudio } from "@/actions/video/replace-videos-with-audio";
import { setVideosLibraryKind } from "@/actions/videos/set-library-kind";
import {
	type BulkAiMode,
	type BulkAiPlan,
	buildBulkAiResultToast,
	bulkAiButtonState,
	planBulkAi,
	runBulkAiStarts,
} from "@/lib/bulk-ai";
import type { LibraryKind } from "@/lib/library-kind";
import { BulkAiConfirmDialog } from "./BulkAiConfirmDialog";
import type { FolderDataType } from "./Folder";

const LIBRARY_LABELS: Record<LibraryKind, string> = {
	recording: "Recordings",
	meeting: "Meetings",
};

export const SelectedCapsBar = ({
	selectedCaps,
	setSelectedCaps,
	deleteSelectedCaps,
	isDeleting,
	currentLibrary,
	folders,
	capDetails,
	isAdmin,
}: SelectedCapsBarProps) => {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [isMoving, setIsMoving] = useState(false);
	const [confirmAudioOpen, setConfirmAudioOpen] = useState(false);
	const [isReplacingWithAudio, setIsReplacingWithAudio] = useState(false);
	// Which bulk-AI mode's confirm dialog is open (null = closed), and whether
	// the one-at-a-time start loop is in flight (both buttons lock meanwhile).
	const [bulkAiMode, setBulkAiMode] = useState<BulkAiMode | null>(null);
	const [isBulkAiRunning, setIsBulkAiRunning] = useState(false);
	// Double-click armor beyond the state flag (F2): state updates are async,
	// so two clicks in one tick can both pass an `isBulkAiRunning` check. The
	// ref flips synchronously, and the dialog lives only while visible.
	const bulkAiRunningRef = useRef(false);
	const router = useRouter();

	const handleConfirmDelete = () => {
		deleteSelectedCaps();
		setConfirmOpen(false);
	};

	const ids = selectedCaps as Video.VideoId[];
	const countLabel = `${selectedCaps.length} cap${
		selectedCaps.length === 1 ? "" : "s"
	}`;

	// Moving between libraries only ever writes `libraryKind` — never
	// `videos.source`, which stays the immutable record of how it was captured.
	const moveToLibrary = async (libraryKind: LibraryKind) => {
		if (isMoving || ids.length === 0) return;
		setIsMoving(true);
		try {
			const result = await setVideosLibraryKind(ids, libraryKind);
			if (!result.success) {
				toast.error(result.error);
				return;
			}
			toast.success(`Moved ${countLabel} to ${LIBRARY_LABELS[libraryKind]}`);
			setSelectedCaps([]);
			router.refresh();
		} catch (_error) {
			toast.error("Failed to move the selected caps");
		} finally {
			setIsMoving(false);
		}
	};

	const moveToFolder = async (folder: FolderDataType) => {
		if (isMoving || ids.length === 0) return;
		setIsMoving(true);
		try {
			const result = await moveVideosToFolder({
				videoIds: ids,
				folderId: folder.id as Folder.FolderId,
				spaceId: folder.spaceId ?? null,
			});

			// Report moved vs. failed separately — a partial batch must never be
			// reported as a single blanket "done", since that would leave the
			// user believing every selected cap moved when some did not.
			if (result.movedCount > 0) {
				toast.success(
					result.failedCount > 0
						? `Moved ${result.movedCount} of ${ids.length} cap${
								ids.length === 1 ? "" : "s"
							} to ${folder.name} (${result.failedCount} failed)`
						: `Moved ${countLabel} to ${folder.name}`,
				);
			}
			if (result.failedCount > 0 && result.movedCount === 0) {
				toast.error(result.error ?? "Failed to move to folder");
			}
			// A partial batch gets ONE toast, not two: the success message above
			// already carries "(N failed)", so an error toast beside it states the
			// same fact twice. And the selection is KEPT when nothing moved — that
			// selection is exactly what the user needs in order to retry.
			// Cleared only when EVERYTHING moved. On a partial batch the failed
			// ones stay selected so the user can retry with one press instead of
			// hunting them down again; re-moving the arrived ones is harmless.
			if (result.failedCount === 0) setSelectedCaps([]);
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to move to folder",
			);
		} finally {
			setIsMoving(false);
		}
	};

	// The selected recordings that still HAVE a video to lose. Already-audio ones
	// are excluded so the confirmation never names something it will not touch,
	// and so a selection of nothing-but-audio hides the control entirely.
	const replaceableCaps = (capDetails ?? []).filter(
		(cap) => selectedCaps.includes(cap.id) && !cap.isAudio,
	);

	// Bulk AI (ADR 2026-10-07): only offered when the caller supplied per-cap
	// data for EVERY selected cap — a partial view must never price or
	// half-plan a batch, so the buttons simply stay hidden without it.
	const bulkCaps = (capDetails ?? []).filter((cap) =>
		selectedCaps.includes(cap.id),
	);
	const bulkButtons = bulkAiButtonState({
		isAdmin,
		selectedCount: selectedCaps.length,
		hasCapData:
			selectedCaps.length > 0 && bulkCaps.length === selectedCaps.length,
	});
	// Planned fresh per render while the dialog is open: `bulkCaps` is a new
	// array each render, so a useMemo here never actually memoizes (F7).
	const bulkPlan: BulkAiPlan | null = bulkAiMode
		? planBulkAi(bulkCaps, bulkAiMode)
		: null;

	const openBulkAiDialog = (mode: BulkAiMode) => {
		// Everything already done/running: nothing to start, so no confirm —
		// tell the owner plainly instead of a "0 ta video · Boshlash" dialog.
		const plan = planBulkAi(bulkCaps, mode);
		if (plan.toRun.length === 0) {
			toast.info(
				plan.skipped.length > 0
					? `Hammasi allaqachon tayyor yoki ishlanmoqda - ${plan.skipped.length} tasi o'tkazib yuborildi`
					: "Tanlov bo'sh",
			);
			return;
		}
		setBulkAiMode(mode);
	};

	// One video at a time over the EXISTING generate route; exactly ONE toast
	// at the end, whatever happened (F3 - `runBulkAiStarts` never throws: it
	// counts network/500 failures and continues, so no catch is needed).
	const startBulkAi = async () => {
		if (
			!bulkAiMode ||
			!bulkPlan ||
			bulkPlan.toRun.length === 0 ||
			bulkAiRunningRef.current
		) {
			// Nothing left to start (the grid refreshed under an open dialog):
			// close it instead of reporting "0 tadan 0 tasi boshlandi".
			if (!bulkAiRunningRef.current) setBulkAiMode(null);
			return;
		}
		bulkAiRunningRef.current = true;
		setIsBulkAiRunning(true);
		try {
			const outcome = await runBulkAiStarts(bulkPlan.toRun, bulkAiMode);
			const result = buildBulkAiResultToast(outcome);
			if (result.kind === "success") toast.success(result.text);
			else toast.error(result.text);
			setBulkAiMode(null);
			// Clear the selection: the cards' AI state on screen is now stale,
			// and a second press from it could re-plan just-started videos (F2).
			setSelectedCaps([]);
			// Cards pick up their usual AI progress from the refreshed grid.
			router.refresh();
		} finally {
			bulkAiRunningRef.current = false;
			setIsBulkAiRunning(false);
		}
	};

	const replaceSelectedWithAudio = async () => {
		if (isReplacingWithAudio || replaceableCaps.length === 0) return;
		setIsReplacingWithAudio(true);
		try {
			const result = await replaceVideosWithAudio(
				replaceableCaps.map((cap) => cap.id),
			);
			if (result.replaced.length > 0) {
				toast.success(
					`Replaced ${result.replaced.length} recording${
						result.replaced.length === 1 ? "" : "s"
					} with audio`,
				);
			}
			// Reported separately and NOT as a single "done": a partial batch that
			// claimed success would leave the user believing videos were reclaimed
			// that are still there.
			if (result.failed.length > 0) {
				toast.error(
					`${result.failed.length} could not be replaced and were left unchanged`,
				);
			}
			setConfirmAudioOpen(false);
			setSelectedCaps([]);
			router.refresh();
		} catch (_error) {
			toast.error("Failed to replace the selected recordings with audio");
		} finally {
			setIsReplacingWithAudio(false);
		}
	};

	const libraryOptions = (Object.keys(LIBRARY_LABELS) as LibraryKind[]).filter(
		(kind) => kind !== currentLibrary,
	);
	const folderOptions = folders ?? [];

	return (
		<AnimatePresence>
			{selectedCaps.length > 0 && (
				<motion.div
					className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] left-2 right-2 z-50 mx-auto flex w-auto max-w-xl items-center justify-between rounded-xl border border-gray-2 bg-gray-1 p-3 shadow-lg lg:bottom-12 lg:left-0 lg:right-0 lg:w-full"
					initial={{ opacity: 0, y: 10, scale: 0.9 }}
					animate={{ opacity: 1, y: 0, scale: 1 }}
					exit={{
						opacity: 0,
						y: 10,
						scale: 0.9,
						transition: { duration: 0.2 },
					}}
					transition={{
						opacity: { duration: 0.2, ease: "easeOut" },
						y: { type: "spring", damping: 15, stiffness: 300 },
						scale: { type: "spring", damping: 15, stiffness: 300 },
					}}
				>
					<div className="flex flex-col">
						<div className="flex gap-1 text-sm font-medium text-gray-10">
							<NumberFlow
								value={selectedCaps.length}
								className="tabular-nums text-md text-gray-12"
							/>
							cap{selectedCaps.length !== 1 ? "s" : ""} selected
						</div>
						{/* F5: the ceiling must be readable text, not a title on a
						    disabled button (phones are a primary device here). */}
						{bulkButtons.visible && bulkButtons.hint && (
							<span className="text-xs leading-tight text-gray-11">
								{bulkButtons.hint}
							</span>
						)}
					</div>
					{/* F5: five buttons do not fit 375 px in one row - the row wraps
					    instead of overflowing, and the two AI buttons drop their
					    labels below `sm` (icon + aria-label only). */}
					<div className="flex flex-wrap justify-end gap-2 ml-4">
						<Button
							variant="dark"
							onClick={() => setSelectedCaps([])}
							className="text-sm"
							size="sm"
						>
							Cancel
						</Button>
						{(libraryOptions.length > 0 || folderOptions.length > 0) && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="gray"
										disabled={isMoving || isDeleting}
										className="text-sm"
										size="sm"
									>
										<FontAwesomeIcon
											className="mr-1.5 size-3"
											icon={faArrowRightArrowLeft}
										/>
										{isMoving ? "Moving..." : "Move"}
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="min-w-[190px]">
									{libraryOptions.length > 0 && (
										<>
											<DropdownMenuLabel>Move to library</DropdownMenuLabel>
											{libraryOptions.map((kind) => (
												<DropdownMenuItem
													key={kind}
													className="gap-2 rounded-lg"
													onSelect={() => void moveToLibrary(kind)}
												>
													<FontAwesomeIcon
														className="size-3 text-gray-11"
														icon={kind === "meeting" ? faUsers : faVideo}
													/>
													<span>{LIBRARY_LABELS[kind]}</span>
												</DropdownMenuItem>
											))}
										</>
									)}
									{folderOptions.length > 0 && (
										<>
											{libraryOptions.length > 0 && <DropdownMenuSeparator />}
											<DropdownMenuLabel>Move to folder</DropdownMenuLabel>
											{folderOptions.map((folder) => (
												<DropdownMenuItem
													key={folder.id}
													className="gap-2 rounded-lg"
													onSelect={() => void moveToFolder(folder)}
												>
													<FontAwesomeIcon
														className="size-3 text-gray-11"
														icon={faFolder}
													/>
													<span className="truncate">{folder.name}</span>
												</DropdownMenuItem>
											))}
										</>
									)}
								</DropdownMenuContent>
							</DropdownMenu>
						)}
						{replaceableCaps.length > 0 && (
							<Button
								variant="gray"
								onClick={() => setConfirmAudioOpen(true)}
								disabled={isDeleting || isMoving || isReplacingWithAudio}
								className="text-sm"
								size="sm"
							>
								<FontAwesomeIcon
									className="mr-1.5 size-3"
									icon={faVolumeHigh}
								/>
								{isReplacingWithAudio ? "Replacing..." : "Replace with audio"}
							</Button>
						)}
						{/* Bulk AI from selection (ADR 2026-10-07): admin-only, one
						    price-confirm, then one video at a time. Icon-only below
						    `sm` (aria-label keeps them usable) so 5 buttons fit 375 px
						    once the row wraps. */}
						{bulkButtons.visible && (
							<Button
								variant="gray"
								onClick={() => openBulkAiDialog("transcript")}
								disabled={
									bulkButtons.disabled ||
									isBulkAiRunning ||
									isDeleting ||
									isMoving ||
									isReplacingWithAudio
								}
								aria-label="Faqat transkript"
								className="text-sm"
								size="sm"
							>
								<FontAwesomeIcon
									className="sm:mr-1.5 size-3"
									icon={faFileLines}
								/>
								<span className="hidden sm:inline">
									{isBulkAiRunning ? "Boshlanmoqda..." : "Faqat transkript"}
								</span>
							</Button>
						)}
						{bulkButtons.visible && (
							<Button
								variant="gray"
								onClick={() => openBulkAiDialog("full")}
								disabled={
									bulkButtons.disabled ||
									isBulkAiRunning ||
									isDeleting ||
									isMoving ||
									isReplacingWithAudio
								}
								aria-label="To'liq AI tahlil"
								className="text-sm"
								size="sm"
							>
								<FontAwesomeIcon
									className="sm:mr-1.5 size-3"
									icon={faWandMagicSparkles}
								/>
								<span className="hidden sm:inline">
									{isBulkAiRunning ? "Boshlanmoqda..." : "To'liq AI tahlil"}
								</span>
							</Button>
						)}
						<Button
							variant="destructive"
							onClick={() => setConfirmOpen(true)}
							disabled={isDeleting || isMoving}
							className="size-[40px] min-w-[unset] p-0"
							size="sm"
						>
							<FontAwesomeIcon className="w-3.5 text-white" icon={faTrash} />
						</Button>
						<ConfirmationDialog
							open={confirmOpen}
							icon={<FontAwesomeIcon icon={faFilm} />}
							title="Delete selected Caps"
							description={`Are you sure you want to delete ${
								selectedCaps.length
							} cap${
								selectedCaps.length === 1 ? "" : "s"
							}? This action cannot be undone.`}
							confirmLabel={isDeleting ? "Deleting..." : "Delete"}
							cancelLabel="Cancel"
							confirmVariant="dark"
							loading={isDeleting}
							onConfirm={handleConfirmDelete}
							onCancel={() => setConfirmOpen(false)}
						/>
						{/* The one price-confirm before a bulk AI start; the loop itself
						    lives in lib/bulk-ai.ts and never sends reprocess:true.
						    Rendered only while the bulk buttons are visible (F7). */}
						{bulkButtons.visible && bulkAiMode && bulkPlan && (
							<BulkAiConfirmDialog
								mode={bulkAiMode}
								plan={bulkPlan}
								running={isBulkAiRunning}
								onStart={() => void startBulkAi()}
								onCancel={() => {
									if (!isBulkAiRunning) setBulkAiMode(null);
								}}
							/>
						)}
						{/* The strong confirmation the owner asked for (2026-08-05) when he
						    chose immediate deletion over a recoverable trash: the exact
						    count, the titles themselves, and a plain statement that the
						    video does not come back. Cancel is rendered first inside the
						    dialog, so the destructive button is never the focused default. */}
						<ConfirmationDialog
							open={confirmAudioOpen}
							icon={<FontAwesomeIcon icon={faVolumeHigh} />}
							title="Replace with audio — the video is deleted"
							description={
								<>
									<span className="block">
										{replaceableCaps.length === 1
											? "This recording keeps only its sound. Its video is deleted permanently and cannot be restored:"
											: `These ${replaceableCaps.length} recordings keep only their sound. Their videos are deleted permanently and cannot be restored:`}
									</span>
									<span className="mt-2 block max-h-40 overflow-y-auto">
										{replaceableCaps.map((cap) => (
											<span
												key={cap.id}
												className="block truncate text-gray-12"
												title={cap.name}
											>
												• {cap.name}
											</span>
										))}
									</span>
								</>
							}
							confirmLabel={
								isReplacingWithAudio
									? "Replacing..."
									: `Delete ${replaceableCaps.length} video${
											replaceableCaps.length === 1 ? "" : "s"
										}, keep audio`
							}
							cancelLabel="Cancel"
							confirmVariant="destructive"
							loading={isReplacingWithAudio}
							onConfirm={() => void replaceSelectedWithAudio()}
							onCancel={() => setConfirmAudioOpen(false)}
						/>
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
};
