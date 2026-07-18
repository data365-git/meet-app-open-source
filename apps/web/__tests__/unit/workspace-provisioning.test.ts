import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression test for the self-provisioning side door: a requester (an account
// signed up on their own, with NO organizationMembers row) must not be able to
// hand themselves a workspace — that is what unlocks recording and paid AI on
// the owner's bill. `mayProvisionWorkspace`/`assertMayProvisionWorkspace` are
// the shared gate used by every org-creating entry point.

vi.mock("server-only", () => ({}));

const { organizationMembersStore } = vi.hoisted(() => ({
	organizationMembersStore: [] as any[],
}));

function rowMatches(row: any, cond: any): boolean {
	if (!cond) return true;
	if (cond.__eq) return row?.[cond.name] === cond.val;
	return true;
}

function makeFakeDb(): any {
	return {
		select: (cols?: any) => ({
			from: () => ({
				where: (cond: any) => {
					const filtered = organizationMembersStore.filter((r) =>
						rowMatches(r, cond),
					);
					const projected = cols
						? filtered.map((r) => {
								const out: Record<string, unknown> = {};
								for (const key of Object.keys(cols)) out[key] = r[key];
								return out;
							})
						: filtered;
					const p: any = Promise.resolve(projected);
					p.limit = (n: number) => Promise.resolve(projected.slice(0, n));
					return p;
				},
			}),
		}),
	};
}

vi.mock("@cap/database", () => ({ db: () => makeFakeDb() }));

vi.mock("@cap/database/schema", () => ({
	organizationMembers: {
		id: { name: "id" },
		userId: { name: "userId" },
	},
}));

vi.mock("drizzle-orm", () => ({
	eq: (c: any, val: any) => ({ __eq: true, name: c?.name, val }),
}));

import { User } from "@cap/web-domain";
import {
	assertMayProvisionWorkspace,
	mayProvisionWorkspace,
} from "@/lib/access/workspace-provisioning";

const REQUESTER = { id: User.UserId.make("user-requester"), isAdmin: false };
const ADMIN = { id: User.UserId.make("user-admin"), isAdmin: true };
const MEMBER = { id: User.UserId.make("user-member"), isAdmin: false };

beforeEach(() => {
	organizationMembersStore.length = 0;
	organizationMembersStore.push({
		id: "membership-1",
		userId: MEMBER.id,
	});
});

describe("mayProvisionWorkspace", () => {
	it("returns false for a non-admin with no organization membership", async () => {
		await expect(mayProvisionWorkspace(REQUESTER)).resolves.toBe(false);
	});

	it("returns true for a platform admin, regardless of membership", async () => {
		await expect(mayProvisionWorkspace(ADMIN)).resolves.toBe(true);
	});

	it("returns true for a non-admin who already has an organization membership", async () => {
		await expect(mayProvisionWorkspace(MEMBER)).resolves.toBe(true);
	});

	it("returns false for no signed-in user", async () => {
		await expect(mayProvisionWorkspace(null)).resolves.toBe(false);
		await expect(mayProvisionWorkspace(undefined)).resolves.toBe(false);
	});
});

describe("assertMayProvisionWorkspace", () => {
	it("throws for a membership-less non-admin", async () => {
		await expect(assertMayProvisionWorkspace(REQUESTER)).rejects.toThrow(
			"Unauthorized",
		);
	});

	it("resolves for a platform admin", async () => {
		await expect(assertMayProvisionWorkspace(ADMIN)).resolves.toBeUndefined();
	});

	it("resolves for a non-admin who already has a membership", async () => {
		await expect(assertMayProvisionWorkspace(MEMBER)).resolves.toBeUndefined();
	});
});
