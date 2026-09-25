import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A finished Loom import writes a raw-upload.mp4, deletes its upload row and
 * never runs processVideoWorkflow — so without a durable success marker it is
 * indistinguishable from "processing died after deleting the row", and the
 * recover-stale-ai-jobs rowless pass would relaunch every finished Loom
 * import. Drives the REAL importLoomVideoWorkflow; only DB / storage / network
 * boundaries are stubbed.
 */

const state = vi.hoisted(() => ({
	videoRow: null as Record<string, unknown> | null,
	putStatus: 200,
}));

function isSqlExpression(
	value: unknown,
): value is { sql: string; values: unknown[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { sql?: unknown }).sql === "string"
	);
}

/** Applies a drizzle JSON_SET metadata expression to a plain object. */
function applyJsonSet(
	expression: { sql: string; values: unknown[] },
	current: Record<string, unknown>,
): Record<string, unknown> {
	const next = { ...current };
	const segments = expression.sql.split("?");
	for (let i = 0; i < segments.length - 1; i++) {
		const match = /'\$\.([A-Za-z0-9_]+)'\s*,\s*$/.exec(segments[i] ?? "");
		if (match?.[1]) next[match[1]] = expression.values[i];
	}
	return next;
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => Promise.resolve(state.videoRow ? [state.videoRow] : []),
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: () => {
					if (state.videoRow && isSqlExpression(values.metadata)) {
						state.videoRow.metadata = applyJsonSet(
							values.metadata,
							(state.videoRow.metadata as Record<string, unknown>) ?? {},
						);
					}
					return Promise.resolve([{ affectedRows: 1 }]);
				},
			}),
		}),
		delete: () => ({ where: () => Promise.resolve([]) }),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: { id: "videos.id", metadata: "videos.metadata" },
	videoUploads: { videoId: "videoUploads.videoId" },
}));

vi.mock("@cap/env", () => ({ serverEnv: vi.fn(() => ({})) }));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		sql: strings.join("?"),
		values,
	})),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("@cap/web-domain", () => ({
	Video: {
		VideoId: { make: (id: string) => id },
		Video: { decodeSync: (value: unknown) => value },
	},
}));

vi.mock("@cap/web-backend", async () => {
	const { Effect } = await import("effect");
	return {
		validateLoomDownloadUrl: (url: string) => new URL(url),
		Storage: {
			getAccessForVideo: () =>
				Effect.succeed([
					{
						getInternalPresignedPutUrl: () =>
							Effect.succeed("https://storage.test/put-raw-upload"),
					},
				]),
		},
	};
});

vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return { runPromise: (effect: unknown) => Effect.runPromise(effect as never) };
});

const VIDEO_ID = "loomvideo123456";

function freshVideoRow() {
	return {
		id: VIDEO_ID,
		ownerId: "owner-1",
		bucket: null,
		storageIntegrationId: null,
		createdAt: new Date(),
		updatedAt: new Date(),
		metadata: {},
	};
}

function stubNetwork() {
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string) => {
			if (url.startsWith("https://www.loom.com/api/")) {
				return new Response(
					JSON.stringify({ url: "https://cdn.loom.com/sessions/raw/video.mp4" }),
					{ status: 200 },
				);
			}
			if (url.startsWith("https://cdn.loom.com/")) {
				return new Response(new Uint8Array(4096), {
					status: 200,
					headers: { "content-type": "video/mp4" },
				});
			}
			return new Response(null, { status: state.putStatus });
		}),
	);
}

const run = async () => {
	const { importLoomVideoWorkflow } = await import("@/workflows/import-loom-video");
	return importLoomVideoWorkflow({
		videoId: VIDEO_ID,
		userId: "owner-1",
		rawFileKey: `owner-1/${VIDEO_ID}/raw-upload.mp4`,
		bucketId: null,
		loomDownloadUrl: "https://cdn.loom.com/sessions/raw/video.mp4",
		loomVideoId: "abc123",
	});
};

describe("importLoomVideoWorkflow — durable processedAt marker", () => {
	beforeEach(() => {
		state.videoRow = freshVideoRow();
		state.putStatus = 200;
		stubNetwork();
	});

	it("a finished Loom import writes metadata.processedAt (ISO)", async () => {
		const result = await run();

		expect(result.success).toBe(true);
		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		expect(typeof metadata.processedAt).toBe("string");
		expect(new Date(Date.parse(metadata.processedAt as string)).toISOString()).toBe(
			metadata.processedAt,
		);
	});

	it("a failed Loom import writes no marker", async () => {
		state.putStatus = 500;

		await expect(run()).rejects.toThrow("Failed to upload to S3");

		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		expect(metadata.processedAt).toBeUndefined();
	});
});
