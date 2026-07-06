import { db } from "@cap/database";
import { folders } from "@cap/database/schema";
import { Folder, type Organisation } from "@cap/web-domain";
import { and, eq } from "drizzle-orm";

export async function resolveVideoFolderAssignment({
	folderId,
	orgId,
}: {
	folderId?: Folder.FolderId;
	orgId: Organisation.OrganisationId;
}) {
	if (!folderId) {
		return Folder.resolveVideoFolderAssignment({
			folderId: null,
			folderSpaceId: null,
			organizationId: orgId,
		});
	}

	const [folder] = await db()
		.select({
			spaceId: folders.spaceId,
		})
		.from(folders)
		.where(and(eq(folders.id, folderId), eq(folders.organizationId, orgId)))
		.limit(1);

	return Folder.resolveVideoFolderAssignment({
		folderId,
		folderSpaceId: folder?.spaceId ?? null,
		organizationId: orgId,
	});
}
