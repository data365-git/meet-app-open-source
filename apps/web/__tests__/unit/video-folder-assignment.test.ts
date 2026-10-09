import { Folder, type Organisation, type Space } from "@cap/web-domain";
import { describe, expect, it } from "vitest";

const FOLDER_ID = "folder-1" as Folder.FolderId;
const ORG_ID = "org-1" as Organisation.OrganisationId;
const SPACE_ID = "space-1" as Space.SpaceId;

describe("resolveVideoFolderAssignment", () => {
	it("does not assign a folder when no folder was requested", () => {
		expect(
			Folder.resolveVideoFolderAssignment({
				folderId: null,
				folderSpaceId: null,
				organizationId: ORG_ID,
			}),
		).toEqual({ type: "none" });
	});

	it("keeps personal folders on videos.folderId", () => {
		expect(
			Folder.resolveVideoFolderAssignment({
				folderId: FOLDER_ID,
				folderSpaceId: null,
				organizationId: ORG_ID,
			}),
		).toEqual({ type: "video", folderId: FOLDER_ID });
	});

	it("routes organization folders through shared_videos.folderId", () => {
		expect(
			Folder.resolveVideoFolderAssignment({
				folderId: FOLDER_ID,
				folderSpaceId: ORG_ID,
				organizationId: ORG_ID,
			}),
		).toEqual({
			type: "organization",
			folderId: FOLDER_ID,
			organizationId: ORG_ID,
		});
	});

	it("routes space folders through space_videos.folderId", () => {
		expect(
			Folder.resolveVideoFolderAssignment({
				folderId: FOLDER_ID,
				folderSpaceId: SPACE_ID,
				organizationId: ORG_ID,
			}),
		).toEqual({
			type: "space",
			folderId: FOLDER_ID,
			spaceId: SPACE_ID,
		});
	});
});
