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
	faChevronDown,
	faDownload,
	faEllipsis,
	faFileLines,
	faFilm,
	faFolder,
	faTrash,
	faUsers,
	faVideo,
	faVolumeHigh,
	faWandMagicSparkles,
	faXmark,
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
import { getVideoStatus } from "@/actions/videos/get-status";
import { setVideosLibraryKind } from "@/actions/videos/set-library-kind";
import {
	BULK_AI_MAX_SELECTION,
	type BulkAiMode,
	type BulkAiPlan,
	buildBulkAiResultToast,
	bulkAiButtonState,
	planBulkAi,
	runBulkAiStarts,
	SKIP_REASON_RUNNING,
} from "@/lib/bulk-ai";
import {
	buildBulkTranscriptZip,
	type BulkTranscriptResults,
	bulkTranscriptZipName,
	downloadBlob,
	fetchBulkTranscripts,
	waitForTranscripts,
} from "@/lib/bulk-transcript-zip";
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
	// Bulk transcript download (2026-10-07 spec): null = idle, otherwise the
	// "n/N" progress the AI menu item shows while fetching. Same synchronous
	// ref guard as bulkAiRunningRef so a second click in one tick is ignored.
	// `phase` (2026-10-08 spec) splits the auto-transcribe flow's two stages so
	// the menu item can say "Transkript qilinmoqda" while waiting and
	// "Yuklanmoqda" once the ZIP fetch loop starts.
	const [transcriptDownload, setTranscriptDownload] = useState<{
		phase: "transcribing" | "downloading";
		done: number;
		total: number;
	} | null>(null);
	const transcriptDownloadRef = useRef(false);
	// The transcript-mode plan awaiting the owner's choice in the auto-
	// transcribe-then-download confirm dialog (2026-10-08 spec). Non-null only
	// while that dialog is open; closing it on ANY button clears the state.
	const [transcribePlan, setTranscribePlan] = useState<BulkAiPlan | null>(null);
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

	// One ZIP with one .txt per selected video (admins, 2026-10-07 spec). The
	// sequential fetch loop + ZIP assembly live in lib/bulk-transcript-zip.ts;
	// this only guards against a second press (ref, like bulkAiRunningRef) and
	// reports. One video failing never aborts the batch - it lands in the
	// `transkript-yoq.txt` note inside the ZIP and in the toast.
	// The dropdown item closes the menu on click, so the "n/N" progress is
	// shown in a LOADING TOAST under this fixed id, updated per video and
	// REPLACED by the final success/error toast (same id - sonner swaps it).
	const transcriptToastId = "bulk-transcript-zip";
	// The SHARED download tail of both transcript flows (2026-10-08 review
	// fix 5): progress toast, the sequential transcript fetch, the ZIP and the
	// ONE summary toast. `extraParts` lets the transcribe-then-download flow
	// add its own facts computed from the REAL fetch results (fix 4 — the
	// count of waited ids that actually landed in the ZIP), `finalNote` its
	// budget-stop line; a plain download passes neither.
	const fetchTranscriptZipAndReport = async (
		extraParts: (results: BulkTranscriptResults) => string[] = () => [],
		finalNote: string | null = null,
	): Promise<void> => {
		setTranscriptDownload({
			phase: "downloading",
			done: 0,
			total: bulkCaps.length,
		});
		toast.loading(`Yuklanmoqda 0/${bulkCaps.length}`, {
			id: transcriptToastId,
		});
		const results = await fetchBulkTranscripts(bulkCaps, (done, total) => {
			setTranscriptDownload({ phase: "downloading", done, total });
			toast.loading(`Yuklanmoqda ${done}/${total}`, {
				id: transcriptToastId,
			});
		});
		const blob = await buildBulkTranscriptZip(results);
		if (!blob) {
			// Zero transcripts: no ZIP download, one plain error toast -
			// never an empty archive that looks like success.
			toast.error(
				results.failed.length > 0
					? "Hech bir transkript yuklab olinmadi (xatolik)"
					: "Tanlangan videolarning transkripti yo'q",
				{ id: transcriptToastId },
			);
			return;
		}
		downloadBlob(blob, bulkTranscriptZipName());
		const missingCount = results.missing.length + results.failed.length;
		const summaryParts = [
			`${results.files.length} ta transkript yuklandi`,
			...extraParts(results),
		];
		if (missingCount > 0) {
			summaryParts.push(
				`${missingCount} tasi yo'q (transkript-yoq.txt ichida)`,
			);
		}
		if (finalNote) summaryParts.push(finalNote);
		toast.success(summaryParts.join(" · "), { id: transcriptToastId });
	};

	const downloadTranscriptsZip = async () => {
		if (transcriptDownloadRef.current || bulkCaps.length === 0) return;
		transcriptDownloadRef.current = true;
		try {
			await fetchTranscriptZipAndReport();
		} catch (_error) {
			toast.error("Transkriptlarni yuklab olishda xatolik", {
				id: transcriptToastId,
			});
		} finally {
			transcriptDownloadRef.current = false;
			setTranscriptDownload(null);
		}
	};

	// The menu entry point (2026-10-08 spec, owner option A): plan the same
	// transcript-mode run the "Faqat transkript" button plans. Nothing to
	// transcribe -> exactly the old download-right-away behaviour. Something to
	// transcribe -> the confirm dialog (money is spent only after it).
	const openTranscriptsDownload = () => {
		if (transcriptDownloadRef.current || bulkCaps.length === 0) return;
		const plan = planBulkAi(bulkCaps, "transcript");
		if (plan.toRun.length === 0) {
			void downloadTranscriptsZip();
			return;
		}
		setTranscribePlan(plan);
	};

	// "Transkript qilib yuklab olish" (2026-10-08 spec): start the planned
	// videos with the EXISTING sequential start loop (budget-stop / 403 /
	// failure rules unchanged - `runBulkAiStarts` itself is not touched), wait
	// for the ACCEPTED ones to reach COMPLETE, then run the very same fetch +
	// ZIP path as a plain download. Videos that gave up (terminal error, cap
	// reached) or never started simply answer 404 in that loop and land in the
	// transkript-yoq.txt note, like today.
	const transcribeAndDownload = async () => {
		const plan = transcribePlan;
		// The dialog only ever opens with something to run
		// (`openTranscriptsDownload` guards that), so there is no empty-plan
		// case to handle here (2026-10-08 review fix 5).
		if (!plan || transcriptDownloadRef.current) {
			setTranscribePlan(null);
			return;
		}
		transcriptDownloadRef.current = true;
		setTranscribePlan(null);
		// Leaving the page mid-wait would silently drop the download (the
		// transcription itself keeps running server-side either way), so warn
		// for exactly as long as this flow is in flight.
		const warnOnUnload = (e: BeforeUnloadEvent) => {
			e.preventDefault();
			// Legacy engines only show the dialog when returnValue is set.
			e.returnValue = "";
		};
		window.addEventListener("beforeunload", warnOnUnload);
		let budgetStopNote: string | null = null;
		try {
			setTranscriptDownload({
				phase: "transcribing",
				done: 0,
				total: plan.toRun.length,
			});
			toast.loading(`Transkript qilinmoqda: 0/${plan.toRun.length}`, {
				id: transcriptToastId,
			});
			// `runBulkAiStarts` reports the accepted ids itself
			// (`outcome.startedIds`, fix 1), so this flow waits for exactly the
			// videos the generate route accepted (200, incl. alreadyRunning) -
			// not the 403/500/budget-stopped ones, which would never finish and
			// burn the whole 45-minute cap. No fetch wrapper, no URL sniffing.
			const outcome = await runBulkAiStarts(plan.toRun, "transcript");
			if (outcome.budgetStopped) {
				budgetStopNote = `Oylik AI limiti tugadi - ${outcome.notStartedCount} ta video boshlanmadi`;
			}
			// Also wait for videos already being transcribed (skipped as
			// "ishlanmoqda"): their transcript is minutes away, not missing.
			const waitIds = [
				...outcome.startedIds,
				...plan.skipped
					.filter((sk) => sk.reason === SKIP_REASON_RUNNING)
					.map((sk) => sk.id),
			];
			if (waitIds.length > 0) {
				await waitForTranscripts(
					waitIds,
					// Plain string -> branded Video.VideoId at the boundary; the
					// plan's ids came from the same videos the grid selected.
					(id) => getVideoStatus(id as Video.VideoId),
					{
						intervalMs: 15_000,
						capMs: 45 * 60_000,
						onTick: (done, total) => {
							setTranscriptDownload({
								phase: "transcribing",
								done,
								total,
							});
							toast.loading(`Transkript qilinmoqda: ${done}/${total}`, {
								id: transcriptToastId,
							});
						},
					},
				);
			}
			// Download phase: the SHARED fetch + ZIP + toast path, for the WHOLE
			// selection (the freshly transcribed included).
			await fetchTranscriptZipAndReport((results) => {
				// Fix 4: "N tasi hozir transkript qilindi" counts the waited
				// ids that ACTUALLY landed in the ZIP (by id), not what the
				// wait loop believed done — a transcript that completed but
				// failed to fetch is not a success to brag about.
				const downloadedIds = new Set(results.files.map((f) => f.id));
				const landed = waitIds.filter((id) => downloadedIds.has(id)).length;
				return landed > 0 ? [`${landed} tasi hozir transkript qilindi`] : [];
			}, budgetStopNote);
		} catch (_error) {
			toast.error("Transkriptlarni yuklab olishda xatolik", {
				id: transcriptToastId,
			});
		} finally {
			window.removeEventListener("beforeunload", warnOnUnload);
			transcriptDownloadRef.current = false;
			setTranscriptDownload(null);
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
	// The two bulk-AI menu items lock together while any bar action is in
	// flight or the ceiling is hit; `title` keeps the reason readable (F5).
	const aiItemsDisabled =
		bulkButtons.disabled ||
		isBulkAiRunning ||
		isDeleting ||
		isMoving ||
		isReplacingWithAudio ||
		transcriptDownload !== null;

	return (
		<AnimatePresence>
			{selectedCaps.length > 0 && (
				<motion.div
					className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom,0px))] left-2 right-2 z-50 mx-auto flex w-auto max-w-xl items-center justify-between gap-2 rounded-xl border border-gray-2 bg-gray-1 p-2.5 shadow-lg lg:bottom-12 lg:left-0 lg:right-0 lg:w-full"
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
					<div className="flex min-w-0 flex-col">
						<div className="flex items-center gap-1 text-sm font-medium text-gray-10">
							<NumberFlow
								value={selectedCaps.length}
								className="tabular-nums text-md text-gray-12"
							/>
							<span className="whitespace-nowrap">ta tanlandi</span>
							{/* ✕ clears the selection - the old wide "Cancel" button,
							    now an icon so the three action controls fit 375 px. */}
							<button
								type="button"
								onClick={() => setSelectedCaps([])}
								aria-label="Tanlovni bekor qilish"
								title="Bekor qilish"
								className="ml-0.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-11 transition-colors hover:bg-gray-4 hover:text-gray-12"
							>
								<FontAwesomeIcon className="size-3" icon={faXmark} />
							</button>
						</div>
						{/* F5: the ceiling must be readable text, not a title on a
						    disabled button (phones are a primary device here). */}
						{bulkButtons.visible && bulkButtons.hint && (
							<span className="text-xs leading-tight text-gray-11">
								{bulkButtons.hint}
							</span>
						)}
					</div>
					{/* Owner layout 2026-10-07: ONE row, three controls -
					    [AI ▾] [Ko'chirish ▾] [⋯]. Everything else lives inside the
					    dropdowns; the row itself never wraps or scrolls at 375 px. */}
					<div className="flex flex-nowrap items-center gap-1">
						{/* AI dropdown (admins only): the two bulk-AI actions (ADR
						    2026-10-07, unchanged behaviour + confirm dialog) plus the
						    bulk transcript ZIP download. */}
						{bulkButtons.visible && (
							<DropdownMenu modal={false}>
								<DropdownMenuTrigger asChild>
									<Button
										variant="gray"
										// Not gated by the AI selection ceiling: the ZIP download
										// inside has no ceiling, so the menu must stay openable.
										disabled={
											isBulkAiRunning ||
											isDeleting ||
											isMoving ||
											isReplacingWithAudio
										}
										aria-label="AI amallari"
										title={bulkButtons.hint ?? undefined}
										className="shrink-0 whitespace-nowrap px-2 text-sm"
										size="sm"
									>
										<FontAwesomeIcon
											className="size-3"
											icon={faWandMagicSparkles}
										/>
										AI
										<FontAwesomeIcon
											className="size-2.5 text-gray-11"
											icon={faChevronDown}
										/>
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end" className="min-w-[240px]">
									<DropdownMenuItem
										className="gap-2 rounded-lg"
										disabled={aiItemsDisabled}
										title={bulkButtons.hint ?? undefined}
										onSelect={() => openBulkAiDialog("transcript")}
									>
										<FontAwesomeIcon
											className="size-3 text-gray-11"
											icon={faFileLines}
										/>
										<span>Faqat transkript</span>
									</DropdownMenuItem>
									<DropdownMenuItem
										className="gap-2 rounded-lg"
										disabled={aiItemsDisabled}
										title={bulkButtons.hint ?? undefined}
										onSelect={() => openBulkAiDialog("full")}
									>
										<FontAwesomeIcon
											className="size-3 text-gray-11"
											icon={faWandMagicSparkles}
										/>
										<span>To&apos;liq AI tahlil</span>
									</DropdownMenuItem>
									<DropdownMenuSeparator />
									<DropdownMenuItem
										className="gap-2 rounded-lg"
										disabled={
											transcriptDownload !== null ||
											isBulkAiRunning ||
											isDeleting ||
											isMoving ||
											isReplacingWithAudio
										}
										onSelect={() => openTranscriptsDownload()}
									>
										<FontAwesomeIcon
											className="size-3 text-gray-11"
											icon={faDownload}
										/>
										<span>
											{transcriptDownload
												? transcriptDownload.phase === "transcribing"
													? `Transkript qilinmoqda: ${transcriptDownload.done}/${transcriptDownload.total}`
													: `Yuklanmoqda ${transcriptDownload.done}/${transcriptDownload.total}`
												: "Transkriptlarni yuklab olish"}
										</span>
									</DropdownMenuItem>
								</DropdownMenuContent>
							</DropdownMenu>
						)}
						{/* Ko'chirish ▾ - the existing Move menu, unchanged inside. */}
						{(libraryOptions.length > 0 || folderOptions.length > 0) && (
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										variant="gray"
										disabled={isMoving || isDeleting}
										aria-label="Ko'chirish"
										className="shrink-0 whitespace-nowrap px-2 text-sm"
										size="sm"
									>
										<FontAwesomeIcon className="size-3" icon={faFolder} />
										{isMoving ? "Ko'chirilmoqda" : "Ko'chirish"}
										<FontAwesomeIcon
											className="size-2.5 text-gray-11"
											icon={faChevronDown}
										/>
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
						{/* ⋯ overflow menu: replace-with-audio + delete (red) - the
						    destructive pair no longer sits beside the ordinary
						    buttons on the bar itself; both keep their confirm
						    dialogs. */}
						<DropdownMenu modal={false}>
							<DropdownMenuTrigger asChild>
								<Button
									variant="gray"
									aria-label="Yana amallar"
									className="size-[40px] min-w-[unset] shrink-0 p-0"
									size="sm"
								>
									<FontAwesomeIcon className="w-3.5" icon={faEllipsis} />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent align="end" className="min-w-[220px]">
								{replaceableCaps.length > 0 && (
									<DropdownMenuItem
										className="gap-2 rounded-lg"
										disabled={isDeleting || isMoving || isReplacingWithAudio}
										onSelect={() => setConfirmAudioOpen(true)}
									>
										<FontAwesomeIcon
											className="size-3 text-gray-11"
											icon={faVolumeHigh}
										/>
										<span>Audio bilan almashtirish</span>
									</DropdownMenuItem>
								)}
								<DropdownMenuItem
									className="gap-2 rounded-lg text-red-500 focus:text-red-500 hover:text-red-500"
									disabled={isDeleting || isMoving}
									onSelect={() => setConfirmOpen(true)}
								>
									<FontAwesomeIcon
										className="size-3 text-red-500"
										icon={faTrash}
									/>
									<span>O&apos;chirish</span>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
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
						{/* The transcribe-then-download confirm (2026-10-08 spec): the
						    same price/skip facts, three choices. Over the
						    BULK_AI_MAX_SELECTION ceiling the paid action disappears
						    and only "Faqat tayyorlarini" + "Bekor qilish" remain. */}
						{bulkButtons.visible && transcribePlan && (
							<BulkAiConfirmDialog
								mode="transcript"
								plan={transcribePlan}
								running={false}
								title={`${transcribePlan.toRun.length} ta videoda transkript yo'q. Avval transkript qilib, keyin yuklab olaymi?`}
								confirmLabel="Transkript qilib yuklab olish"
								cancelLabel="Bekor qilish"
								secondary={{
									label: "Faqat tayyorlarini yuklab olish",
									onClick: () => {
										setTranscribePlan(null);
										void downloadTranscriptsZip();
									},
								}}
								hideConfirm={
									transcribePlan.toRun.length > BULK_AI_MAX_SELECTION
								}
								notice={
									transcribePlan.toRun.length > BULK_AI_MAX_SELECTION
										? `Bir martada ${BULK_AI_MAX_SELECTION} tagacha video transkript qilinishi mumkin`
										: undefined
								}
								onStart={() => void transcribeAndDownload()}
								onCancel={() => setTranscribePlan(null)}
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
