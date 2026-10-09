"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { organizationMembers, sharedVideos } from "@cap/database/schema";
import type { Organisation } from "@cap/web-domain";
import { and, eq, isNull } from "drizzle-orm";

export async function getOrganizationVideoIds(
	organizationId: Organisation.OrganisationId,
) {
	try {
		const user = await getCurrentUser();

		if (!user || !user.id) {
			throw new Error("Unauthorized");
		}

		if (!organizationId) {
			throw new Error("Organization ID is required");
		}

		// Membership guard: a "use server" action is a POST endpoint any signed-in
		// user can call with any id, so checking only that SOMEONE is logged in let
		// them enumerate the shared-video ids of an organization they do not belong
		// to. Same authorization pattern as removeVideosFromOrganization in this
		// directory, and the guard getFolderVideoIds already carries.
		const [membership] = await db()
			.select({ userId: organizationMembers.userId })
			.from(organizationMembers)
			.where(
				and(
					eq(organizationMembers.userId, user.id),
					eq(organizationMembers.organizationId, organizationId),
				),
			);

		if (!membership) {
			throw new Error("Organization not found or not accessible");
		}

		const videoIds = await db()
			.select({
				videoId: sharedVideos.videoId,
			})
			.from(sharedVideos)
			.where(
				and(
					eq(sharedVideos.organizationId, organizationId),
					isNull(sharedVideos.folderId),
				),
			);

		return {
			success: true,
			data: videoIds.map((v) => v.videoId),
		};
	} catch (error) {
		console.error("Error fetching organization video IDs:", error);
		return {
			success: false,
			error:
				error instanceof Error
					? error.message
					: "Failed to fetch organization videos",
		};
	}
}
