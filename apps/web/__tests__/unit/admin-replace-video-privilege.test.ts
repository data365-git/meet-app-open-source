import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the privilege-escalation fix in apps/web/actions/admin/replace-video.ts.
// Both destructive actions here used to gate on `user.email !== MESSENGER_ADMIN_EMAIL`
// (a hardcoded "richie@cap.so" literal), which anyone could self-register with (no
// mailbox verification) to get an admin-only presigned upload URL / CDN invalidation.
// They must now be gated by the shared, DB-backed requireAdmin() helper.

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
	videos: { id: "id", ownerId: "ownerId", bucket: "bucket" },
}));

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({})),
}));

vi.mock("@cap/web-backend", () => ({
	S3Buckets: { getBucketAccess: vi.fn() },
	AwsCredentials: {},
}));

vi.mock("@cap/web-domain", () => ({
	Video: { VideoId: { make: (v: string) => v } },
	S3Bucket: { S3BucketId: { make: (v: string) => v } },
}));

vi.mock("drizzle-orm", () => ({
	eq: (f: unknown, v: unknown) => ({ f, v }),
}));

vi.mock("effect", () => ({
	Effect: { gen: vi.fn() },
	Option: { fromNullable: () => ({ pipe: () => undefined }) },
}));

vi.mock("@/lib/server", () => ({
	runPromise: (x: unknown) => x,
}));

vi.mock("@aws-sdk/client-cloudfront", () => ({
	CloudFrontClient: vi.fn(),
	CreateInvalidationCommand: vi.fn(),
}));

import { getCurrentUser } from "@cap/database/auth/session";

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

describe("admin/replace-video.ts privileged actions", () => {
	let getVideoReplaceUploadUrl: typeof import("@/actions/admin/replace-video").getVideoReplaceUploadUrl;
	let invalidateVideoCache: typeof import("@/actions/admin/replace-video").invalidateVideoCache;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("@/actions/admin/replace-video");
		getVideoReplaceUploadUrl = mod.getVideoReplaceUploadUrl;
		invalidateVideoCache = mod.invalidateVideoCache;
	});

	describe("getVideoReplaceUploadUrl", () => {
		it("rejects a non-admin user whose email is literally richie@cap.so", async () => {
			mockGetCurrentUser.mockResolvedValue({
				id: "user-1",
				email: "richie@cap.so",
				isAdmin: false,
			});
			await expect(getVideoReplaceUploadUrl("video-1")).rejects.toThrow(
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
			await expect(getVideoReplaceUploadUrl("video-1")).rejects.toThrow(
				"Video not found",
			);
		});
	});

	describe("invalidateVideoCache", () => {
		it("rejects a non-admin user whose email is literally richie@cap.so", async () => {
			mockGetCurrentUser.mockResolvedValue({
				id: "user-1",
				email: "richie@cap.so",
				isAdmin: false,
			});
			await expect(invalidateVideoCache("video-1")).rejects.toThrow(
				"Unauthorized",
			);
		});

		it("accepts an isAdmin: true user (passes the auth gate)", async () => {
			mockGetCurrentUser.mockResolvedValue({
				id: "user-2",
				email: "someone@example.com",
				isAdmin: true,
			});
			await expect(invalidateVideoCache("video-1")).rejects.toThrow(
				"Video not found",
			);
		});
	});
});
