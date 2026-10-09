"use client";

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@cap/ui";
import type { Folder } from "@cap/web-domain";
import {
	faArrowLeft,
	faArrowRightArrowLeft,
	faCopy,
	faEllipsis,
	faFolder,
	faGlobe,
	faPencil,
	faTrash,
} from "@fortawesome/free-solid-svg-icons";
import { FontAwesomeIcon } from "@fortawesome/react-fontawesome";
import { useRouter } from "next/navigation";
import type { RefObject } from "react";
import { useState } from "react";
import { toast } from "sonner";
import { listMovableFolders } from "@/actions/folders/list-movable-folders";
import { moveFolderToFolder } from "@/actions/folders/moveFolderToFolder";

interface FoldersDropdownProps {
	id: string;
	setIsRenaming: (isRenaming: boolean) => void;
	setConfirmDeleteFolderOpen: (open: boolean) => void;
	nameRef: RefObject<HTMLTextAreaElement | null>;
	parentId?: string | null;
	public: boolean;
	onPublicToggle: () => void;
	onCopyPublicLink: () => void;
}

export const FoldersDropdown = ({
	id,
	setIsRenaming,
	setConfirmDeleteFolderOpen,
	nameRef,
	parentId,
	public: isPublic,
	onPublicToggle,
	onCopyPublicLink,
}: FoldersDropdownProps) => {
	const router = useRouter();
	const [moveMenuOpen, setMoveMenuOpen] = useState(false);
	const [isLoadingFolders, setIsLoadingFolders] = useState(false);
	const [isMoving, setIsMoving] = useState(false);
	const [moveOptions, setMoveOptions] = useState<
		{ id: Folder.FolderId; name: string }[]
	>([]);

	const openMoveMenu = async () => {
		setMoveMenuOpen(true);
		setIsLoadingFolders(true);
		try {
			const result = await listMovableFolders(id as Folder.FolderId);
			if (result.success) {
				setMoveOptions(result.data.map((f) => ({ id: f.id, name: f.name })));
			} else {
				toast.error(result.error ?? "Failed to load folders");
				setMoveOptions([]);
			}
		} catch (_error) {
			toast.error("Failed to load folders");
			setMoveOptions([]);
		} finally {
			setIsLoadingFolders(false);
		}
	};

	const moveTo = async (targetFolderId: Folder.FolderId | null) => {
		if (isMoving) return;
		setIsMoving(true);
		try {
			await moveFolderToFolder({
				folderId: id as Folder.FolderId,
				targetFolderId,
			});
			toast.success("Folder moved");
			router.refresh();
		} catch (error) {
			toast.error(
				error instanceof Error ? error.message : "Failed to move folder",
			);
		} finally {
			setIsMoving(false);
			setMoveMenuOpen(false);
		}
	};

	return (
		<DropdownMenu
			onOpenChange={(open) => {
				if (!open) setMoveMenuOpen(false);
			}}
		>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
					}}
					onMouseEnter={(e) => e.stopPropagation()}
					onMouseLeave={(e) => e.stopPropagation()}
					className="flex justify-center items-center rounded-full border transition-colors duration-200
            size-8 bg-gray-5 border-gray-7 hover:bg-gray-7 hover:border-gray-9 data-[state=open]:bg-gray-7 data-[state=open]:border-gray-9"
				>
					<FontAwesomeIcon className="text-gray-12 size-4" icon={faEllipsis} />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent>
				{moveMenuOpen ? (
					<>
						<DropdownMenuItem
							className="gap-2 rounded-lg"
							onClick={() => setMoveMenuOpen(false)}
							// Same reason as `keepMenuOpen` below: without this, "Back"
							// closed the whole menu instead of returning to it.
							onSelect={(e) => e.preventDefault()}
						>
							<FontAwesomeIcon
								className="text-gray-10 size-3"
								icon={faArrowLeft}
							/>
							Back
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>Move to folder</DropdownMenuLabel>
						{isLoadingFolders && (
							<DropdownMenuItem disabled className="rounded-lg">
								Loading...
							</DropdownMenuItem>
						)}
						{!isLoadingFolders && parentId && (
							<DropdownMenuItem
								className="gap-2 rounded-lg"
								onClick={() => void moveTo(null)}
							>
								<FontAwesomeIcon
									className="text-gray-10 size-3"
									icon={faFolder}
								/>
								Top level
							</DropdownMenuItem>
						)}
						{!isLoadingFolders && moveOptions.length === 0 && (
							<DropdownMenuItem disabled className="rounded-lg">
								No other folders available
							</DropdownMenuItem>
						)}
						{!isLoadingFolders &&
							moveOptions.map((folder) => (
								<DropdownMenuItem
									key={folder.id}
									className="gap-2 rounded-lg"
									onClick={() => void moveTo(folder.id)}
								>
									<FontAwesomeIcon
										className="text-gray-10 size-3"
										icon={faFolder}
									/>
									<span className="truncate">{folder.name}</span>
								</DropdownMenuItem>
							))}
					</>
				) : (
					(() => {
						type FolderDropdownItem = {
							label: string;
							icon: typeof faPencil;
							onClick: () => void | Promise<void>;
							// Radix closes the menu on select unless the handler calls
							// preventDefault. Without this the "Move to folder" item set
							// its state and the root closed in the same tick, so the
							// submenu never rendered and the whole feature was dead —
							// invisible to tsc, to 1457 tests and to a real build,
							// because nothing renders this component in a test.
							keepMenuOpen?: boolean;
						};
						const items: FolderDropdownItem[] = [
							{
								label: "Rename",
								icon: faPencil,
								onClick: () => {
									setIsRenaming(true);
									setTimeout(() => {
										nameRef.current?.focus();
										nameRef.current?.select();
									}, 0);
								},
							},
							{
								label: "Move to folder",
								icon: faArrowRightArrowLeft,
								onClick: () => void openMoveMenu(),
								keepMenuOpen: true,
							},
							{
								label: isPublic ? "Make private" : "Make public",
								icon: faGlobe,
								onClick: onPublicToggle,
							},
							...(isPublic
								? [
										{
											label: "Copy public link",
											icon: faCopy,
											onClick: onCopyPublicLink,
										},
									]
								: []),
							{
								label: "Delete",
								icon: faTrash,
								onClick: () => setConfirmDeleteFolderOpen(true),
							},
						];
						return items.map((item) => (
							<DropdownMenuItem
								key={item.label}
								onClick={item.onClick}
								onSelect={(e) => {
									if (item.keepMenuOpen) e.preventDefault();
								}}
								className="rounded-lg"
							>
								<FontAwesomeIcon
									className="mr-1.5 text-gray-10 size-3"
									icon={item.icon}
								/>
								{item.label}
							</DropdownMenuItem>
						));
					})()
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
};
