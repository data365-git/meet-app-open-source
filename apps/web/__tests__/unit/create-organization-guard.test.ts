import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the self-provisioning side door: `createOrganization`
// is a "use server" action reachable directly by any signed-in user, so
// blocking the dashboard render alone is not enough — a membership-less
// requester could previously call it and hand themselves a workspace,
// unlocking recording and paid AI on the owner's bill. It must now go
// through the real `assertMayProvisionWorkspace` gate.

vi.mock("server-only", () => ({}));

const { usersStore, organizationsStore, organizationMembersStore } = vi.hoisted(
	() => ({
		usersStore: [] as any[],
		organizationsStore: [] as any[],
		organizationMembersStore: [] as any[],
	}),
);

function getStore(tableName: string) {
	if (tableName === "users") return usersStore;
	if (tableName === "organizations") return organizationsStore;
	if (tableName === "organizationMembers") return organizationMembersStore;
	return [];
}

function rowMatches(row: any, cond: any): boolean {
	if (!cond) return true;
	if (cond.__eq) return row?.[cond.name] === cond.val;
	return true;
}

function projectResult(cols: any, rows: any[]) {
	if (!cols) return rows.map((r) => ({ ...r }));
	return rows.map((r) => {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(cols)) out[key] = r[cols[key]?.name ?? key];
		return out;
	});
}

function makeQuery(rows: any[], cols?: any) {
	let current = rows;
	const q: any = {
		where: (cond: any) => {
			current = current.filter((r) => rowMatches(r, cond));
			return q;
		},
		limit: (n: number) => Promise.resolve(projectResult(cols, current.slice(0, n))),
		then: (res: any, rej: any) =>
			Promise.resolve(projectResult(cols, current)).then(res, rej),
	};
	return q;
}

function makeFakeDb(): any {
	return {
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
	};
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
		activeOrganizationId: col("users", "activeOrganizationId"),
	},
	organizations: {
		__tableName: "organizations",
		id: col("organizations", "id"),
		name: col("organizations", "name"),
	},
	organizationMembers: {
		__tableName: "organizationMembers",
		id: col("organizationMembers", "id"),
		userId: col("organizationMembers", "userId"),
		organizationId: col("organizationMembers", "organizationId"),
		role: col("organizationMembers", "role"),
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: (c: any, val: any) => ({ __eq: true, name: c?.name, val }),
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://example.com" },
}));

vi.mock("@cap/web-backend", () => ({
	S3Buckets: {},
}));

vi.mock("@cap/web-domain", () => ({
	Organisation: { OrganisationId: { make: (v: string) => v } },
	ImageUpload: { ImageKey: { make: (v: string) => v } },
}));

vi.mock("next/cache", () => ({
	revalidatePath: vi.fn(),
}));

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: Effect.runPromise };
});

import { getCurrentUser } from "@cap/database/auth/session";
import { createOrganization } from "@/components/forms/server";

const REQUESTER = { id: "user-requester", isAdmin: false };
const ADMIN = { id: "user-admin", isAdmin: true };
const MEMBER = { id: "user-member", isAdmin: false };

function formDataWithName(name: string) {
	const fd = new FormData();
	fd.set("name", name);
	return fd;
}

beforeEach(() => {
	usersStore.length = 0;
	organizationsStore.length = 0;
	organizationMembersStore.length = 0;

	usersStore.push({ id: REQUESTER.id, isAdmin: false, activeOrganizationId: null });
	usersStore.push({ id: ADMIN.id, isAdmin: true, activeOrganizationId: null });
	usersStore.push({ id: MEMBER.id, isAdmin: false, activeOrganizationId: null });
	organizationsStore.push({ id: "org-existing", name: "Existing Org" });
	organizationMembersStore.push({
		id: "membership-1",
		userId: MEMBER.id,
		organizationId: "org-existing",
		role: "owner",
	});

	vi.mocked(getCurrentUser).mockReset();
});

describe("createOrganization", () => {
	it("throws for a membership-less non-admin requester and creates no organization", async () => {
		vi.mocked(getCurrentUser).mockResolvedValue(REQUESTER as any);

		await expect(
			createOrganization(formDataWithName("Requester's Org")),
		).rejects.toThrow("Unauthorized");

		expect(
			organizationsStore.find((o) => o.name === "Requester's Org"),
		).toBeUndefined();
		expect(
			organizationMembersStore.filter((m) => m.userId === REQUESTER.id),
		).toHaveLength(0);
	});

	it("still works for a platform admin", async () => {
		vi.mocked(getCurrentUser).mockResolvedValue(ADMIN as any);

		const result = await createOrganization(formDataWithName("Admin's Org"));
		expect(result.success).toBe(true);

		expect(organizationsStore.find((o) => o.name === "Admin's Org")).toBeDefined();
		const membership = organizationMembersStore.find(
			(m) => m.userId === ADMIN.id,
		);
		expect(membership?.role).toBe("owner");
	});

	it("still works for a non-admin who already has an organization membership", async () => {
		vi.mocked(getCurrentUser).mockResolvedValue(MEMBER as any);

		const result = await createOrganization(formDataWithName("Member's 2nd Org"));
		expect(result.success).toBe(true);

		expect(
			organizationsStore.find((o) => o.name === "Member's 2nd Org"),
		).toBeDefined();
		const membership = organizationMembersStore.find(
			(m) => m.userId === MEMBER.id && m.role === "owner",
		);
		expect(membership).toBeDefined();
	});
});
