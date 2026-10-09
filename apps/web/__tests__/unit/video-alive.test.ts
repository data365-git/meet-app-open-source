import { beforeEach, describe, expect, it, vi } from "vitest";

// One mutable row the mocked db() hands back, so each case can decide what the
// videos table currently says about this id.
let row: { deletedAt: Date | null } | undefined;

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => (row ? [row] : []) }),
			}),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({ videos: { id: "id", deletedAt: "deletedAt" } }));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {
		constructor(message: string) {
			super(message);
			this.name = "FatalError";
		}
	},
}));

describe("assertVideoNotDeleted", () => {
	beforeEach(() => {
		row = undefined;
	});

	it("does nothing for a live video", async () => {
		const { assertVideoNotDeleted } = await import("@/lib/video-alive");
		row = { deletedAt: null };

		await expect(assertVideoNotDeleted("abc123")).resolves.toBeUndefined();
	});

	it("throws for a soft-deleted video, so a running job stops instead of minting COMPLETE", async () => {
		const { assertVideoNotDeleted } = await import("@/lib/video-alive");
		row = { deletedAt: new Date("2026-08-17T18:15:55Z") };

		await expect(assertVideoNotDeleted("abc123")).rejects.toThrow(
			/was deleted/,
		);
	});

	it("throws when the row is gone entirely", async () => {
		const { assertVideoNotDeleted } = await import("@/lib/video-alive");
		row = undefined;

		await expect(assertVideoNotDeleted("abc123")).rejects.toThrow(
			/was deleted/,
		);
	});
});
