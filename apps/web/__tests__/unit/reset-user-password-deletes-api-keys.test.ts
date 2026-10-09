import bcrypt from "bcryptjs";
import { beforeEach, describe, expect, it, vi } from "vitest";

// --- In-memory fake DB store, shared across all db()/tx calls in a test ---
// Same harness pattern as revoke-user-deletes-api-keys.test.ts (kept as a
// sibling file rather than folded into it: that file is named/scoped for
// `revokeUser` in actions/admin/access.ts, while this one targets the
// separate `resetUserPassword` in actions/admin/reset-user-password.ts,
// which is looked up by email rather than userId and has its own
// admin-check/return shape — mixing both under the revoke-user filename
// would make either test hard to find by name later).
const { usersStore, authApiKeysStore } = vi.hoisted(() => {
	return { usersStore: [] as any[], authApiKeysStore: [] as any[] };
});

function getStore(tableName: string) {
	if (tableName === "users") return usersStore;
	if (tableName === "authApiKeys") return authApiKeysStore;
	return [];
}

function rowMatches(row: any, cond: any): boolean {
	if (!cond) return true;
	if (cond.__eq) return row?.[cond.name] === cond.val;
	return true;
}

function resolveSetValue(row: any, key: string, value: any) {
	if (value && value.__sqlIncrement) return (row[key] ?? 0) + 1;
	return value;
}

function projectResult(cols: any, rows: any[]) {
	const aggregateKey = cols
		? Object.keys(cols).find((k) => cols[k]?.__sqlCount)
		: undefined;
	if (aggregateKey) return [{ [aggregateKey]: rows.length }];
	return rows.map((r) => ({ ...r }));
}

function makeFakeDb(): any {
	const api = {
		select: (cols?: any) => ({
			from: (table: any) => {
				const tableName = table.__tableName;
				const baseRows = getStore(tableName);
				return {
					leftJoin: (joinTable: any) => {
						const joinName = joinTable.__tableName;
						const joinRows = getStore(joinName);
						const joined = baseRows.map((r: any) => ({
							[tableName]: r,
							[joinName]: joinRows.find((j: any) => j.userId === r.id) ?? null,
						}));
						return {
							where: (cond: any) =>
								Promise.resolve(
									joined.filter((jr: any) => rowMatches(jr[joinName], cond)),
								),
						};
					},
					where: (cond: any) => {
						const filtered = baseRows.filter((r: any) => rowMatches(r, cond));
						const result = projectResult(cols, filtered);
						const p: any = Promise.resolve(result);
						p.limit = (n: number) => Promise.resolve(result.slice(0, n));
						return p;
					},
				};
			},
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
						if (rowMatches(row, cond)) {
							for (const [k, v] of Object.entries(vals)) {
								row[k] = resolveSetValue(row, k, v);
							}
						}
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

function col(table: string, name: string) {
	return { __col: true, table, name };
}

vi.mock("@cap/database/schema", () => ({
	users: {
		__tableName: "users",
		id: col("users", "id"),
		email: col("users", "email"),
		passwordHash: col("users", "passwordHash"),
		authSessionVersion: col("users", "authSessionVersion"),
	},
	authApiKeys: {
		__tableName: "authApiKeys",
		id: col("authApiKeys", "id"),
		userId: col("authApiKeys", "userId"),
	},
	invites: { __tableName: "invites" },
	organizations: { __tableName: "organizations" },
	organizationMembers: { __tableName: "organizationMembers" },
	developerApiKeys: { __tableName: "developerApiKeys" },
	developerApps: { __tableName: "developerApps" },
	developerAppDomains: { __tableName: "developerAppDomains" },
}));

vi.mock("drizzle-orm", () => ({
	eq: (c: any, val: any) => ({ __eq: true, table: c?.table, name: c?.name, val }),
	and: (...conds: any[]) => ({ __and: true, conds }),
	or: (...conds: any[]) => ({ __or: true, conds }),
	desc: (c: any) => ({ __desc: true, c }),
	isNull: (c: any) => ({ __isNull: true, c }),
	sql: (strings: TemplateStringsArray, ..._values: unknown[]) => {
		const text = strings.join("|");
		if (text.includes("count(*)")) return { __sqlCount: true };
		if (text.includes("+ 1")) return { __sqlIncrement: true };
		return { __sqlRaw: true };
	},
}));

vi.mock("@cap/env", () => ({
	buildEnv: { NEXT_PUBLIC_WEB_URL: "https://cap.so" },
}));

vi.mock("@cap/web-backend", () => ({
	hashAuthApiKey: vi.fn((token: string) => Promise.resolve(`hash:${token}`)),
}));

import { resetUserPassword } from "@/actions/admin/reset-user-password";
import { mintExtensionToken } from "@/actions/extension/mint-token";
import { withAuth } from "@/app/api/utils";
import { getCurrentUser } from "@cap/database/auth/session";

function makeCtx(authorizationHeader?: string) {
	const state: Record<string, unknown> = {};
	return {
		req: {
			header: (name: string) =>
				name.toLowerCase() === "authorization" ? authorizationHeader : undefined,
		},
		set: (k: string, v: unknown) => {
			state[k] = v;
		},
		get: (k: string) => state[k],
		text: (body: string, status: number) => ({ __textResponse: true, status, body }),
	} as any;
}

const ADMIN = { id: "admin-1", email: "admin@cap.so", isAdmin: true, passwordHash: "x", authSessionVersion: 0 };
const TARGET = { id: "target-1", email: "target@cap.so", isAdmin: false, passwordHash: "y", authSessionVersion: 0 };

describe("resetUserPassword deletes the reset user's API/extension keys", () => {
	beforeEach(() => {
		usersStore.length = 0;
		authApiKeysStore.length = 0;
		usersStore.push({ ...ADMIN }, { ...TARGET });
		vi.mocked(getCurrentUser).mockReset();
	});

	it("mints a key, resets the password, and the key can no longer authenticate", async () => {
		// 1. Mint an extension API key for the target user (real production code path).
		vi.mocked(getCurrentUser).mockResolvedValueOnce(TARGET as any);
		const { token } = await mintExtensionToken();

		expect(authApiKeysStore).toHaveLength(1);
		expect(authApiKeysStore[0].userId).toBe(TARGET.id);

		// Sanity: the freshly minted key authenticates before the reset.
		const preResetNext = vi.fn();
		const preResetResult = await withAuth(makeCtx(`Bearer ${token}`), preResetNext);
		expect(preResetResult).toBeUndefined();
		expect(preResetNext).toHaveBeenCalledTimes(1);

		const originalPasswordHash = usersStore.find((u) => u.id === TARGET.id)
			.passwordHash;
		const originalSessionVersion = usersStore.find((u) => u.id === TARGET.id)
			.authSessionVersion;

		// 2. Admin resets the target user's password (real production code path under test).
		vi.mocked(getCurrentUser).mockResolvedValueOnce(ADMIN as any);
		const result = await resetUserPassword(TARGET.email, "brandNewPassw0rd!");
		expect(result.success).toBe(true);

		const targetRow = usersStore.find((u) => u.id === TARGET.id);

		// 3. The password hash actually changed, to a hash of the new password.
		expect(targetRow.passwordHash).not.toBe(originalPasswordHash);
		expect(bcrypt.compareSync("brandNewPassw0rd!", targetRow.passwordHash)).toBe(
			true,
		);

		// 4. authSessionVersion was bumped, invalidating issued JWTs/session cookies.
		expect(targetRow.authSessionVersion).toBe(originalSessionVersion + 1);

		// 5. No authApiKeys row should remain for the target user.
		expect(authApiKeysStore.filter((k) => k.userId === TARGET.id)).toHaveLength(0);

		// 6. The extension token must no longer authenticate.
		const postResetNext = vi.fn();
		const postResetResult = await withAuth(makeCtx(`Bearer ${token}`), postResetNext);
		expect(postResetResult).toEqual({
			__textResponse: true,
			status: 401,
			body: "User not authenticated",
		});
		expect(postResetNext).not.toHaveBeenCalled();
	});
});
