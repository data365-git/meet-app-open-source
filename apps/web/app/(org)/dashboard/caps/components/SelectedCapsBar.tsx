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
	faFilm,
	faFolder,
	faTrash,
	faUsers,
	faVideo,
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
}

import type { Folder, Video } from "@cap/web-domain";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { moveVideoToFolder } from "@/actions/folders/moveVideoToFolder";
import { setVideosLibraryKind } from "@/actions/videos/set-library-kind";
import type { LibraryKind } from "@/lib/library-kind";
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
}: SelectedCapsBarProps) => {
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [isMoving, setIsMoving] = useState(false);
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
			for (const videoId of ids) {
				await moveVideoToFolder({
					videoId,
					folderId: folder.id as Folder.FolderId,
					spaceId: folder.spaceId ?? null,
				});
			}
			toast.success(`Moved ${countLabel} to ${folder.name}`);
			setSelectedCaps([]);
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to move to folder",
			);
		} finally {
			setIsMoving(false);
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
					<div className="flex gap-1 text-sm font-medium text-gray-10">
						<NumberFlow
							value={selectedCaps.length}
							className="tabular-nums text-md text-gray-12"
						/>
						cap{selectedCaps.length !== 1 ? "s" : ""} selected
					</div>
					<div className="flex gap-2 ml-4">
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
					</div>
				</motion.div>
			)}
		</AnimatePresence>
	);
};
