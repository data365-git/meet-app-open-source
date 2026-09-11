import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	Database,
	Storage,
	Tinybird,
	Videos,
	VideosPolicy,
	VideosRepo,
} from "@cap/web-backend";
import {
	CurrentUser,
	type ImageUpload,
	type Organisation,
	type User,
	Video,
} from "@cap/web-domain";
import { Effect, Exit, Layer, Option } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Trash promise is two-sided. /api/video/delete soft-deletes with the
// comment "media + uploads are kept for 3 days so it can be restored"
// (owner-shortened from 7 on 2026-09-11) — which implies the other half:
// after 3 days it is actually GONE. This suite covers that purge half
// (the purge-trashed-videos cron):
//   1. auth follows the exact CRON_SECRET convention of the sibling crons,
//   2. the candidate query is provably scoped: only soft-deleted rows past the
//      3-day cutoff, oldest first, with a bounded batch per run,
//   3. each video is purged through the REUSED Videos.permanentlyDelete as its
//      OWN owner — identities are never cross-paired (tenant safety), and no
//      second copy of the storage-delete logic exists (twin rule),
//   4. one failing video never aborts the run, and the response reports honest
//      counts (purged / failed / skipped / remaining) so a broken night is
//      visible and retryable.

const H = vi.hoisted(() => ({
	candidates: [] as Array<{ id: string; ownerId: string }>,
	remainingCount: 0,
	capturedWheres: [] as unknown[],
	capturedOrderBy: undefined as unknown,
	capturedLimit: undefined as number | undefined,
	purgeTrashedVideo: vi.fn(
		async (_videoId: string, _ownerId: string): Promise<string> => "purged",
	),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: (w: unknown) => {
					H.capturedWheres.push(w);
					return {
						orderBy: (o: unknown) => {
							H.capturedOrderBy = o;
							return {
								limit: (n: number) => {
									H.capturedLimit = n;
									return Promise.resolve(H.candidates);
								},
							};
						},
						// The remaining-count query awaits the where() directly.
						then: (resolve: (v: unknown) => void) =>
							resolve([{ count: H.remainingCount }]),
					};
				},
			}),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		deletedAt: "videos.deletedAt",
	},
}));
vi.mock("drizzle-orm", () => ({
	and: (...a: unknown[]) => ({ and: a }),
	asc: (f: unknown) => ({ asc: f }),
	isNotNull: (f: unknown) => ({ isNotNull: f }),
	lt: (f: unknown, v: unknown) => ({ lt: [f, v] }),
	sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => ({ s, v }), {
		raw: (s: string) => s,
	}),
}));
vi.mock("next/server", () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number }) => ({
			status: init?.status ?? 200,
			json: async () => body,
		}),
	},
}));
vi.mock("@/app/api/cron/purge-trashed-videos/purge-helpers", () => ({
	purgeTrashedVideo: (videoId: string, ownerId: string) =>
		H.purgeTrashedVideo(videoId, ownerId),
}));

const { GET } = await import("@/app/api/cron/purge-trashed-videos/route");

const SECRET = "cron-secret-xyz";
const TRASH_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

function authedRequest(secret = SECRET) {
	return new Request("http://localhost/api/cron/purge-trashed-videos", {
		headers: { authorization: `Bearer ${secret}` },
	});
}

async function bodyOf(res: { json: () => Promise<unknown> }) {
	return (await res.json()) as Record<string, unknown>;
}

type Clause = Record<string, unknown>;
function clausesOf(where: unknown): Clause[] {
	return (where as { and: Clause[] }).and;
}

beforeEach(() => {
	process.env.CRON_SECRET = SECRET;
	H.candidates = [];
	H.remainingCount = 0;
	H.capturedWheres.length = 0;
	H.capturedOrderBy = undefined;
	H.capturedLimit = undefined;
	H.purgeTrashedVideo.mockReset().mockResolvedValue("purged");
});

describe("purge-trashed-videos GET — auth guards", () => {
	it("500 when CRON_SECRET is not configured, and nothing is purged", async () => {
		delete process.env.CRON_SECRET;
		const res = await GET(authedRequest());
		expect(res.status).toBe(500);
		expect(H.purgeTrashedVideo).not.toHaveBeenCalled();
	});

	it("401 on a wrong bearer token of the same length", async () => {
		H.candidates = [{ id: "video-a", ownerId: "user-1" }];
		const res = await GET(authedRequest("cron-secret-abc"));
		expect(res.status).toBe(401);
		expect(H.purgeTrashedVideo).not.toHaveBeenCalled();
	});

	it("401 when the authorization header is missing", async () => {
		const res = await GET(
			new Request("http://localhost/api/cron/purge-trashed-videos"),
		);
		expect(res.status).toBe(401);
		expect(H.purgeTrashedVideo).not.toHaveBeenCalled();
	});
});

describe("purge-trashed-videos GET — candidate selection", () => {
	it("selects ONLY soft-deleted videos past the 3-day cutoff, oldest first, with a bounded batch", async () => {
		const res = await GET(authedRequest());
		expect(res.status).toBe(200);

		const clauses = clausesOf(H.capturedWheres[0]);
		// isNotNull(deletedAt): a live video can NEVER be a candidate.
		expect(clauses).toContainEqual({ isNotNull: "videos.deletedAt" });
		// lt(deletedAt, now - 3d): a video trashed 1 day ago must survive.
		const ltClause = clauses.find((c) => "lt" in c) as
			| { lt: [unknown, Date] }
			| undefined;
		expect(ltClause).toBeDefined();
		expect(ltClause?.lt[0]).toBe("videos.deletedAt");
		const cutoffMs = ltClause?.lt[1].getTime() ?? 0;
		expect(Math.abs(Date.now() - TRASH_RETENTION_MS - cutoffMs)).toBeLessThan(
			60_000,
		);

		// Oldest trash first, so the backlog drains fairly across nights.
		expect(H.capturedOrderBy).toEqual({ asc: "videos.deletedAt" });
		// A bounded batch: one giant backlog cannot time out the route.
		expect(H.capturedLimit).toBe(100);
	});

	it("reports the remaining backlog using the same eligibility predicate", async () => {
		H.remainingCount = 3;
		const res = await GET(authedRequest());
		const body = await bodyOf(res);

		expect(body.remaining).toBe(3);
		// The count query re-states the SAME predicate — never a broader one.
		expect(H.capturedWheres).toHaveLength(2);
		const countClauses = clausesOf(H.capturedWheres[1]);
		expect(countClauses).toContainEqual({ isNotNull: "videos.deletedAt" });
		expect(countClauses.some((c) => "lt" in c)).toBe(true);
	});
});

describe("purge-trashed-videos GET — fan-out & tenant safety", () => {
	it("purges each candidate strictly as its OWN owner — identities are never cross-paired", async () => {
		H.candidates = [
			{ id: "video-a", ownerId: "user-1" },
			{ id: "video-b", ownerId: "user-2" },
		];

		const res = await GET(authedRequest());
		const body = await bodyOf(res);

		// Exact pairing: (A, user-1) then (B, user-2). This inherently asserts
		// video-a is NEVER purged under user-2's identity, and vice versa.
		expect(H.purgeTrashedVideo.mock.calls).toEqual([
			["video-a", "user-1"],
			["video-b", "user-2"],
		]);
		expect(body.purged).toBe(2);
		expect(body.failed).toBe(0);
	});

	it("a video failing to purge does not abort the run; counts stay honest", async () => {
		H.candidates = [
			{ id: "video-a", ownerId: "user-1" },
			{ id: "video-b", ownerId: "user-2" },
		];
		H.purgeTrashedVideo
			.mockRejectedValueOnce(new Error("r2 unavailable"))
			.mockResolvedValueOnce("purged");

		const res = await GET(authedRequest());
		const body = await bodyOf(res);

		expect(res.status).toBe(200);
		expect(H.purgeTrashedVideo).toHaveBeenCalledTimes(2);
		expect(body.purged).toBe(1);
		expect(body.failed).toBe(1);
	});

	it("a helper-reported failure counts as failed, not purged", async () => {
		H.candidates = [
			{ id: "video-a", ownerId: "user-1" },
			{ id: "video-b", ownerId: "user-2" },
		];
		H.purgeTrashedVideo
			.mockResolvedValueOnce("failed")
			.mockResolvedValueOnce("purged");

		const body = await bodyOf(await GET(authedRequest()));
		expect(body.purged).toBe(1);
		expect(body.failed).toBe(1);
	});

	it("a candidate whose owner row is gone is SKIPPED — never deleted under another identity", async () => {
		H.candidates = [{ id: "video-a", ownerId: "user-gone" }];
		H.purgeTrashedVideo.mockResolvedValueOnce("skipped_no_owner");

		const body = await bodyOf(await GET(authedRequest()));
		expect(body.skippedNoOwner).toBe(1);
		expect(body.purged).toBe(0);
		expect(body.failed).toBe(0);
	});
});

describe("purge-trashed-videos wiring — reuse, not a twin", () => {
	const CRON_DIR = join(
		__dirname,
		"..",
		"..",
		"app",
		"api",
		"cron",
		"purge-trashed-videos",
	);
	const routeSource = () => readFileSync(join(CRON_DIR, "route.ts"), "utf8");
	const helperSource = () =>
		readFileSync(join(CRON_DIR, "purge-helpers.ts"), "utf8");

	it("the route uses the shared CRON_SECRET auth convention", () => {
		const source = routeSource();
		expect(source).toContain("CRON_SECRET");
		expect(source).toContain("timingSafeEqual");
	});

	it("the helper reuses Videos.permanentlyDelete as the owner — the honest authz path", () => {
		const source = helperSource();
		expect(source).toContain("permanentlyDelete");
		expect(source).toContain("makeCurrentUserLayer");
	});

	it("no second copy of the storage-delete logic exists (twin rule)", () => {
		for (const source of [routeSource(), helperSource()]) {
			expect(source).not.toContain("listObjects");
			expect(source).not.toContain("deleteObjects");
			expect(source).not.toContain("softDelete");
		}
		// The helper must never bypass the machinery into raw row deletes.
		expect(helperSource()).not.toMatch(/\.delete\(/);
	});
});

// Machinery-level tenant proof, running the REAL Videos.permanentlyDelete the
// helper delegates to: even if the route mis-bound an identity, purging a
// video owned by someone else fails BEFORE any storage or row access — so
// another tenant's data survives a hypothetical route bug.
describe("machinery-level tenant safety (real Videos.permanentlyDelete)", () => {
	const VIDEO_ID = "tenant-video-1" as Video.VideoId;
	const OWNER_ID = "tenant-owner-1" as User.UserId;
	const INTRUDER_ID = "tenant-intruder-1" as User.UserId;
	const ORG_ID = "tenant-org-1" as Organisation.OrganisationId;

	it("purging another tenant's video fails with zero storage/db calls", async () => {
		const calls: string[] = [];

		const video = Video.Video.make({
			id: VIDEO_ID,
			ownerId: OWNER_ID,
			orgId: ORG_ID,
			name: "Someone else's video",
			public: true,
			source: { type: "desktopMP4" },
			metadata: Option.none(),
			bucketId: Option.none(),
			storageIntegrationId: Option.none(),
			folderId: Option.none(),
			transcriptionStatus: Option.none(),
			width: Option.none(),
			height: Option.none(),
			duration: Option.none(),
			createdAt: new Date(),
			updatedAt: new Date(),
		});

		const repo = {
			// The service closure reads `repo.create` while being built.
			create: () => Effect.succeed(VIDEO_ID),
			getByIdIncludingDeleted: () =>
				Effect.sync(() => {
					calls.push("repo.getByIdIncludingDeleted");
					return Option.some([video, Option.none<string>()] as const);
				}),
			delete: () =>
				Effect.sync(() => {
					calls.push("repo.delete");
				}),
			softDelete: () =>
				Effect.sync(() => {
					calls.push("repo.softDelete");
				}),
		};

		const bucket = {
			listObjects: () =>
				Effect.sync(() => {
					calls.push("bucket.listObjects");
					return { Contents: [] };
				}),
			deleteObjects: () =>
				Effect.sync(() => {
					calls.push("bucket.deleteObjects");
				}),
		};

		const storage = {
			getAccessForVideo: () =>
				Effect.sync(() => {
					calls.push("storage.getAccessForVideo");
					return [bucket, Option.none()] as unknown as never;
				}),
		};

		const layer = Videos.DefaultWithoutDependencies.pipe(
			Layer.provide(
				Layer.mergeAll(
					Layer.succeed(VideosRepo, repo as never),
					Layer.succeed(Storage, storage as never),
					Layer.succeed(VideosPolicy, {} as never),
					Layer.succeed(Database, {} as never),
					Layer.succeed(Tinybird, {} as never),
				),
			),
		);

		const exit = await Effect.runPromiseExit(
			Effect.gen(function* () {
				const videos = yield* Videos;
				return yield* videos.permanentlyDelete(VIDEO_ID);
			}).pipe(
				Effect.provide(layer),
				Effect.provideService(CurrentUser, {
					id: INTRUDER_ID,
					email: "intruder@example.com",
					activeOrganizationId: ORG_ID,
					iconUrlOrKey: Option.none<ImageUpload.ImageUrlOrKey>(),
				}),
			),
		);

		expect(Exit.isFailure(exit)).toBe(true);
		// The ownership re-check fires on the fetched row itself; storage and
		// row deletion are never reached.
		expect(calls).toEqual(["repo.getByIdIncludingDeleted"]);
	});
});
