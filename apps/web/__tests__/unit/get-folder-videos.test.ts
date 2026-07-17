import { beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentUserMock = vi.fn();
const whereMock = vi.fn();
const selectMock = vi.fn(() => ({
	from: vi.fn(() => ({
		where: whereMock,
	})),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: selectMock,
	}),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: getCurrentUserMock,
}));

vi.mock("server-only", () => ({}));

// P3.2 — getFolderVideoIds must not leak video IDs from a folder belonging to
// an org/space the caller isn't a member of (ID-enumeration leak).
describe("getFolderVideoIds", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects a caller who is not a member of the folder's organization", async () => {
		getCurrentUserMock.mockResolvedValueOnce({
			id: "user-1",
			activeOrganizationId: "org-attacker",
		});
		// Folder lookup scoped to the caller's org finds nothing, because the
		// folder actually belongs to a different org.
		whereMock.mockResolvedValueOnce([]);

		const { getFolderVideoIds } = await import(
			"@/actions/folders/get-folder-videos"
		);

		const result = await getFolderVideoIds(
			"folder-1" as never,
			"org-attacker" as never,
		);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Folder not found or not accessible");
	});

	it("returns video ids for a caller who is a member of the folder's organization", async () => {
		getCurrentUserMock.mockResolvedValueOnce({
			id: "user-1",
			activeOrganizationId: "org-owner",
		});
		whereMock
			.mockResolvedValueOnce([{ id: "folder-1" }])
			.mockResolvedValueOnce([{ id: "video-1" }, { id: "video-2" }]);

		const { getFolderVideoIds } = await import(
			"@/actions/folders/get-folder-videos"
		);

		const result = await getFolderVideoIds(
			"folder-1" as never,
			"org-owner" as never,
		);

		expect(result.success).toBe(true);
		expect(result.data).toEqual(["video-1", "video-2"]);
	});
});
