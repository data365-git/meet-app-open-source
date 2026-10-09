"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { sharedVideos, spaceVideos, spaces } from "@cap/database/schema";
import type { Space } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

export async function getSpaceVideoIds(spaceId: Space.SpaceIdOrOrganisationId) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!spaceId) {
			throw new Error("Space ID is required");
		}

		const isAllSpacesEntry = user.activeOrganizationId === spaceId;

		// Membership guard: this is a "use server" action, i.e. a POST endpoint any
		// signed-in user can call with any id. Without this, passing a spaceId from
		// somebody else's organization returned that space's video ids — an
		// enumeration leak. The "all spaces" branch is safe by construction (the id
		// IS the caller's active org), so only the space branch needs the check.
		// Same pattern as getFolderVideoIds, whose comment already cites this leak.
		if (!isAllSpacesEntry) {
			const [space] = await db()
				.select({ id: spaces.id })
				.from(spaces)
				.where(
					and(
						eq(spaces.id, spaceId),
						eq(spaces.organizationId, user.activeOrganizationId),
					),
				);

			if (!space) {
				throw new Error("Space not found or not accessible");
			}
		}

		const videoIds = isAllSpacesEntry
			? await db()
					.select({
						videoId: sharedVideos.videoId,
					})
					.from(sharedVideos)
					.where(
						and(
							eq(sharedVideos.organizationId, spaceId),
							isNull(sharedVideos.folderId),
						),
					)
			: await db()
					.select({
						videoId: spaceVideos.videoId,
					})
					.from(spaceVideos)
					.where(
						and(eq(spaceVideos.spaceId, spaceId), isNull(spaceVideos.folderId)),
					);

		return {
			success: true,
			data: videoIds.map((v) => v.videoId),
		};
	} catch (error) {
		console.error("Error fetching space video IDs:", error);
		return {
			success: false,
			error:
				error instanceof Error ? error.message : "Failed to fetch space videos",
		};
	}
}
