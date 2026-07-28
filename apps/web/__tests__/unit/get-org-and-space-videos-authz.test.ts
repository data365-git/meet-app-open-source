import { organizationMembers, spaces } from "@cap/database/schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Twins of the P3.2 leak already fixed in get-folder-videos.ts. A "use server"
// action is a POST endpoint any signed-in user can call with any id, so checking
// only "is someone logged in" is authentication, not authorization: both actions
// below used to return another organization's video ids to any account.
//
// Spy on the REAL `eq` (don't stub it out) so we can assert WHICH columns the
// guard filters on — the db fakes ignore the predicate entirely, so an error
// branch alone proves nothing.
const { eqSpy } = vi.hoisted(() => ({ eqSpy: vi.fn() }));
vi.mock("drizzle-orm", async (importOriginal) => {
	const actual = await importOriginal<typeof import("drizzle-orm")>();
	return {
		...actual,
		eq: (...args: Parameters<typeof actual.eq>) => {
			eqSpy(...args);
			return actual.eq(...args);
		},
	};
});

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

describe("getOrganizationVideoIds", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects a caller who is not a member of the organization", async () => {
		getCurrentUserMock.mockResolvedValueOnce({
			id: "user-attacker",
			activeOrganizationId: "org-attacker",
		});
		// Membership lookup finds nothing: the caller does not belong to org-victim.
		whereMock.mockResolvedValueOnce([]);

		const { getOrganizationVideoIds } = await import(
			"@/actions/organizations/get-organization-videos"
		);

		const result = await getOrganizationVideoIds("org-victim" as never);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Organization not found or not accessible");

		// The assertion with teeth: prove the lookup is scoped to BOTH the caller
		// and the requested org. A guard keyed on only one of them would still leak.
		expect(eqSpy).toHaveBeenCalledWith(
			organizationMembers.userId,
			"user-attacker",
		);
		expect(eqSpy).toHaveBeenCalledWith(
			organizationMembers.organizationId,
			"org-victim",
		);
	});

	it("returns video ids for a caller who IS a member", async () => {
		getCurrentUserMock.mockResolvedValueOnce({
			id: "user-1",
			activeOrganizationId: "org-owner",
		});
		whereMock
			.mockResolvedValueOnce([{ userId: "user-1" }])
			.mockResolvedValueOnce([{ videoId: "video-1" }, { videoId: "video-2" }]);

		const { getOrganizationVideoIds } = await import(
			"@/actions/organizations/get-organization-videos"
		);

		const result = await getOrganizationVideoIds("org-owner" as never);

		expect(result.success).toBe(true);
		expect(result.data).toEqual(["video-1", "video-2"]);
	});
});

describe("getSpaceVideoIds", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("rejects a space that belongs to another organization", async () => {
		getCurrentUserMock.mockResolvedValueOnce({
			id: "user-attacker",
			activeOrganizationId: "org-attacker",
		});
		// Space lookup scoped to the caller's org finds nothing.
		whereMock.mockResolvedValueOnce([]);

		const { getSpaceVideoIds } = await import(
			"@/actions/spaces/get-space-videos"
		);

		const result = await getSpaceVideoIds("space-victim" as never);

		expect(result.success).toBe(false);
		expect(result.error).toBe("Space not found or not accessible");

		// Teeth again: the space must be looked up by id AND by the caller's org.
		expect(eqSpy).toHaveBeenCalledWith(spaces.id, "space-victim");
		expect(eqSpy).toHaveBeenCalledWith(
			spaces.organizationId,
			"org-attacker",
		);
	});

	it("still serves the caller's own space", async () => {
		getCurrentUserMock.mockResolvedValueOnce({
			id: "user-1",
			activeOrganizationId: "org-owner",
		});
		whereMock
			.mockResolvedValueOnce([{ id: "space-mine" }])
			.mockResolvedValueOnce([{ videoId: "video-1" }]);

		const { getSpaceVideoIds } = await import(
			"@/actions/spaces/get-space-videos"
		);

		const result = await getSpaceVideoIds("space-mine" as never);

		expect(result.success).toBe(true);
		expect(result.data).toEqual(["video-1"]);
	});

	it("does not add a space lookup for the all-spaces entry (id IS the caller's org)", async () => {
		getCurrentUserMock.mockResolvedValueOnce({
			id: "user-1",
			activeOrganizationId: "org-owner",
		});
		whereMock.mockResolvedValueOnce([{ videoId: "video-1" }]);

		const { getSpaceVideoIds } = await import(
			"@/actions/spaces/get-space-videos"
		);

		const result = await getSpaceVideoIds("org-owner" as never);

		expect(result.success).toBe(true);
		expect(result.data).toEqual(["video-1"]);
		// One query only — the guard must not cost the common path an extra round trip.
		expect(whereMock).toHaveBeenCalledTimes(1);
	});
});
