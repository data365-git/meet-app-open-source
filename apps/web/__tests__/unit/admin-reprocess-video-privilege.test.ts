import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the privilege-escalation fix in apps/web/actions/admin/reprocess-video.ts.
// adminReprocessVideo() used to gate on `user.email !== MESSENGER_ADMIN_EMAIL` (a
// hardcoded "richie@cap.so" literal), which anyone could self-register with (no
// mailbox verification) to trigger an admin-only reprocess workflow. It must now be
// gated by the shared, DB-backed requireAdmin() helper.

vi.mock("server-only", () => ({}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: vi.fn(() => ({
		select: () => ({
			from: () => ({
				where: async () => [] as unknown[],
			}),
		}),
	})),
}));

vi.mock("@cap/database/schema", () => ({
	videos: { id: "id", ownerId: "ownerId", name: "name" },
	videoUploads: {},
}));

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({})),
}));

vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (v: string) => v } },
}));

vi.mock("drizzle-orm", () => ({
	eq: (f: unknown, v: unknown) => ({ f, v }),
}));

vi.mock("next/server", () => ({
	after: (fn: () => void) => fn(),
}));

vi.mock("@/workflows/admin-reprocess-video", () => ({
	adminReprocessVideoWorkflow: vi.fn(async () => undefined),
}));

import { getCurrentUser } from "@cap/database/auth/session";

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

describe("admin/reprocess-video.ts adminReprocessVideo", () => {
	let adminReprocessVideo: typeof import("@/actions/admin/reprocess-video").adminReprocessVideo;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("@/actions/admin/reprocess-video");
		adminReprocessVideo = mod.adminReprocessVideo;
	});

	it("rejects a non-admin user whose email is literally richie@cap.so", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "richie@cap.so",
			isAdmin: false,
		});
		await expect(adminReprocessVideo("video-1")).rejects.toThrow(
			"Unauthorized",
		);
	});

	it("accepts an isAdmin: true user (passes the auth gate)", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-2",
			email: "someone@example.com",
			isAdmin: true,
		});
		// Passes requireAdmin and proceeds to the (unrelated) "video not found"
		// failure, proving the privileged gate itself let it through.
		await expect(adminReprocessVideo("video-1")).rejects.toThrow(
			"Video not found",
		);
	});
});
