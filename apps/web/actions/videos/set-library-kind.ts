"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, videos } from "@cap/database/schema";
import type { Video } from "@cap/web-domain";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/**
 * Move videos between the two dashboard libraries: Recordings and Meetings.
 *
 * THE ONE RULE THIS ACTION EXISTS TO KEEP: moving a video writes ONLY the
 * `libraryKind` column. It must never rewrite `videos.source`.
 *
 * `source` is the immutable record of HOW a video was captured, and three
 * unrelated subsystems read `source.type` to decide what to do:
 *   - playback picks the api vs playlist path from it,
 *   - sharing (ShareVideo) resolves the media URLs from it,
 *   - editing (save-edits) decides whether the video is MP4-backed from it.
 * Rewriting it to fake a library membership would leave the moved video
 * unplayable, unshareable and uneditable. So the library is a separate,
 * additive column and `source` is read-only here.
 */

export const LIBRARY_KINDS = ["recording", "meeting"] as const;

export type LibraryKind = (typeof LIBRARY_KINDS)[number];

export type SetVideosLibraryKindResult =
	| { success: true; movedIds: Video.VideoId[] }
	| { success: false; error: string };

/** Guard against an unbounded IN (...) list from a hostile caller. */
const MAX_VIDEOS_PER_MOVE = 500;

function isLibraryKind(value: unknown): value is LibraryKind {
	return (
		typeof value === "string" &&
		(LIBRARY_KINDS as readonly string[]).includes(value)
	);
}

/**
 * Move a LIST of videos into `libraryKind`. Single move = a one-element list.
 *
 * Membership guard: a "use server" action is a POST endpoint any signed-in user
 * can call with any id, so the caller must own each video or be a member of the
 * organization that owns it. Ids that fail the guard are silently skipped
 * rather than reported, so this cannot be used to probe for id existence.
 */
export async function setVideosLibraryKind(
	videoIds: Video.VideoId[],
	libraryKind: LibraryKind,
): Promise<SetVideosLibraryKindResult> {
	try {
		const user = await getCurrentUser();
		if (!user?.id) {
			return { success: false, error: "Unauthorized" };
		}

		if (!isLibraryKind(libraryKind)) {
			return { success: false, error: "Invalid library" };
		}

		const ids = Array.from(
			new Set((Array.isArray(videoIds) ? videoIds : []).filter(Boolean)),
		);
		if (ids.length === 0) {
			return { success: false, error: "No videos selected" };
		}
		if (ids.length > MAX_VIDEOS_PER_MOVE) {
			return {
				success: false,
				error: `Cannot move more than ${MAX_VIDEOS_PER_MOVE} videos at once`,
			};
		}

		const memberships = await db()
			.select({ organizationId: organizationMembers.organizationId })
			.from(organizationMembers)
			.where(eq(organizationMembers.userId, user.id));

		const memberOrgIds = memberships.map((m) => m.organizationId);

		const allowed = await db()
			.select({ id: videos.id })
			.from(videos)
			.where(
				and(
					inArray(videos.id, ids),
					isNull(videos.deletedAt),
					memberOrgIds.length > 0
						? or(
								eq(videos.ownerId, user.id),
								inArray(videos.orgId, memberOrgIds),
							)
						: eq(videos.ownerId, user.id),
				),
			);

		const movedIds = allowed.map((v) => v.id);
		if (movedIds.length === 0) {
			return { success: false, error: "No videos found or not accessible" };
		}

		// The whole point of this action: ONE column in the SET clause.
		await db()
			.update(videos)
			.set({ libraryKind })
			.where(inArray(videos.id, movedIds));

		revalidatePath("/dashboard/caps");
		revalidatePath("/dashboard/meetings");
		for (const id of movedIds) {
			revalidatePath(`/s/${id}`);
		}

		return { success: true, movedIds };
	} catch (error) {
		console.error("Error moving videos between libraries:", error);
		return {
			success: false,
			error:
				error instanceof Error ? error.message : "Failed to move videos",
		};
	}
}
