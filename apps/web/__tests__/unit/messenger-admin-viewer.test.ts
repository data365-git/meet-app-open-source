import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the privilege-escalation fix in apps/web/lib/messenger/data.ts.
// getViewerContext() used to grant isAdmin by comparing user.email to a hardcoded
// literal ("richie@cap.so"), which anyone could self-register with (no mailbox
// verification). It must now be driven by the DB-backed users.isAdmin flag.

vi.mock("server-only", () => ({}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: vi.fn(),
}));

vi.mock("@cap/database/helpers", () => ({
	nanoIdLong: vi.fn(() => "test-nano-id-long"),
}));

vi.mock("@cap/database/schema", () => ({
	messengerConversations: { id: "id", userId: "userId", anonymousId: "anonymousId" },
	messengerMessages: { id: "id", userId: "userId", anonymousId: "anonymousId" },
	users: { id: "id", email: "email" },
}));

vi.mock("drizzle-orm", () => ({
	and: (...a: unknown[]) => a,
	asc: (f: unknown) => f,
	desc: (f: unknown) => f,
	eq: (f: unknown, v: unknown) => ({ f, v }),
	inArray: (f: unknown, v: unknown) => ({ f, v }),
	isNull: (f: unknown) => ({ isNull: f }),
}));

const cookiesGetMock = vi.fn(() => undefined as { value: string } | undefined);
vi.mock("next/headers", () => ({
	cookies: vi.fn(async () => ({ get: cookiesGetMock })),
}));

import { getCurrentUser } from "@cap/database/auth/session";

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

describe("getViewerContext (apps/web/lib/messenger/data.ts)", () => {
	let getViewerContext: typeof import("@/lib/messenger/data").getViewerContext;
	let requireAdminViewer: typeof import("@/lib/messenger/data").requireAdminViewer;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("@/lib/messenger/data");
		getViewerContext = mod.getViewerContext;
		requireAdminViewer = mod.requireAdminViewer;
	});

	it("is not admin for a non-admin user whose email is literally richie@cap.so", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "richie@cap.so",
			isAdmin: false,
		});
		const viewer = await getViewerContext();
		expect(viewer.isAdmin).toBe(false);
	});

	it("is not admin for an unrelated non-admin user", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-2",
			email: "someone@example.com",
			isAdmin: false,
		});
		const viewer = await getViewerContext();
		expect(viewer.isAdmin).toBe(false);
	});

	it("is admin only when the DB isAdmin flag is true", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-3",
			email: "someone@example.com",
			isAdmin: true,
		});
		const viewer = await getViewerContext();
		expect(viewer.isAdmin).toBe(true);
	});

	it("requireAdminViewer rejects a non-admin user posing as richie@cap.so", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "richie@cap.so",
			isAdmin: false,
		});
		await expect(requireAdminViewer()).rejects.toThrow("Unauthorized");
	});

	it("requireAdminViewer accepts a DB-flagged admin", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-3",
			email: "someone@example.com",
			isAdmin: true,
		});
		await expect(requireAdminViewer()).resolves.toMatchObject({
			isAdmin: true,
		});
	});
});
