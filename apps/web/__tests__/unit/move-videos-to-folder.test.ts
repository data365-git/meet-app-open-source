import { beforeEach, describe, expect, it, vi } from "vitest";

const moveVideoToFolderMock = vi.fn();
vi.mock("@/actions/folders/moveVideoToFolder", () => ({
	moveVideoToFolder: moveVideoToFolderMock,
}));

// P0 — several selected videos must ALL move. The original bug wrapped the
// per-video loop in a try/catch OUTSIDE the loop, so the first failure
// aborted every remaining item and only one video ever moved.
describe("moveVideosToFolder", () => {
	beforeEach(() => {
		// mockReset, NOT clearAllMocks: `clear` only wipes the recorded calls and
		// leaves any queued `...Once` values behind, so the first test's queue
		// bled into the later ones and each of these three passed alone but two
		// failed when run together.
		moveVideoToFolderMock.mockReset();
	});

	it("keeps moving the rest of the selection after one item fails, and reports accurate counts", async () => {
		moveVideoToFolderMock
			.mockResolvedValueOnce(undefined) // video-1 succeeds
			.mockRejectedValueOnce(new Error("Video not found")) // video-2 fails
			.mockResolvedValueOnce(undefined); // video-3 succeeds

		const { moveVideosToFolder } = await import(
			"@/actions/folders/moveVideosToFolder"
		);

		const result = await moveVideosToFolder({
			videoIds: ["video-1", "video-2", "video-3"] as never,
			folderId: "folder-1" as never,
			spaceId: null,
		});

		// The assertion with teeth: a loop that aborts on the first failure would
		// only ever attempt video-1 and video-2, never video-3.
		expect(moveVideoToFolderMock).toHaveBeenCalledTimes(3);
		expect(result.movedCount).toBe(2);
		expect(result.failedCount).toBe(1);
		expect(result.success).toBe(true);
	});

	it("moves every video when nothing fails", async () => {
		moveVideoToFolderMock.mockResolvedValue(undefined);

		const { moveVideosToFolder } = await import(
			"@/actions/folders/moveVideosToFolder"
		);

		const result = await moveVideosToFolder({
			videoIds: ["v1", "v2", "v3", "v4"] as never,
			folderId: "folder-1" as never,
			spaceId: null,
		});

		expect(moveVideoToFolderMock).toHaveBeenCalledTimes(4);
		expect(result.movedCount).toBe(4);
		expect(result.failedCount).toBe(0);
	});

	it("reports failure when every item fails", async () => {
		moveVideoToFolderMock.mockRejectedValue(new Error("Unauthorized"));

		const { moveVideosToFolder } = await import(
			"@/actions/folders/moveVideosToFolder"
		);

		const result = await moveVideosToFolder({
			videoIds: ["v1", "v2"] as never,
			folderId: "folder-1" as never,
			spaceId: null,
		});

		expect(result.movedCount).toBe(0);
		expect(result.failedCount).toBe(2);
		expect(result.success).toBe(false);
	});
});
