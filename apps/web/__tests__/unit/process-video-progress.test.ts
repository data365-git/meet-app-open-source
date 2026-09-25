import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 2026-08-18 wave 2, Change B — the silent optimize/save stage
 * (docs/plans/2026-08-18-upload-progress-SCOPE.md). `videoUploads` is
 * deleted as processVideoWorkflow's first step (wave 1), so
 * `videos.metadata.processingStage/processingPercent/processingUpdatedAt`
 * is the only carrier for the minutes-long ffmpeg optimize + result.mp4
 * save that follow. These tests drive the REAL `processVideoWorkflow`
 * against a fake in-memory video row; only DB/storage/ffmpeg boundaries are
 * stubbed — same mocking shape as
 * __tests__/integration/pending-ai-request.test.ts, which already proves
 * this module imports cleanly under this mock set.
 */

const state = vi.hoisted(() => ({
	videoRow: null as Record<string, unknown> | null,
}));

const schemaMocks = vi.hoisted(() => ({
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		ownerId: "videos.ownerId",
		transcriptionStatus: "videos.transcriptionStatus",
		deletedAt: "videos.deletedAt",
		duration: "videos.duration",
	},
	videoUploads: { videoId: "videoUploads.videoId" },
}));

/** The `'$.key'` paths of every JSON_REMOVE(...) call in a SQL fragment. */
function jsonRemovePaths(sqlText: string): string[] {
	const keys: string[] = [];
	const marker = "JSON_REMOVE(";
	let from = sqlText.indexOf(marker);
	while (from !== -1) {
		let depth = 1;
		let i = from + marker.length;
		for (; i < sqlText.length && depth > 0; i++) {
			if (sqlText[i] === "(") depth++;
			else if (sqlText[i] === ")") depth--;
		}
		const args = sqlText.slice(from + marker.length, i - 1);
		for (const match of args.matchAll(/'\$\.([A-Za-z0-9_]+)'/g)) {
			keys.push(match[1] as string);
		}
		from = sqlText.indexOf(marker, i);
	}
	return keys;
}

function isSqlExpression(
	value: unknown,
): value is { sql: string; values: unknown[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { sql?: unknown }).sql === "string"
	);
}

/** Applies a drizzle `sql` metadata expression to a plain object the way
 * MySQL would — copied from pending-ai-request.test.ts's proven helper. */
function applyJsonSet(
	expression: { sql: string; values: unknown[] },
	current: Record<string, unknown>,
): Record<string, unknown> {
	let next = { ...current };
	for (const value of expression.values) {
		if (isSqlExpression(value)) next = applyJsonSet(value, next);
	}
	for (const key of jsonRemovePaths(expression.sql)) delete next[key];
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
				where: () => ({
					limit: () => Promise.resolve(state.videoRow ? [state.videoRow] : []),
				}),
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: () => {
					if (state.videoRow) {
						for (const [key, value] of Object.entries(values)) {
							if (key === "metadata" && isSqlExpression(value)) {
								state.videoRow.metadata = applyJsonSet(
									value,
									(state.videoRow.metadata as Record<string, unknown>) ?? {},
								);
							} else {
								state.videoRow[key] = value;
							}
						}
					}
					return Promise.resolve([{ affectedRows: 1 }]);
				},
			}),
		}),
		delete: () => ({ where: () => Promise.resolve([]) }),
	}),
}));

vi.mock("@cap/database/schema", () => schemaMocks);

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({
		GEMINI_API_KEY: "test-gemini-api-key",
		DATABASE_URL: "mysql://test@localhost/test",
	})),
}));

vi.mock("@cap/web-domain", () => ({ Video: {} }));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	isNull: vi.fn((field: unknown) => ({ isNull: field })),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		sql: strings.join("?"),
		values,
	})),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));

vi.mock("@/lib/video-storage", () => ({
	getStorageAccessForVideo: vi.fn(() => ({
		pipe: () =>
			Promise.resolve([
				{
					getInternalSignedObjectUrl: () => ({
						pipe: () => Promise.resolve("https://storage.test/raw.mp4"),
					}),
					putObject: () => ({ pipe: () => Promise.resolve(undefined) }),
				},
			]),
	})),
}));

const optimizeMock = vi.hoisted(() => vi.fn());
const probeMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ durationSec: 42 })));

vi.mock("@/lib/video-convert", () => ({
	optimizeRemoteVideoToMp4: optimizeMock,
	probeRemoteVideo: probeMock,
}));

vi.mock("@/lib/video-alive", () => ({
	assertVideoNotDeleted: vi.fn(() => Promise.resolve()),
}));

const VIDEO_ID = "kc45xjnar36v9gg";

function freshVideoRow() {
	return {
		id: VIDEO_ID,
		ownerId: "user-1",
		transcriptionStatus: "SKIPPED",
		deletedAt: null,
		metadata: {},
	};
}

const optimizedFile = { path: "" };

describe("processVideoWorkflow — silent optimize/save stage carrier", () => {
	beforeAll(async () => {
		optimizedFile.path = join(tmpdir(), `process-video-progress-${Date.now()}.mp4`);
		await fs.writeFile(optimizedFile.path, Buffer.from([0, 1, 2, 3]));
	});

	afterAll(async () => {
		await fs.rm(optimizedFile.path, { force: true });
	});

	beforeEach(() => {
		vi.clearAllMocks();
		state.videoRow = freshVideoRow();
		optimizeMock.mockReset();
		probeMock.mockReset();
		probeMock.mockImplementation(() => Promise.resolve({ durationSec: 42 }));
	});

	it("writes metadata.processingStage/processingPercent while optimizing, then clears all three on success", async () => {
		optimizeMock.mockImplementation(
			(_url: string, options: { onProgress?: (percent: number | null) => void }) => {
				options.onProgress?.(10);
				options.onProgress?.(55);
				return Promise.resolve({
					filePath: optimizedFile.path,
					metadata: { durationSec: 42 },
					cleanup: () => Promise.resolve(),
				});
			},
		);

		const { processVideoWorkflow } = await import("@/workflows/process-video");
		const result = await processVideoWorkflow({
			videoId: VIDEO_ID,
			userId: "user-1",
			rawFileKey: "raw/key.mp4",
			bucketId: null,
		});

		expect(result.success).toBe(true);
		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		// Cleared — none of the three keys survive past the step.
		expect(metadata.processingStage).toBeUndefined();
		expect(metadata.processingPercent).toBeUndefined();
		expect(metadata.processingUpdatedAt).toBeUndefined();
	});

	it("clears all three metadata fields on the failure path too (optimize rejects)", async () => {
		optimizeMock.mockImplementation(
			(_url: string, options: { onProgress?: (percent: number | null) => void }) => {
				options.onProgress?.(20);
				return Promise.reject(new Error("ffmpeg exploded"));
			},
		);

		const { processVideoWorkflow } = await import("@/workflows/process-video");
		const result = await processVideoWorkflow({
			videoId: VIDEO_ID,
			userId: "user-1",
			rawFileKey: "raw/key.mp4",
			bucketId: null,
		});

		// optimizeAndFinalizeVideo swallows a plain optimize failure (raw upload
		// stays playable) — the WORKFLOW still reports success.
		expect(result.success).toBe(true);
		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		expect(metadata.processingStage).toBeUndefined();
		expect(metadata.processingPercent).toBeUndefined();
		expect(metadata.processingUpdatedAt).toBeUndefined();
	});
});

// 2026-09-25 prod incident: a rowless video with transcriptionStatus NULL and
// a complete raw upload was indistinguishable from a finished one — nothing
// durable recorded that processing had actually finished.
describe("processVideoWorkflow — durable processedAt marker", () => {
	beforeAll(async () => {
		optimizedFile.path = join(tmpdir(), `process-video-marker-${Date.now()}.mp4`);
		await fs.writeFile(optimizedFile.path, Buffer.from([0, 1, 2, 3]));
	});

	afterAll(async () => {
		await fs.rm(optimizedFile.path, { force: true });
	});

	beforeEach(() => {
		vi.clearAllMocks();
		state.videoRow = freshVideoRow();
		optimizeMock.mockReset();
		probeMock.mockReset();
		probeMock.mockImplementation(() => Promise.resolve({ durationSec: 42 }));
	});

	const run = async () => {
		const { processVideoWorkflow } = await import("@/workflows/process-video");
		return processVideoWorkflow({
			videoId: VIDEO_ID,
			userId: "user-1",
			rawFileKey: "raw/key.mp4",
			bucketId: null,
		});
	};

	it("writes metadata.processedAt (ISO) on a successful run, surviving the progress cleanup", async () => {
		optimizeMock.mockImplementation(() =>
			Promise.resolve({
				filePath: optimizedFile.path,
				metadata: { durationSec: 42 },
				cleanup: () => Promise.resolve(),
			}),
		);
		const before = Date.now();

		const result = await run();

		expect(result.success).toBe(true);
		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		expect(typeof metadata.processedAt).toBe("string");
		const stamped = Date.parse(metadata.processedAt as string);
		expect(new Date(stamped).toISOString()).toBe(metadata.processedAt);
		expect(stamped).toBeGreaterThanOrEqual(before - 1000);
		expect(metadata.processingStage).toBeUndefined();
		// The run's own life sign, written when it deleted the upload row.
		expect(Date.parse(metadata.processingRunAt as string)).toBeGreaterThanOrEqual(
			before - 1000,
		);
	});

	it("writes metadata.processedAt on the benign optimize-skipped branch (raw kept playable)", async () => {
		optimizeMock.mockImplementation(() =>
			Promise.reject(new Error("optimize skipped")),
		);

		const result = await run();

		expect(result.success).toBe(true);
		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		expect(typeof metadata.processedAt).toBe("string");
		expect(Number.isNaN(Date.parse(metadata.processedAt as string))).toBe(false);
	});

	it("does NOT write metadata.processedAt when the run fails terminally (stays recoverable)", async () => {
		const { getStorageAccessForVideo } = await import("@/lib/video-storage");
		vi.mocked(getStorageAccessForVideo).mockImplementationOnce(
			() =>
				({
					pipe: () => Promise.reject(new Error("storage misconfigured")),
				}) as never,
		);

		await expect(run()).rejects.toThrow("storage misconfigured");

		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		expect(metadata.processedAt).toBeUndefined();
	});
});

describe("shouldWriteProcessingProgress — throttle", () => {
	it("writes at most once per 5s of simulated time, and skips a write when the integer percent is unchanged", async () => {
		const { shouldWriteProcessingProgress } = await import(
			"@/workflows/process-video"
		);

		const writerState = {
			lastWriteAt: -Infinity,
			lastStage: "optimizing" as const,
			lastPercent: undefined as number | null | undefined,
		};
		const writes: { now: number; percent: number }[] = [];

		// A tick every 500ms for 20s, percent climbing by 1 each tick — plenty
		// of percent changes, so the throttle (not "unchanged percent") is what
		// must be gating most of them.
		for (let i = 0; i < 40; i++) {
			const now = i * 500;
			const percent = i;
			if (
				shouldWriteProcessingProgress(writerState, {
					now,
					stage: "optimizing",
					percent,
				})
			) {
				writerState.lastWriteAt = now;
				writerState.lastPercent = Math.round(percent);
				writes.push({ now, percent });
			}
		}

		expect(writes.length).toBeGreaterThan(1);
		for (let i = 1; i < writes.length; i++) {
			expect((writes[i] as { now: number }).now - (writes[i - 1] as { now: number }).now).toBeGreaterThanOrEqual(5000);
		}
	});

	it("skips a write when the integer percent is unchanged even after the throttle window elapses", async () => {
		const { shouldWriteProcessingProgress } = await import(
			"@/workflows/process-video"
		);

		const writerState = {
			lastWriteAt: -Infinity,
			lastStage: "optimizing" as const,
			lastPercent: undefined as number | null | undefined,
		};
		const ticks = [
			{ now: 0, percent: 10 },
			{ now: 6000, percent: 10 },
			{ now: 12000, percent: 10 },
		];
		const writes: typeof ticks = [];
		for (const tick of ticks) {
			if (
				shouldWriteProcessingProgress(writerState, {
					now: tick.now,
					stage: "optimizing",
					percent: tick.percent,
				})
			) {
				writerState.lastWriteAt = tick.now;
				writerState.lastPercent = Math.round(tick.percent);
				writes.push(tick);
			}
		}

		expect(writes).toEqual([{ now: 0, percent: 10 }]);
	});

	// FINDING 3: `write("saving", null)` fires once and every later call with
	// the same stage/percent is suppressed — a putObject of a large result.mp4
	// running past PROCESSING_STAGE_STALE_MS (5 min) then reads as dead. A
	// heartbeat write must go out even with nothing changed, well before that
	// 5-minute cutoff.
	it("writes a heartbeat when unchanged for a long time, even though percent never moves", async () => {
		const { shouldWriteProcessingProgress } = await import(
			"@/workflows/process-video"
		);

		const writerState = {
			lastWriteAt: -Infinity,
			lastStage: "saving" as const,
			lastPercent: undefined as number | null | undefined,
		};
		const ticks = [
			{ now: 0, percent: null },
			{ now: 30_000, percent: null }, // under the heartbeat interval: suppressed
			{ now: 65_000, percent: null }, // past it: a heartbeat write must fire
		];
		const writes: typeof ticks = [];
		for (const tick of ticks) {
			if (
				shouldWriteProcessingProgress(writerState, {
					now: tick.now,
					stage: "saving",
					percent: tick.percent,
				})
			) {
				writerState.lastWriteAt = tick.now;
				writerState.lastPercent = tick.percent;
				writes.push(tick);
			}
		}

		expect(writes).toEqual([
			{ now: 0, percent: null },
			{ now: 65_000, percent: null },
		]);
	});
});
