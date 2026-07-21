import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Account deletion is REAL erasure (owner decision 2026-07-18): the user's
// videos (DB rows AND storage objects, via the REUSED Videos.permanentlyDelete
// machinery), comments, API keys, AI usage, notifications and memberships all
// go — storage FIRST, the account row LAST, behind a SERVER-verified typed
// phrase. Four promises are asserted here:
//   1. the phrase gate is enforced on the SERVER (a forged client call without
//      the exact phrase deletes nothing),
//   2. every video the user owns — including Trash — goes through the one
//      proven permanentlyDelete path (no second copy of the storage logic),
//   3. TENANT SAFETY: another user's videos, comments, spaces and shared org
//      structures survive (the previous attempt at this was rejected for
//      deleting other tenants' spaces/folders),
//   4. a storage failure leaves the account intact and retryable.

const CONFIRMATION_PHRASE = "delete my all data";

// --- In-memory fake DB stores, shared across all db()/tx calls in a test ---
const stores = vi.hoisted(() => ({
	users: [] as any[],
	organizations: [] as any[],
	organizationMembers: [] as any[],
	sessions: [] as any[],
	accounts: [] as any[],
	videos: [] as any[],
	comments: [] as any[],
	notifications: [] as any[],
	authApiKeys: [] as any[],
	aiUsageEvents: [] as any[],
	spaceMembers: [] as any[],
	verificationTokens: [] as any[],
	spaces: [] as any[],
	folders: [] as any[],
	organizationInvites: [] as any[],
}));

/** Records every Videos.permanentlyDelete call (and which user made it). */
const erasure = vi.hoisted(() => ({
	calls: [] as Array<{ videoId: string; userId: string | undefined }>,
	failFor: [] as string[],
}));

// Records the ORDER of every delete() call inside the final transaction, so a
// test can prove aiUsageEvents-by-orgId is cleared BEFORE the organizations
// row (the FK it unblocks). `forceThrowAfterCommit` simulates the final
// transaction failing (e.g. a DB constraint still rejecting it) so the
// unhandled-500 regression can be pinned: deleteAccount must catch it and
// return { ok: false }, never throw.
const txControl = vi.hoisted(() => ({
	deleteLog: [] as Array<{ table: string; cond: any }>,
	forceThrowAfterCommit: false,
}));

function getStore(tableName: string) {
	return (stores as Record<string, any[]>)[tableName] ?? [];
}

function rowMatches(row: any, cond: any): boolean {
	if (!cond) return true;
	if (cond.__eq) return row?.[cond.name] === cond.val;
	if (cond.__and) return cond.conds.every((c: any) => rowMatches(row, c));
	return true;
}

function makeFakeDb(): any {
	const api = {
		select: (_cols?: any) => ({
			from: (table: any) => ({
				where: (cond: any) => {
					const rows = getStore(table.__tableName)
						.filter((r: any) => rowMatches(r, cond))
						.map((r: any) => ({ ...r }));
					const p: any = Promise.resolve(rows);
					p.limit = (n: number) => Promise.resolve(rows.slice(0, n));
					return p;
				},
			}),
		}),
		delete: (table: any) => ({
			where: (cond: any) => {
				txControl.deleteLog.push({ table: table.__tableName, cond });
				const store = getStore(table.__tableName);
				const remaining = store.filter((row: any) => !rowMatches(row, cond));
				store.length = 0;
				store.push(...remaining);
				return Promise.resolve();
			},
		}),
		transaction: async (cb: any) => {
			const result = await cb(api);
			if (txControl.forceThrowAfterCommit) {
				throw new Error("simulated transaction failure");
			}
			return result;
		},
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

function fakeTable(name: string, colNames: string[]) {
	const t: any = { __tableName: name };
	for (const c of colNames) t[c] = col(name, c);
	return t;
}

vi.mock("@cap/database/schema", () => ({
	users: fakeTable("users", ["id", "email"]),
	organizations: fakeTable("organizations", ["id", "name", "ownerId"]),
	organizationMembers: fakeTable("organizationMembers", [
		"id",
		"userId",
		"organizationId",
	]),
	sessions: fakeTable("sessions", ["id", "userId"]),
	accounts: fakeTable("accounts", ["id", "userId"]),
	videos: fakeTable("videos", ["id", "ownerId", "deletedAt"]),
	comments: fakeTable("comments", ["id", "authorId", "videoId"]),
	notifications: fakeTable("notifications", ["id", "recipientId"]),
	authApiKeys: fakeTable("authApiKeys", ["id", "userId"]),
	aiUsageEvents: fakeTable("aiUsageEvents", ["id", "userId", "orgId"]),
	spaceMembers: fakeTable("spaceMembers", ["id", "spaceId", "userId"]),
	verificationTokens: fakeTable("verificationTokens", ["identifier"]),
	spaces: fakeTable("spaces", ["id", "createdById", "organizationId"]),
	folders: fakeTable("folders", ["id", "createdById", "organizationId"]),
	organizationInvites: fakeTable("organizationInvites", [
		"id",
		"organizationId",
	]),
}));

vi.mock("drizzle-orm", () => ({
	eq: (c: any, val: any) => ({ __eq: true, name: c?.name, val }),
	and: (...conds: any[]) => ({ __and: true, conds }),
	isNull: (c: any) => ({ __isNull: true, c }),
}));

// The REUSED machinery: a fake Videos service whose permanentlyDelete records
// (videoId, acting user) so the test can prove the action pipes every owned
// video — and ONLY owned videos — through the one proven delete path with the
// right CurrentUser attached.
vi.mock("@cap/web-backend", async () => {
	const { Context, Effect, Layer } = await import("effect");
	const CurrentUserTag = Context.GenericTag<any>("test/CurrentUser");
	const VideosTag = Context.GenericTag<any>("test/Videos");
	const service = {
		permanentlyDelete: (videoId: string) =>
			Effect.gen(function* () {
				const user: any = yield* CurrentUserTag;
				erasure.calls.push({ videoId, userId: user?.id });
				if (erasure.failFor.includes(videoId))
					return yield* Effect.fail(
						new Error(`storage unavailable for ${videoId}`),
					);
			}),
	};
	return {
		Videos: VideosTag,
		makeCurrentUserLayer: (user: any) => Layer.succeed(CurrentUserTag, user),
		__testVideosLayer: Layer.succeed(VideosTag, service),
	};
});

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	const backend: any = await import("@cap/web-backend");
	return {
		runPromise: (effect: any) =>
			Effect.runPromise(
				Effect.provide(effect, backend.__testVideosLayer) as any,
			),
	};
});

import { getCurrentUser } from "@cap/database/auth/session";
import { deleteAccount } from "@/actions/account/delete-account";

const USER_A = {
	id: "user-a",
	email: "a@example.com",
	activeOrganizationId: "org-shared",
	image: null,
};
const USER_B = {
	id: "user-b",
	email: "b@example.com",
	activeOrganizationId: "org-shared",
	image: null,
};

beforeEach(() => {
	for (const store of Object.values(stores)) store.length = 0;
	erasure.calls.length = 0;
	erasure.failFor.length = 0;
	txControl.deleteLog.length = 0;
	txControl.forceThrowAfterCommit = false;

	stores.users.push({ ...USER_A }, { ...USER_B });
	// The shared org is owned by B, so A's owned-orgs guard passes.
	stores.organizations.push({
		id: "org-shared",
		name: "Shared Org",
		ownerId: "user-b",
	});
	stores.organizationMembers.push(
		{ id: "om-a", userId: "user-a", organizationId: "org-shared" },
		{ id: "om-b", userId: "user-b", organizationId: "org-shared" },
	);
	stores.sessions.push(
		{ id: "sess-a", userId: "user-a" },
		{ id: "sess-b", userId: "user-b" },
	);
	stores.accounts.push(
		{ id: "acc-a", userId: "user-a" },
		{ id: "acc-b", userId: "user-b" },
	);
	// A has a live video AND a trashed one — erasure must purge BOTH.
	stores.videos.push(
		{ id: "vid-a-live", ownerId: "user-a", deletedAt: null },
		{ id: "vid-a-trashed", ownerId: "user-a", deletedAt: new Date() },
		{ id: "vid-b", ownerId: "user-b", deletedAt: null },
	);
	stores.comments.push(
		{ id: "com-a-on-b", authorId: "user-a", videoId: "vid-b" },
		{ id: "com-b", authorId: "user-b", videoId: "vid-b" },
	);
	stores.notifications.push(
		{ id: "not-a", recipientId: "user-a" },
		{ id: "not-b", recipientId: "user-b" },
	);
	stores.authApiKeys.push(
		{ id: "key-a", userId: "user-a" },
		{ id: "key-b", userId: "user-b" },
	);
	stores.aiUsageEvents.push(
		{ id: "ai-a", userId: "user-a" },
		{ id: "ai-b", userId: "user-b" },
	);
	stores.spaceMembers.push(
		{ id: "sm-a", spaceId: "space-b", userId: "user-a" },
		{ id: "sm-b", spaceId: "space-b", userId: "user-b" },
	);
	stores.verificationTokens.push(
		{ identifier: "a@example.com" },
		{ identifier: "b@example.com" },
	);
	// Shared org structures: B's space, plus a space and folder A CREATED
	// inside the org A does not own. All must survive A's erasure.
	stores.spaces.push(
		{ id: "space-b", createdById: "user-b" },
		{ id: "space-a-created", createdById: "user-a" },
	);
	stores.folders.push({ id: "folder-a-created", createdById: "user-a" });

	vi.mocked(getCurrentUser).mockReset();
	vi.mocked(getCurrentUser).mockResolvedValue(USER_A as any);
});

describe("deleteAccount — real erasure behind the server-verified phrase", () => {
	it("purges every owned video (Trash included) via permanentlyDelete and all user-keyed rows", async () => {
		const result = await deleteAccount(CONFIRMATION_PHRASE);
		expect(result).toEqual({ ok: true });

		// Both of A's videos went through the REUSED machinery, as A.
		const deletedIds = erasure.calls.map((c) => c.videoId).sort();
		expect(deletedIds).toEqual(["vid-a-live", "vid-a-trashed"]);
		for (const call of erasure.calls) expect(call.userId).toBe("user-a");

		// Every user-keyed row is gone.
		expect(stores.users.find((u) => u.id === "user-a")).toBeUndefined();
		expect(stores.comments.filter((c) => c.authorId === "user-a")).toHaveLength(0);
		expect(stores.authApiKeys.filter((k) => k.userId === "user-a")).toHaveLength(0);
		expect(stores.aiUsageEvents.filter((e) => e.userId === "user-a")).toHaveLength(0);
		expect(
			stores.notifications.filter((n) => n.recipientId === "user-a"),
		).toHaveLength(0);
		expect(stores.spaceMembers.filter((m) => m.userId === "user-a")).toHaveLength(0);
		expect(
			stores.organizationMembers.filter((m) => m.userId === "user-a"),
		).toHaveLength(0);
		expect(stores.sessions.filter((s) => s.userId === "user-a")).toHaveLength(0);
		expect(stores.accounts.filter((a) => a.userId === "user-a")).toHaveLength(0);
		expect(
			stores.verificationTokens.filter((t) => t.identifier === "a@example.com"),
		).toHaveLength(0);
	});

	it("refuses without the exact phrase, verified SERVER-side", async () => {
		// Close but wrong — a client-side-only gate would not catch a forged call.
		const wrong = await deleteAccount("delete all my data");
		expect(wrong.ok).toBe(false);

		// Missing entirely (forged call bypassing the UI).
		const missing = await (deleteAccount as any)();
		expect(missing.ok).toBe(false);

		// NOTHING was deleted — no videos, no rows.
		expect(erasure.calls).toHaveLength(0);
		expect(stores.users.find((u) => u.id === "user-a")).toBeDefined();
		expect(stores.sessions.filter((s) => s.userId === "user-a")).toHaveLength(1);
		expect(stores.authApiKeys.filter((k) => k.userId === "user-a")).toHaveLength(1);
	});

	it("TENANT SAFETY: the other user's data and shared org structures survive", async () => {
		const result = await deleteAccount(CONFIRMATION_PHRASE);
		expect(result).toEqual({ ok: true });

		// B's video was never piped through permanentlyDelete.
		expect(erasure.calls.map((c) => c.videoId)).not.toContain("vid-b");

		// B's account, video, comment, membership, session all survive.
		expect(stores.users.find((u) => u.id === "user-b")).toBeDefined();
		expect(stores.videos.find((v) => v.id === "vid-b")).toBeDefined();
		expect(stores.comments.find((c) => c.id === "com-b")).toBeDefined();
		expect(
			stores.organizationMembers.find((m) => m.userId === "user-b"),
		).toBeDefined();
		expect(stores.sessions.find((s) => s.userId === "user-b")).toBeDefined();
		expect(stores.notifications.find((n) => n.recipientId === "user-b")).toBeDefined();
		expect(stores.spaceMembers.find((m) => m.userId === "user-b")).toBeDefined();
		expect(
			stores.verificationTokens.find((t) => t.identifier === "b@example.com"),
		).toBeDefined();

		// Shared org structures survive — INCLUDING the space and folder A
		// created inside an org A does not own. (The previously rejected
		// attempt deleted other tenants' spaces/folders; this pins the law.)
		expect(stores.organizations.find((o) => o.id === "org-shared")).toBeDefined();
		expect(stores.spaces.find((s) => s.id === "space-b")).toBeDefined();
		expect(stores.spaces.find((s) => s.id === "space-a-created")).toBeDefined();
		expect(stores.folders.find((f) => f.id === "folder-a-created")).toBeDefined();
	});

	it("a storage failure leaves the account intact and retryable", async () => {
		erasure.failFor.push("vid-a-live");

		const failed = await deleteAccount(CONFIRMATION_PHRASE);
		expect(failed.ok).toBe(false);

		// Storage FIRST, account row LAST: the failure must leave the account
		// (users/sessions/accounts rows) in place so the user can retry.
		expect(stores.users.find((u) => u.id === "user-a")).toBeDefined();
		expect(stores.sessions.filter((s) => s.userId === "user-a")).toHaveLength(1);
		expect(stores.accounts.filter((a) => a.userId === "user-a")).toHaveLength(1);

		// Retry after storage recovers completes the erasure (permanentlyDelete
		// is idempotent, so re-deleting the already-gone video is safe).
		erasure.failFor.length = 0;
		const retried = await deleteAccount(CONFIRMATION_PHRASE);
		expect(retried).toEqual({ ok: true });
		expect(stores.users.find((u) => u.id === "user-a")).toBeUndefined();
	});

	// The legacy invite path gave users a personal single-member org they never
	// asked for; a blanket owner-refusal would dead-end erasure for that whole
	// user class. Sole-member orgs die with the account (no other tenant CAN be
	// affected); an org with other members still blocks.
	it("erases a sole-member personal org (and its scoped structures) with the account", async () => {
		stores.organizations.push({
			id: "org-personal-a",
			name: "A's Personal Org",
			ownerId: "user-a",
		});
		stores.organizationMembers.push({
			id: "om-a-personal",
			userId: "user-a",
			organizationId: "org-personal-a",
		});
		stores.spaces.push({
			id: "space-in-personal",
			createdById: "user-a",
			organizationId: "org-personal-a",
		});
		stores.folders.push({
			id: "folder-in-personal",
			createdById: "user-a",
			organizationId: "org-personal-a",
		});
		stores.organizationInvites.push({
			id: "inv-personal",
			organizationId: "org-personal-a",
		});

		const result = await deleteAccount(CONFIRMATION_PHRASE);
		expect(result).toEqual({ ok: true });

		// The personal org and everything scoped to it are gone.
		expect(
			stores.organizations.find((o) => o.id === "org-personal-a"),
		).toBeUndefined();
		expect(
			stores.spaces.find((s) => s.id === "space-in-personal"),
		).toBeUndefined();
		expect(
			stores.folders.find((f) => f.id === "folder-in-personal"),
		).toBeUndefined();
		expect(
			stores.organizationInvites.find((i) => i.id === "inv-personal"),
		).toBeUndefined();

		// The SHARED org (owned by B) and its structures are untouched.
		expect(stores.organizations.find((o) => o.id === "org-shared")).toBeDefined();
		expect(stores.spaces.find((s) => s.id === "space-b")).toBeDefined();
	});

	// C1 (BLOCKER): ai_usage_events_org_fk has NO ON DELETE. A's own
	// aiUsageEvents rows are cleared by userId earlier in the transaction, but
	// a DIFFERENT member's row (e.g. someone since removed from A's personal
	// org) can still point at the same orgId and would reject the org delete
	// below it — rolling back the whole transaction AFTER the irreversible
	// video/storage purge already ran. The fix must clear those by-orgId
	// BEFORE deleting the org row.
	it("clears a leftover member's aiUsageEvents row by orgId before deleting a sole-member org", async () => {
		stores.organizations.push({
			id: "org-personal-a",
			name: "A's Personal Org",
			ownerId: "user-a",
		});
		stores.organizationMembers.push({
			id: "om-a-personal",
			userId: "user-a",
			organizationId: "org-personal-a",
		});
		// A former member's usage row: NOT user-a, so the earlier by-userId
		// delete never touches it, yet it still references org-personal-a.
		stores.aiUsageEvents.push({
			id: "ai-orphan",
			userId: "user-c-removed",
			orgId: "org-personal-a",
		});

		const result = await deleteAccount(CONFIRMATION_PHRASE);
		expect(result).toEqual({ ok: true });

		// The leftover row is gone and the org delete went through.
		expect(
			stores.aiUsageEvents.find((e) => e.id === "ai-orphan"),
		).toBeUndefined();
		expect(
			stores.organizations.find((o) => o.id === "org-personal-a"),
		).toBeUndefined();

		// Proof of ORDER, not just outcome: the aiUsageEvents-by-orgId delete
		// must be logged before the organizations-by-id delete for this org —
		// otherwise a real DB would reject the org delete with the FK still
		// in place.
		const aiDeleteIndex = txControl.deleteLog.findIndex(
			(e) =>
				e.table === "aiUsageEvents" &&
				e.cond?.name === "orgId" &&
				e.cond?.val === "org-personal-a",
		);
		const orgDeleteIndex = txControl.deleteLog.findIndex(
			(e) =>
				e.table === "organizations" && e.cond?.val === "org-personal-a",
		);
		expect(aiDeleteIndex).toBeGreaterThanOrEqual(0);
		expect(orgDeleteIndex).toBeGreaterThan(aiDeleteIndex);
	});

	// Mirrors the video-purge try/catch: if the final transaction throws for
	// any reason (e.g. a constraint the fix above didn't anticipate), the
	// action must return { ok: false } — never let a 500 escape and strand
	// the user in an unretryable state.
	it("returns { ok: false } instead of throwing when the final transaction fails", async () => {
		txControl.forceThrowAfterCommit = true;

		await expect(deleteAccount(CONFIRMATION_PHRASE)).resolves.toEqual(
			expect.objectContaining({ ok: false }),
		);
	});

	it("still refuses while an owned org has OTHER members, deleting nothing", async () => {
		stores.organizations.push({
			id: "org-owned-by-a",
			name: "A's Team Org",
			ownerId: "user-a",
		});
		stores.organizationMembers.push(
			{ id: "om-a-team", userId: "user-a", organizationId: "org-owned-by-a" },
			{ id: "om-b-team", userId: "user-b", organizationId: "org-owned-by-a" },
		);

		const result = await deleteAccount(CONFIRMATION_PHRASE);
		expect(result.ok).toBe(false);
		expect(erasure.calls).toHaveLength(0);
		expect(stores.users.find((u) => u.id === "user-a")).toBeDefined();
		expect(
			stores.organizations.find((o) => o.id === "org-owned-by-a"),
		).toBeDefined();
	});
});

describe("twin guard: the action REUSES the permanent-delete machinery", () => {
	// TWIN RULE (commit cdf521b): storage-first hard delete exists ONCE, in
	// Videos.permanentlyDelete. The action must call it, never carry its own
	// copy of the object-deletion logic — a copy is tomorrow's twin bug.
	it("calls permanentlyDelete and contains no second copy of the storage logic", () => {
		const source = readFileSync(
			join(__dirname, "..", "..", "actions", "account", "delete-account.ts"),
			"utf8",
		);

		expect(source).toContain("permanentlyDelete");
		expect(source).not.toContain("listObjects");
		expect(source).not.toContain("deleteObjects");
	});
});
