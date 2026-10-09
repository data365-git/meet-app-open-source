import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUserMock = vi.fn();

// Each test pushes the rows its `db().select()...where()` calls should
// resolve to, in call order.
const whereQueue: unknown[] = [];
const selectMock = vi.fn(() => ({
	from: vi.fn(() => ({
		where: vi.fn(() => Promise.resolve(whereQueue.shift() ?? [])),
	})),
}));
const updateWhereMock = vi.fn(() => Promise.resolve());
const updateSetMock = vi.fn(() => ({ where: updateWhereMock }));
const updateMock = vi.fn(() => ({ set: updateSetMock }));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: selectMock,
		update: updateMock,
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: getCurrentUserMock,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const USER = { id: "user-1", activeOrganizationId: "org-1" };

describe("moveFolderToFolder", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		whereQueue.length = 0;
		getCurrentUserMock.mockResolvedValue(USER);
	});

	it("rejects moving a folder into itself", async () => {
		whereQueue.push([
			{
				id: "folder-a",
				createdById: "user-1",
				organizationId: "org-1",
				parentId: null,
			},
		]);

		const { moveFolderToFolder } = await import(
			"@/actions/folders/moveFolderToFolder"
		);

		await expect(
			moveFolderToFolder({
				folderId: "folder-a" as never,
				targetFolderId: "folder-a" as never,
			}),
		).rejects.toThrow("A folder cannot be moved into itself");
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("rejects moving a folder directly into its own child", async () => {
		// folder-a is the folder being moved; folder-b is its direct child.
		whereQueue.push(
			[
				{
					id: "folder-a",
					createdById: "user-1",
					organizationId: "org-1",
					parentId: null,
				},
			],
			[{ id: "folder-b", organizationId: "org-1", parentId: "folder-a" }],
		);

		const { moveFolderToFolder } = await import(
			"@/actions/folders/moveFolderToFolder"
		);

		await expect(
			moveFolderToFolder({
				folderId: "folder-a" as never,
				targetFolderId: "folder-b" as never,
			}),
		).rejects.toThrow("A folder cannot be moved into its own subfolder");
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("rejects moving a folder into a deeper grandchild", async () => {
		// Chain: folder-a -> folder-b -> folder-c. Moving folder-a into folder-c
		// must be rejected even though folder-c is not a DIRECT child.
		whereQueue.push(
			[
				{
					id: "folder-a",
					createdById: "user-1",
					organizationId: "org-1",
					parentId: null,
				},
			],
			[{ id: "folder-c", organizationId: "org-1", parentId: "folder-b" }],
			[{ parentId: "folder-a" }], // ancestor lookup for folder-b
		);

		const { moveFolderToFolder } = await import(
			"@/actions/folders/moveFolderToFolder"
		);

		await expect(
			moveFolderToFolder({
				folderId: "folder-a" as never,
				targetFolderId: "folder-c" as never,
			}),
		).rejects.toThrow("A folder cannot be moved into its own subfolder");
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("rejects moving a folder the caller does not own", async () => {
		whereQueue.push([
			{
				id: "folder-a",
				createdById: "someone-else",
				organizationId: "org-1",
				parentId: null,
			},
		]);

		const { moveFolderToFolder } = await import(
			"@/actions/folders/moveFolderToFolder"
		);

		await expect(
			moveFolderToFolder({
				folderId: "folder-a" as never,
				targetFolderId: null,
			}),
		).rejects.toThrow("Unauthorized");
		expect(updateMock).not.toHaveBeenCalled();
	});

	it("allows moving a folder into an unrelated folder", async () => {
		whereQueue.push(
			[
				{
					id: "folder-a",
					createdById: "user-1",
					organizationId: "org-1",
					parentId: null,
				},
			],
			[{ id: "folder-x", organizationId: "org-1", parentId: null }],
		);

		const { moveFolderToFolder } = await import(
			"@/actions/folders/moveFolderToFolder"
		);

		const result = await moveFolderToFolder({
			folderId: "folder-a" as never,
			targetFolderId: "folder-x" as never,
		});

		expect(result.success).toBe(true);
		expect(updateSetMock).toHaveBeenCalledWith({ parentId: "folder-x" });
	});
});
