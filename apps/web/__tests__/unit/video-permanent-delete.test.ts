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
	StorageError,
	type User,
	Video,
} from "@cap/web-domain";
import { Effect, Exit, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";

// "Permanently discard" in the recorder promises the media is gone. Three
// things have to be true for that promise to hold, and each is asserted here:
//   1. the capability is REACHABLE (a route wires the hard delete),
//   2. storage is emptied BEFORE the row is dropped, so a storage failure
//      leaves a record to retry from instead of orphaning media in R2,
//   3. a repeat request succeeds, because an offline client retries and a
//      retry of a discard that already worked must not report failure.

const TEST_VIDEO_ID = "test-video-1" as Video.VideoId;
const TEST_OWNER_ID = "owner-1" as User.UserId;
const TEST_ORG_ID = "org-1" as Organisation.OrganisationId;
const TEST_OTHER_USER_ID = "other-user-1" as User.UserId;

function makeVideo(overrides: { ownerId?: string } = {}) {
	return Video.Video.make({
		id: TEST_VIDEO_ID,
		ownerId: (overrides.ownerId ?? TEST_OWNER_ID) as User.UserId,
		orgId: TEST_ORG_ID,
		name: "Test Video",
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
}

function makeUser(id: User.UserId) {
	return {
		id,
		email: "owner@example.com",
		activeOrganizationId: TEST_ORG_ID,
		iconUrlOrKey: Option.none<ImageUpload.ImageUrlOrKey>(),
	};
}

/** Runs the REAL `Videos.permanentlyDelete` against stub repo/storage, so the
 * ordering and idempotency assertions are about shipped code, not a copy. */
function makeHarness(config: {
	video?: Video.Video | null;
	objectKeys?: string[];
	deleteObjectsFails?: boolean;
}) {
	const {
		video = makeVideo(),
		objectKeys = ["owner-1/test-video-1/result.mp4"],
		deleteObjectsFails = false,
	} = config;

	/** Ordered log of every side effect, so "storage before DB" is checkable. */
	const calls: string[] = [];

	const repo = {
		// The service closure reads `repo.create` while it is being built, so the
		// stub has to carry it even though permanent delete never calls it.
		create: () => Effect.succeed(TEST_VIDEO_ID),
		getByIdIncludingDeleted: () =>
			Effect.sync(() => {
				calls.push("repo.getByIdIncludingDeleted");
				return video
					? Option.some([video, Option.none<string>()] as const)
					: Option.none();
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
				return { Contents: objectKeys.map((Key) => ({ Key })) };
			}),
		deleteObjects: () =>
			deleteObjectsFails
				? Effect.sync(() => {
						calls.push("bucket.deleteObjects:failed");
					}).pipe(
						Effect.andThen(
							Effect.fail(new StorageError({ cause: "r2 unavailable" })),
						),
					)
				: Effect.sync(() => {
						calls.push("bucket.deleteObjects");
					}),
	};

	const storage = {
		getAccessForVideo: () =>
			Effect.succeed([bucket, Option.none()] as unknown as never),
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

	const run = (asUser: User.UserId = TEST_OWNER_ID) =>
		Effect.runPromiseExit(
			Effect.gen(function* () {
				const videos = yield* Videos;
				return yield* videos.permanentlyDelete(TEST_VIDEO_ID);
			}).pipe(
				Effect.provide(layer),
				Effect.provideService(CurrentUser, makeUser(asUser)),
			),
		);

	return { calls, run };
}

const APP_ROOT = join(__dirname, "..", "..", "app");
const readRoute = (p: string) => readFileSync(join(APP_ROOT, p), "utf8");

describe("permanent delete is reachable and is a hard delete", () => {
	// Defect (b): a correct hard delete existed but nothing called it, so the
	// recorder's "permanently discard" reached the SOFT-delete route instead.
	it("a route wires the hard delete", () => {
		const source = readRoute("api/video/delete-permanent/route.ts");

		expect(source).toContain("permanentlyDelete");
		expect(source).not.toMatch(/videos\.delete\(/);
	});

	// Requirement 5: the Trash flow is a separate, wanted feature. The old
	// route must keep soft-deleting.
	it("the existing Trash route still soft-deletes", () => {
		const source = readRoute("api/video/delete/route.ts");

		expect(source).toMatch(/videos\.delete\(/);
		expect(source).not.toContain("permanentlyDelete");
	});
});

describe("desktop delete route reuses the permanent-delete machinery", () => {
	// The desktop /delete handler had the identical defect class: rows first,
	// objects second, not idempotent. The fix is to route it through the SAME
	// Videos.permanentlyDelete proven above — not a second copy of the logic.
	it("routes through Videos.permanentlyDelete", () => {
		const source = readRoute("api/desktop/[...route]/video.ts");

		expect(source).toContain("permanentlyDelete");
	});

	// The twin's signature: inline hard-deletes of the rows before storage.
	// (`.delete(videoUploads)` is NOT asserted file-wide because the /progress
	// handler legitimately clears finished uploads.)
	it("no longer hard-deletes video rows inline", () => {
		const source = readRoute("api/desktop/[...route]/video.ts");

		expect(source).not.toContain("delete(importedVideos)");
		expect(source).not.toMatch(/\.delete\(videos\)/);
	});

	// Authorization must stay exactly as strict as today: a non-owner gets the
	// same 404 body an absent video gets, leaking nothing about existence. The
	// machinery fails PolicyDenied for a non-owner, so the route must map it.
	it("maps PolicyDenied so a non-owner still gets the not-found response", () => {
		const source = readRoute("api/desktop/[...route]/video.ts");

		expect(source).toContain("PolicyDenied");
	});
});

describe("Videos.permanentlyDelete", () => {
	// Defect (c): the row was dropped first, so a storage failure orphaned the
	// media in R2 with nothing left pointing at it.
	it("deletes storage objects BEFORE the database row", async () => {
		const { calls, run } = makeHarness({});

		const exit = await run();

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(calls).toContain("bucket.deleteObjects");
		expect(calls).toContain("repo.delete");
		expect(calls.indexOf("bucket.deleteObjects")).toBeLessThan(
			calls.indexOf("repo.delete"),
		);
	});

	it("leaves the row intact when storage deletion fails, so it stays retryable", async () => {
		const { calls, run } = makeHarness({ deleteObjectsFails: true });

		const exit = await run();

		expect(Exit.isFailure(exit)).toBe(true);
		expect(calls).toContain("bucket.deleteObjects:failed");
		expect(calls).not.toContain("repo.delete");
	});

	// An offline client retries. A retry of a discard that already succeeded
	// must not report failure.
	it("succeeds quietly when the video is already gone", async () => {
		const { calls, run } = makeHarness({ video: null });

		const exit = await run();

		expect(Exit.isSuccess(exit)).toBe(true);
		expect(calls).not.toContain("repo.delete");
		expect(calls).not.toContain("bucket.deleteObjects");
	});

	it("rejects a non-owner", async () => {
		const { calls, run } = makeHarness({});

		const exit = await run(TEST_OTHER_USER_ID);

		expect(Exit.isFailure(exit)).toBe(true);
		expect(calls).not.toContain("repo.delete");
		expect(calls).not.toContain("bucket.deleteObjects");
	});

	it("never soft-deletes", async () => {
		const { calls, run } = makeHarness({});

		await run();

		expect(calls).not.toContain("repo.softDelete");
	});
});
