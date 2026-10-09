"use server";

import { db } from "@cap/database";
import { getCurrentUser } from "@cap/database/auth/session";
import { folders } from "@cap/database/schema";
import type { Folder } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

/**
 * Moves a folder to become a child of `targetFolderId` (or to the root when
 * `targetFolderId` is null). A folder may never become its own ancestor —
 * moving it into itself or into one of its own descendants would orphan the
 * whole subtree and send the breadcrumb walk in `lib/folder.ts` into an
 * infinite loop. That check happens here, on the server, not by hiding menu
 * items client-side.
 */
export async function moveFolderToFolder({
	folderId,
	targetFolderId,
}: {
	folderId: Folder.FolderId;
	targetFolderId: Folder.FolderId | null;
}) {
	const user = await getCurrentUser();
	if (!user || !user.activeOrganizationId)
		throw new Error("Unauthorized or no active organization");

	if (!folderId) throw new Error("Folder ID is required");

	const [folder] = await db()
		.select({
			id: folders.id,
			createdById: folders.createdById,
			organizationId: folders.organizationId,
			parentId: folders.parentId,
		})
		.from(folders)
		.where(eq(folders.id, folderId));

	if (!folder || folder.organizationId !== user.activeOrganizationId) {
		throw new Error("Folder not found or not accessible");
	}

	// Ownership check, same shape as the other folder actions: a user must not
	// move a folder they did not create.
	if (folder.createdById !== user.id) {
		throw new Error("Unauthorized");
	}

	if (targetFolderId) {
		if (targetFolderId === folderId) {
			throw new Error("A folder cannot be moved into itself");
		}

		const [targetFolder] = await db()
			.select({
				id: folders.id,
				organizationId: folders.organizationId,
				parentId: folders.parentId,
			})
			.from(folders)
			.where(eq(folders.id, targetFolderId));

		if (
			!targetFolder ||
			targetFolder.organizationId !== user.activeOrganizationId
		) {
			throw new Error("Folder not found or not accessible");
		}

		// Walk the target's ancestor chain. If `folderId` shows up anywhere in
		// it, the target is a descendant of the folder being moved, and this
		// move would create a cycle.
		let current: {
			id: Folder.FolderId;
			parentId: Folder.FolderId | null;
		} | null = targetFolder;
		const visited = new Set<Folder.FolderId>();

		while (current?.parentId) {
			if (current.parentId === folderId) {
				throw new Error("A folder cannot be moved into its own subfolder");
			}
			if (visited.has(current.parentId)) break; // defensive: pre-existing cycle
			visited.add(current.parentId);

			const [next] = await db()
				.select({ id: folders.id, parentId: folders.parentId })
				.from(folders)
				.where(eq(folders.id, current.parentId));
			current = next ?? null;
		}
	}

	await db()
		.update(folders)
		.set({ parentId: targetFolderId })
		.where(eq(folders.id, folderId));

	revalidatePath(`/dashboard/caps`);
	revalidatePath(`/dashboard/folder/${folderId}`);
	if (folder.parentId) revalidatePath(`/dashboard/folder/${folder.parentId}`);
	if (targetFolderId) revalidatePath(`/dashboard/folder/${targetFolderId}`);

	return { success: true };
}
