import { beforeEach, describe, expect, it, vi } from "vitest";

// Self-signup must NOT grant access to the owner's workspace.
//
// Previously `signUp` resolved a "default organization" (the admin's org, or the
// oldest org in the system) and inserted an `organizationMembers` row for every
// self-signup. That made any internet stranger a member of the company org.
//
// The access model is: guest (share link only) / requester (account, NO org) /
// member (explicitly added by the owner). These tests pin the requester state
// and the admin-side approval that promotes a requester to a member.

const {
	usersStore,
	organizationsStore,
	organizationMembersStore,
	authApiKeysStore,
	invitesStore,
} = vi.hoisted(() => ({
	usersStore: [] as any[],
	organizationsStore: [] as any[],
	organizationMembersStore: [] as any[],
	authApiKeysStore: [] as any[],
	invitesStore: [] as any[],
}));

function getStore(tableName: string) {
	if (tableName === "users") return usersStore;
	if (tableName === "organizations") return organizationsStore;
	if (tableName === "organizationMembers") return organizationMembersStore;
	if (tableName === "authApiKeys") return authApiKeysStore;
	if (tableName === "invites") return invitesStore;
	return [];
}

function rowMatches(row: any, cond: any): boolean {
	if (!cond) return true;
	if (cond.__and) return cond.conds.every((c: any) => rowMatches(row, c));
	if (cond.__eq) return row?.[cond.name] === cond.val;
	return true;
}

function projectResult(cols: any, rows: any[]) {
	if (!cols) return rows.map((r) => ({ ...r }));
	return rows.map((r) => {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(cols)) {
			const col = cols[key];
			out[key] = col?.name ? r[col.name] : r[key];
		}
		return out;
	});
}

// Chainable, thenable query builder supporting where/orderBy/limit in any order.
function makeQuery(rows: any[], cols?: any) {
	let current = rows;
	const q: any = {
		where: (cond: any) => {
			current = current.filter((r) => rowMatches(r, cond));
			return q;
		},
		orderBy: () => q,
		limit: (n: number) =>
			Promise.resolve(projectResult(cols, current.slice(0, n))),
		then: (res: any, rej: any) =>
			Promise.resolve(projectResult(cols, current)).then(res, rej),
	};
	return q;
}

function makeFakeDb(): any {
	const api = {
		select: (cols?: any) => ({
			from: (table: any) => makeQuery(getStore(table.__tableName), cols),
		}),
		insert: (table: any) => ({
			values: (vals: any) => {
				getStore(table.__tableName).push({ ...vals });
				return Promise.resolve();
			},
		}),
		update: (table: any) => ({
			set: (vals: any) => ({
				where: (cond: any) => {
					for (const row of getStore(table.__tableName)) {
						if (rowMatches(row, cond)) Object.assign(row, vals);
					}
					return Promise.resolve();
				},
			}),
		}),
		delete: (table: any) => ({
			where: (cond: any) => {
				const store = getStore(table.__tableName);
				const remaining = store.filter((row: any) => !rowMatches(row, cond));
				store.length = 0;
				store.push(...remaining);
				return Promise.resolve();
			},
		}),
		transaction: async (cb: any) => cb(api),
	};
	return api;
}

vi.mock("@cap/database", () => ({ db: () => makeFakeDb() }));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(),
}));

let idCounter = 0;
vi.mock("@cap/database/helpers", () => ({
	nanoId: () => `id-${++idCounter}`,
}));

function col(table: string, name: string) {
	return { __col: true, table, name };
}

vi.mock("@cap/database/schema", () => ({
	users: {
		__tableName: "users",
		id: col("users", "id"),
		email: col("users", "email"),
		name: col("users", "name"),
		isAdmin: col("users", "isAdmin"),
		created_at: col("users", "created_at"),
		passwordHash: col("users", "passwordHash"),
		defaultOrgId: col("users", "defaultOrgId"),
		activeOrganizationId: col("users", "activeOrganizationId"),
		authSessionVersion: col("users", "authSessionVersion"),
	},
	organizations: {
		__tableName: "organizations",
		id: col("organizations", "id"),
		ownerId: col("organizations", "ownerId"),
		createdAt: col("organizations", "createdAt"),
	},
	organizationMembers: {
		__tableName: "organizationMembers",
		id: col("organizationMembers", "id"),
		userId: col("organizationMembers", "userId"),
		organizationId: col("organizationMembers", "organizationId"),
		role: col("organizationMembers", "role"),
	},
	invites: { __tableName: "invites" },
	authApiKeys: {
		__tableName: "authApiKeys",
		id: col("authApiKeys", "id"),
		userId: col("authApiKeys", "userId"),
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: (c: any, val: any) => ({ __eq: true, name: c?.name, val }),
	and: (...conds: any[]) => ({ __and: true, conds }),
	asc: (c: any) => ({ __asc: true, c }),
	desc: (c: any) => ({ __desc: true, c }),
	sql: () => ({ __sqlRaw: true }),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://example.com" },
}));

vi.mock("@cap/web-domain", () => ({
	Organisation: { OrganisationId: { make: (v: string) => v } },
	User: { UserId: { make: (v: string) => v } },
}));

vi.mock("bcryptjs", () => ({
	default: {
		hash: async (p: string) => `hash:${p}`,
		compare: async (p: string, h: string) => h === `hash:${p}`,
	},
}));

import { approveRequest, getPendingRequests } from "@/actions/admin/access";
import { signUp } from "@/actions/auth/signup";
import { getCurrentUser } from "@cap/database/auth/session";

const ADMIN = {
	id: "admin-1",
	email: "owner@example.com",
	name: "Owner",
	isAdmin: true,
	passwordHash: "hash:ownerpass",
	defaultOrgId: "org-company",
	activeOrganizationId: "org-company",
	created_at: new Date("2020-01-01"),
};

beforeEach(() => {
	usersStore.length = 0;
	organizationsStore.length = 0;
	organizationMembersStore.length = 0;
	authApiKeysStore.length = 0;
	invitesStore.length = 0;

	// The owner's company workspace already exists — this is what a self-signup
	// used to be silently joined to.
	usersStore.push({ ...ADMIN });
	organizationsStore.push({
		id: "org-company",
		ownerId: ADMIN.id,
		name: "Company",
		createdAt: new Date("2020-01-01"),
	});
	organizationMembersStore.push({
		id: "member-admin",
		userId: ADMIN.id,
		organizationId: "org-company",
		role: "owner",
	});

	vi.mocked(getCurrentUser).mockReset();
});

describe("signUp creates a requester with no organization", () => {
	it("does not add the new user to any organization", async () => {
		const result = await signUp("Stranger", "stranger@gmail.com", "password123");
		expect(result).toEqual({ success: true });

		const created = usersStore.find((u) => u.email === "stranger@gmail.com");
		expect(created).toBeDefined();

		// The defect: the stranger must NOT be a member of the owner's workspace.
		expect(
			organizationMembersStore.filter((m) => m.userId === created.id),
		).toHaveLength(0);

		// And must not point at any organization.
		expect(created.activeOrganizationId ?? null).toBeNull();
		expect(created.defaultOrgId ?? null).toBeNull();
	});

	it("still succeeds when no organization exists at all", async () => {
		organizationsStore.length = 0;
		organizationMembersStore.length = 0;
		usersStore.length = 0;

		const result = await signUp("First", "first@gmail.com", "password123");
		expect(result).toEqual({ success: true });
		expect(usersStore.find((u) => u.email === "first@gmail.com")).toBeDefined();
	});

	it("still rejects duplicate emails", async () => {
		await signUp("Stranger", "stranger@gmail.com", "password123");
		const result = await signUp("Stranger", "stranger@gmail.com", "password123");
		expect(result.success).toBe(false);
	});
});

describe("admin approval promotes a requester to a member", () => {
	async function signUpRequester() {
		await signUp("Requester", "requester@gmail.com", "password123");
		return usersStore.find((u) => u.email === "requester@gmail.com");
	}

	it("lists a signed-up user with no membership as a pending request", async () => {
		const requester = await signUpRequester();
		vi.mocked(getCurrentUser).mockResolvedValue(ADMIN as any);

		const pending = await getPendingRequests();
		expect(pending.map((p) => p.id)).toContain(requester.id);
		// The admin is already a member and must not appear as a request.
		expect(pending.map((p) => p.id)).not.toContain(ADMIN.id);
	});

	it("grants organization membership when approved", async () => {
		const requester = await signUpRequester();
		vi.mocked(getCurrentUser).mockResolvedValue(ADMIN as any);

		const result = await approveRequest(requester.id);
		expect(result.success).toBe(true);

		const membership = organizationMembersStore.find(
			(m) => m.userId === requester.id,
		);
		expect(membership).toBeDefined();
		expect(membership.organizationId).toBe("org-company");
		expect(membership.role).toBe("member");

		// The approved member now has an active workspace.
		const updated = usersStore.find((u) => u.id === requester.id);
		expect(updated.activeOrganizationId).toBe("org-company");

		// And they drop off the pending list.
		const pending = await getPendingRequests();
		expect(pending.map((p) => p.id)).not.toContain(requester.id);
	});

	it("refuses to approve for a non-admin caller", async () => {
		const requester = await signUpRequester();
		vi.mocked(getCurrentUser).mockResolvedValue({
			...ADMIN,
			isAdmin: false,
		} as any);

		await expect(approveRequest(requester.id)).rejects.toThrow("Unauthorized");
		expect(
			organizationMembersStore.filter((m) => m.userId === requester.id),
		).toHaveLength(0);
	});
});
