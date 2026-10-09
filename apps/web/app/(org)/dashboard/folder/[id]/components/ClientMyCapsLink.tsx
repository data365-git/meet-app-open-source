"use client";

import type { Space, Video } from "@cap/web-domain";
import clsx from "clsx";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { moveVideoToFolder } from "@/actions/folders/moveVideoToFolder";
import { SignedImageUrl } from "@/components/SignedImageUrl";
import { useDashboardContext } from "../../../Contexts";
import { registerDropTarget } from "./ClientCapCard";

export function ClientMyCapsLink({
	spaceId,
}: {
	spaceId?: Space.SpaceIdOrOrganisationId;
}) {
	const [isDragOver, setIsDragOver] = useState(false);
	const [isMovingVideo, setIsMovingVideo] = useState(false);
	const linkRef = useRef<HTMLAnchorElement>(null);
	const router = useRouter();
	const { activeSpace } = useDashboardContext();

	const processDrop = useCallback(
		async (capData: {
			id: Video.VideoId;
			name: string;
			ids?: Video.VideoId[];
		}) => {
			setIsDragOver(false);

			try {
				if (!capData || !capData.id) {
					console.error("Invalid cap data");
					return;
				}

				// A card dragged out of a multi-selection carries every selected id on
				// the payload. Move all of them — otherwise this target would silently
				// take one video and leave the rest behind while reporting success.
				// A single card has `ids` of length 1 (or none), so this is unchanged.
				const ids =
					capData.ids && capData.ids.length > 0 ? capData.ids : [capData.id];

				setIsMovingVideo(true);

				for (const videoId of ids) {
					await moveVideoToFolder({
						videoId,
						folderId: null,
						spaceId: spaceId ?? null,
					});
				}
				router.refresh();
				const destination = activeSpace
					? `"${activeSpace.name}"`
					: "Instructional recordings";
				toast.success(
					ids.length > 1
						? `Moved ${ids.length} caps to ${destination}`
						: `Moved "${capData.name}" to ${destination}`,
				);
			} catch (error) {
				console.error("Error moving video:", error);
				toast.error("Failed to move video");
			} finally {
				setIsMovingVideo(false);
			}
		},
		[spaceId, router, activeSpace],
	);

	const handleDrop = useCallback(
		async (
			e:
				| React.DragEvent<HTMLAnchorElement>
				| { id: Video.VideoId; name: string; ids?: Video.VideoId[] },
		) => {
			if ("preventDefault" in e) {
				e.preventDefault();

				try {
					const capData: {
						id?: Video.VideoId;
						name?: string;
						ids?: Video.VideoId[];
					} = JSON.parse(e.dataTransfer.getData("application/cap"));

					if (!capData || !capData.id) {
						console.error("Invalid cap data");
						return;
					}

					await processDrop({
						id: capData.id,
						name: capData.name ?? "",
						ids: capData.ids,
					});
				} catch (error) {
					console.error("Error processing drop:", error);
					toast.error("Failed to move video");
				}
			} else {
				await processDrop(e);
			}
		},
		[processDrop],
	);

	const handleDragOver = (e: React.DragEvent<HTMLAnchorElement>) => {
		e.preventDefault();

		if (e.dataTransfer.types.includes("application/cap")) {
			setIsDragOver(true);
		}
	};

	const handleDragLeave = () => {
		setIsDragOver(false);
	};

	useEffect(() => {
		if (!linkRef.current) return;

		const unregister = registerDropTarget(linkRef.current, (data) => {
			if (data && data.type === "application/cap") {
				handleDrop({ id: data.id, name: data.name, ids: data.ids });
			}
		});

		return () => {
			unregister();
		};
	}, [handleDrop]);

	return (
		<Link
			ref={linkRef}
			href={spaceId ? `/dashboard/spaces/${spaceId}` : "/dashboard/caps"}
			className={clsx(
				"text-xl whitespace-nowrap flex items-center gap-1.5 transition-colors duration-200 hover:text-gray-12",
				isDragOver ? "text-blue-10" : "text-gray-9",
				isMovingVideo && "opacity-70",
				"drag-target", // Add a class for styling when used as a drop target
			)}
			onDragOver={handleDragOver}
			onDragLeave={handleDragLeave}
			onDrop={handleDrop}
		>
			{activeSpace && (
				<SignedImageUrl
					image={activeSpace.iconUrl}
					name={activeSpace.name}
					letterClass="text-xs"
					className="relative flex-shrink-0 size-5"
				/>
			)}
			{activeSpace ? activeSpace.name : "Instructional recordings"}
		</Link>
	);
}
