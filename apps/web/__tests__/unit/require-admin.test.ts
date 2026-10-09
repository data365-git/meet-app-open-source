import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the privilege-escalation fix: admin gating must be based
// on the DB-backed users.isAdmin flag, never on a hardcoded email literal.
// Anyone could previously self-register with richie@cap.so (no mailbox
// verification) and pass the old `user.email === MESSENGER_ADMIN_EMAIL` check.

vi.mock("server-only", () => ({}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

import { getCurrentUser } from "@cap/database/auth/session";

const mockGetCurrentUser = getCurrentUser as ReturnType<typeof vi.fn>;

describe("requireAdmin (apps/web/lib/admin/require-admin.ts)", () => {
	let requireAdmin: typeof import("@/lib/admin/require-admin").requireAdmin;

	beforeEach(async () => {
		vi.clearAllMocks();
		const mod = await import("@/lib/admin/require-admin");
		requireAdmin = mod.requireAdmin;
	});

	it("rejects when there is no signed-in user", async () => {
		mockGetCurrentUser.mockResolvedValue(null);
		await expect(requireAdmin()).rejects.toThrow("Unauthorized");
	});

	it("rejects a non-admin user whose email is literally richie@cap.so", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-1",
			email: "richie@cap.so",
			isAdmin: false,
		});
		await expect(requireAdmin()).rejects.toThrow("Unauthorized");
	});

	it("rejects a non-admin user with an unrelated email", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-2",
			email: "someone@example.com",
			isAdmin: false,
		});
		await expect(requireAdmin()).rejects.toThrow("Unauthorized");
	});

	it("accepts a user with isAdmin: true regardless of email", async () => {
		mockGetCurrentUser.mockResolvedValue({
			id: "user-3",
			email: "someone@example.com",
			isAdmin: true,
		});
		await expect(requireAdmin()).resolves.toMatchObject({ isAdmin: true });
	});
});
