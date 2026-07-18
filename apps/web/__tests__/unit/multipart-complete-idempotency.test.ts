import { Effect } from "effect";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ── Test doubles ────────────────────────────────────────────────────────────
//
// The /complete route is the last step of "a meeting must never fail to
// record", so it is worth exercising for real rather than only through its
// pure helpers. Everything it reaches out to (storage, DB, policy, auth) is
// stubbed; the Hono handler and its Effect pipeline are the real thing.

const storage = vi.hoisted(() => ({
	completeError: null as unknown,
	listPartsError: null as unknown,
	headContentLength: undefined as number | undefined,
	headError: null as unknown,
	completeCalls: [] as Array<Record<string, unknown>>,
	headCalls: [] as string[],
	provider: "s3" as "s3" | "googleDrive",
}));

const dbWrites = vi.hoisted(() => ({
	videoUploadSets: [] as Array<Record<string, unknown>>,
	videoUploadDeleted: 0,
}));

const quota = vi.hoisted(() => ({
	calls: [] as Array<{ incomingBytes?: number }>,
}));

const TABLES = vi.hoisted(() => ({
	videos: { id: "videos.id", ownerId: "videos.ownerId" },
	videoUploads: { videoId: "videoUploads.videoId" },
}));

vi.mock("@cap/database", () => ({
	updateIfDefined: (value: unknown) => value,
}));

vi.mock("@cap/database/schema", () => ({
	videos: TABLES.videos,
	videoUploads: TABLES.videoUploads,
}));

vi.mock("drizzle-orm", () => ({
	and: (...args: unknown[]) => args,
	eq: (field: unknown, value: unknown) => ({ field, value }),
}));

vi.mock("@/app/api/utils", () => ({
	withAuth: async (
		c: { set: (k: string, v: unknown) => void },
		next: () => Promise<void>,
	) => {
		c.set("user", { id: "user-1" });
		await next();
	},
}));

vi.mock("@/lib/server", () => ({
	runPromise: (effect: Effect.Effect<unknown, unknown, never>) =>
		Effect.runPromise(effect),
}));

vi.mock("@/lib/google-drive-storage-quota", () => ({
	invalidateGoogleDriveStorageQuotaCache: async () => undefined,
}));

vi.mock("@/lib/storage-quota", () => ({
	checkUploadQuota: async (args: { incomingBytes?: number }) => {
		quota.calls.push(args);
		return { ok: true };
	},
}));

vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: async () => undefined,
}));

vi.mock("@cap/web-domain", () => ({
	Policy: {
		withPolicy: () => (effect: unknown) => effect,
	},
	Video: {
		VideoId: { make: (id: string) => id },
		NotFoundError: class NotFoundError {
			readonly _tag = "VideoNotFoundError";
		},
	},
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect: E, Option } = await import("effect");

	const fakeDb = {
		transaction: (fn: () => Promise<unknown>) => fn(),
		update: (table: unknown) => ({
			set: (values: Record<string, unknown>) => {
				if (table === TABLES.videoUploads) dbWrites.videoUploadSets.push(values);
				return { where: async () => undefined };
			},
		}),
		delete: (table: unknown) => ({
			where: async () => {
				if (table === TABLES.videoUploads) dbWrites.videoUploadDeleted += 1;
			},
		}),
		insert: () => ({
			values: () => ({ onDuplicateKeyUpdate: async () => undefined }),
		}),
	};

	// Production wraps storage failures twice (StorageError -> S3Error -> the
	// AWS error), so the double wrap here keeps the cause-chain walk honest.
	const failWith = (error: unknown) =>
		E.fail(
			new Error("StorageError", {
				cause: new Error("S3Error", { cause: error }),
			}),
		);

	const bucket = {
		get provider() {
			return storage.provider;
		},
		bucketName: "bucket-1",
		multipart: {
			complete: (key: string, uploadId: string, args: unknown) => {
				storage.completeCalls.push({ key, uploadId, args });
				if (storage.completeError) return failWith(storage.completeError);
				return E.succeed({ Location: `https://cdn.example/${key}` });
			},
			listParts: () => {
				if (storage.listPartsError) return failWith(storage.listPartsError);
				return E.succeed({
					Parts: [
						{ PartNumber: 1, ETag: '"real-etag-1"' },
						{ PartNumber: 2, ETag: '"real-etag-2"' },
					],
				});
			},
		},
		headObject: (key: string) => {
			storage.headCalls.push(key);
			if (storage.headError) return failWith(storage.headError);
			return E.succeed({
				ContentLength: storage.headContentLength,
				ContentType: "video/mp4",
				Metadata: {},
			});
		},
		copyObject: () => E.succeed(undefined),
	};

	return {
		Database: E.succeed({
			use: (fn: (db: typeof fakeDb) => Promise<unknown>) =>
				E.promise(() => fn(fakeDb)),
		}),
		makeCurrentUserLayer: () => undefined,
		provideOptionalAuth: (effect: unknown) => effect,
		Storage: { getAccessForVideo: () => E.succeed([bucket]) },
		VideosPolicy: E.succeed({ isOwner: () => undefined }),
		VideosRepo: E.succeed({
			getById: () =>
				E.succeed(
					Option.some([
						{
							id: "video-1",
							orgId: "org-1",
							ownerId: "user-1",
							bucketId: Option.none(),
							storageIntegrationId: Option.none(),
						},
					]),
				),
		}),
	};
});

// `Effect.provide(undefined)` is not valid, so neutralise the two pipeline
// steps the route applies after its own logic. Both are pure plumbing here.
vi.mock("effect", async (importOriginal) => {
	const actual = await importOriginal<typeof import("effect")>();
	return {
		...actual,
		Effect: {
			...actual.Effect,
			provide: () => (effect: unknown) => effect,
		},
	};
});

async function postComplete(body: Record<string, unknown>) {
	const { app } = await import("@/app/api/upload/[...route]/multipart");
	return app.request("/complete", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
}

const NO_SUCH_UPLOAD = Object.assign(
	new Error("The specified multipart upload does not exist."),
	{ name: "NoSuchUpload" },
);

beforeEach(() => {
	storage.completeError = null;
	storage.listPartsError = null;
	storage.headContentLength = 12_345_678;
	storage.headError = null;
	storage.completeCalls = [];
	storage.headCalls = [];
	storage.provider = "s3";
	dbWrites.videoUploadSets = [];
	dbWrites.videoUploadDeleted = 0;
	quota.calls = [];
	vi.resetModules();
});

// ── H3: completion must be idempotent ───────────────────────────────────────
//
// Storage can assemble the object and still lose the response (network drop,
// gateway timeout). The client then retries with the same uploadId and R2
// answers NoSuchUpload, because the multipart no longer exists — it already
// completed. Turning that into a 500 forever makes the retry fail on every
// attempt until it dead-letters a meeting whose bytes are all safely stored.

describe("/complete idempotency (H3)", () => {
	it("reconciles a NoSuchUpload completion when the finished object is already in storage", async () => {
		storage.completeError = NO_SUCH_UPLOAD;

		const res = await postComplete({
			uploadId: "upload-1",
			videoId: "video-1",
			subpath: "result.mp4",
			parts: [
				{ partNumber: 1, etag: "etag-1", size: 0 },
				{ partNumber: 2, etag: "etag-2", size: 0 },
			],
		});

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ success: true });
		expect(storage.headCalls).toContain("user-1/video-1/result.mp4");
	});

	it("reconciles when the NoSuchUpload surfaces from listParts (the extension's placeholder-ETag retry)", async () => {
		storage.listPartsError = NO_SUCH_UPLOAD;

		const res = await postComplete({
			uploadId: "upload-1",
			videoId: "video-1",
			subpath: "result.mp4",
			parts: [
				{ partNumber: 1, etag: "RESOLVE_SERVER_SIDE", size: 0 },
				{ partNumber: 2, etag: "RESOLVE_SERVER_SIDE", size: 0 },
			],
		});

		expect(res.status).toBe(200);
		await expect(res.json()).resolves.toMatchObject({ success: true });
	});

	it("does NOT claim success when the multipart is gone and no object exists", async () => {
		storage.completeError = NO_SUCH_UPLOAD;
		storage.headError = new Error("NotFound");

		const res = await postComplete({
			uploadId: "upload-1",
			videoId: "video-1",
			subpath: "result.mp4",
			parts: [{ partNumber: 1, etag: "etag-1", size: 10 }],
		});

		expect(res.status).toBe(500);
	});

	it("does NOT claim success for a zero-byte object", async () => {
		storage.completeError = NO_SUCH_UPLOAD;
		storage.headContentLength = 0;

		const res = await postComplete({
			uploadId: "upload-1",
			videoId: "video-1",
			subpath: "result.mp4",
			parts: [{ partNumber: 1, etag: "etag-1", size: 10 }],
		});

		expect(res.status).toBe(500);
	});

	it("still fails an ordinary completion error, so the client keeps retrying against a live upload", async () => {
		storage.completeError = new Error("InternalError: please retry");

		const res = await postComplete({
			uploadId: "upload-1",
			videoId: "video-1",
			subpath: "result.mp4",
			parts: [{ partNumber: 1, etag: "etag-1", size: 10 }],
		});

		expect(res.status).toBe(500);
	});
});

// ── H5: storage decides the size, not the client ────────────────────────────

describe("/complete recorded size (H5)", () => {
	it("persists the storage ContentLength, not the client-declared sum", async () => {
		storage.headContentLength = 5_000_000;

		const res = await postComplete({
			uploadId: "upload-1",
			videoId: "video-1",
			subpath: "raw-upload.webm",
			// The browser extension declares size 0 for every part.
			parts: [
				{ partNumber: 1, etag: "etag-1", size: 0 },
				{ partNumber: 2, etag: "etag-2", size: 0 },
			],
		});

		expect(res.status).toBe(200);
		expect(dbWrites.videoUploadSets).toHaveLength(1);
		expect(dbWrites.videoUploadSets[0]).toMatchObject({
			uploaded: 5_000_000,
			total: 5_000_000,
		});
	});

	it("falls back to the client sum only when storage reports no ContentLength", async () => {
		storage.headContentLength = undefined;

		const res = await postComplete({
			uploadId: "upload-1",
			videoId: "video-1",
			subpath: "raw-upload.webm",
			parts: [{ partNumber: 1, etag: "etag-1", size: 4242 }],
		});

		expect(res.status).toBe(200);
		expect(dbWrites.videoUploadSets[0]).toMatchObject({
			uploaded: 4242,
			total: 4242,
		});
	});
});
