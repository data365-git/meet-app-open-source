"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { folders } from "@cap/database/schema";
import type { Folder } from "@cap/web-domain";
import { eq } from "drizzle-orm";

/**
 * Folders a given folder could legally be moved into: every folder in the
 * caller's org, minus the folder itself and everything beneath it. Purely a
 * UI convenience so the "Move to folder" menu doesn't even offer a cyclical
 * destination — moveFolderToFolder.ts still re-checks this on the server,
 * since a stale client list must never be the only guard.
 */
export async function listMovableFolders(folderId: Folder.FolderId) {
	const user = await getCurrentUser();
	if (!user || !user.activeOrganizationId) {
		return { success: false as const, error: "Unauthorized", data: [] };
	}

	const orgFolders = await db()
		.select({
			id: folders.id,
			name: folders.name,
			parentId: folders.parentId,
		})
		.from(folders)
		.where(eq(folders.organizationId, user.activeOrganizationId));

	const descendantIds = new Set<string>();
	let frontier: string[] = [folderId as string];
	while (frontier.length > 0) {
		const children = orgFolders.filter(
			(f) => f.parentId && frontier.includes(f.parentId),
		);
		frontier = children
			.map((c) => c.id as string)
			.filter((id) => !descendantIds.has(id));
		for (const id of frontier) descendantIds.add(id);
	}

	const data = orgFolders
		.filter((f) => f.id !== folderId && !descendantIds.has(f.id as string))
		.map((f) => ({
			id: f.id as Folder.FolderId,
			name: f.name,
			parentId: f.parentId,
		}));

	return { success: true as const, data };
}
