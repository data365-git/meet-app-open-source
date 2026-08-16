"use server";

import type { Folder, Space, Video } from "@cap/web-domain";
import { moveVideoToFolder } from "./moveVideoToFolder";

/**
 * Batch variant of moveVideoToFolder. Moves every id independently: one
 * item throwing (permission, missing row, etc.) must never cancel the rest
 * of the selection — the caller gets an accurate moved/failed count instead
 * of a single all-or-nothing toast.
 */
export async function moveVideosToFolder({
	videoIds,
	folderId,
	spaceId,
}: {
	videoIds: Video.VideoId[];
	folderId: Folder.FolderId | null;
	spaceId?: Space.SpaceIdOrOrganisationId | null;
}) {
	if (!videoIds || videoIds.length === 0) {
		return {
			success: false,
			movedCount: 0,
			failedCount: 0,
			error: "No videos provided",
		};
	}

	let movedCount = 0;
	let failedCount = 0;
	let lastError: string | undefined;

	for (const videoId of videoIds) {
		try {
			await moveVideoToFolder({ videoId, folderId, spaceId });
			movedCount++;
		} catch (error) {
			failedCount++;
			lastError =
				error instanceof Error ? error.message : "Failed to move video";
			console.error(`Error moving video ${videoId} to folder:`, error);
		}
	}

	return {
		success: movedCount > 0,
		movedCount,
		failedCount,
		error: failedCount > 0 ? lastError : undefined,
	};
}
