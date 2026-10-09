// isVideoDeleted is a POSITIVE signal only: row exists + caller owns it +
// deletedAt set. A missing row, another owner, a live row, no session or any
// error must read false (no existence oracle, no false "cancelled").
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	rows: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: () => mocks.rows() }),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "id", ownerId: "ownerId", deletedAt: "deletedAt" },
}));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("effect", () => ({ Effect: {}, Schedule: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: vi.fn(),
}));
vi.mock("@/lib/video-storage", () => ({ getStorageAccessForVideo: vi.fn() }));

import { isVideoDeleted } from "@/actions/video/trigger-processing";

const id = "vid_1" as never;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getCurrentUser.mockResolvedValue({ id: "u1" });
});

describe("isVideoDeleted", () => {
	it("own + deletedAt set -> true", async () => {
		mocks.rows.mockResolvedValue([{ ownerId: "u1", deletedAt: new Date() }]);
		expect(await isVideoDeleted(id)).toBe(true);
	});
	it("own + live -> false", async () => {
		mocks.rows.mockResolvedValue([{ ownerId: "u1", deletedAt: null }]);
		expect(await isVideoDeleted(id)).toBe(false);
	});
	it("missing row -> false", async () => {
		mocks.rows.mockResolvedValue([]);
		expect(await isVideoDeleted(id)).toBe(false);
	});
	it("other owner (even if deleted) -> false", async () => {
		mocks.rows.mockResolvedValue([{ ownerId: "u2", deletedAt: new Date() }]);
		expect(await isVideoDeleted(id)).toBe(false);
	});
	it("no session -> false", async () => {
		mocks.getCurrentUser.mockResolvedValue(null);
		mocks.rows.mockResolvedValue([{ ownerId: "u1", deletedAt: new Date() }]);
		expect(await isVideoDeleted(id)).toBe(false);
	});
	it("db throws -> false", async () => {
		mocks.rows.mockRejectedValue(new Error("db down"));
		expect(await isVideoDeleted(id)).toBe(false);
	});
});
