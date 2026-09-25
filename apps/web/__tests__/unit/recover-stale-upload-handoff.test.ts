/**
 * Outcome pins for the lost-processing-hand-off recovery pass in
 * recover-stale-ai-jobs (2026-09-10 incident: ~15% of uploads finished every
 * byte into storage, then sat at phase='uploading' forever because the
 * fire-and-forget startVideoProcessingWorkflow call never took effect — and
 * left no marker the other recovery loops could see).
 *
 * Every assertion is on WHAT THE CRON DECIDED TO DO (relaunch the pipeline
 * with forceRestart, or leave the row completely alone, and how many), never
 * on a function having been called for its own sake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	/** One entry per db() select, in call order; shifted as GET runs. */
	selectResults: [] as unknown[][],
	updateCalls: 0,
	/** Every update().set() argument, in call order. */
	setArgs: [] as Record<string, unknown>[],
	/** Every insert().values() argument, in call order. */
	inserts: [] as Record<string, unknown>[],
	/** Raw-object size the storage head reports; null = head fails. */
	contentLength: 165553362 as number | null,
	/** When the head fails, was it a real 404 or an unreachable bucket? */
	headFailure: "notfound" as "notfound" | "unreachable",
	/** The edit source (source/original.mp4) — absent unless a test says so. */
	editSource: "absent" as "absent" | "present" | "unreachable",
	/** affectedRows the INSERT IGNORE claim reports (0 = a row already existed). */
	insertAffected: 1,
	/** Arguments of the LAST where() on a select — the stale-upload scan's. */
	lastSelectWhere: [] as unknown[],
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			const result = state.selectResults.shift() ?? [];
			const chain = () => {
				const promise = Promise.resolve(result) as Promise<unknown[]> & {
					from: () => unknown;
					innerJoin: () => unknown;
					leftJoin: () => unknown;
					orderBy: () => unknown;
					where: () => unknown;
					limit: () => unknown;
				};
				promise.from = chain;
				promise.innerJoin = chain;
				promise.leftJoin = chain;
				promise.orderBy = chain;
				promise.where = (...args: unknown[]) => {
					state.lastSelectWhere = args;
					return chain();
				};
				promise.limit = chain;
				return promise;
			};
			return chain();
		},
		update: () => ({
			set: (arg: Record<string, unknown>) => {
				state.updateCalls++;
				state.setArgs.push(arg);
				// mysql2 hands drizzle a [ResultSetHeader, FieldPacket[]] tuple; the
				// bare-object shape is a different driver's and was never exercised
				// here, so the production path went untested.
				return { where: () => Promise.resolve([{ affectedRows: 1 }]) };
			},
		}),
		insert: () => ({
			ignore: () => ({
				values: (arg: Record<string, unknown>) => {
					state.inserts.push(arg);
					return Promise.resolve([{ affectedRows: state.insertAffected }]);
				},
			}),
		}),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		name: "videos.name",
		metadata: "videos.metadata",
		transcriptionStatus: "videos.transcriptionStatus",
		deletedAt: "videos.deletedAt",
		createdAt: "videos.createdAt",
	},
	videoUploads: {
		videoId: "videoUploads.videoId",
		phase: "videoUploads.phase",
		updatedAt: "videoUploads.updatedAt",
		rawFileKey: "videoUploads.rawFileKey",
		mode: "videoUploads.mode",
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values })),
	isNotNull: vi.fn((field: unknown) => ({ isNotNull: field })),
	isNull: vi.fn((field: unknown) => ({ isNull: field })),
	like: vi.fn((field: unknown, pattern: unknown) => ({ like: field, pattern })),
	or: vi.fn((...args: unknown[]) => ({ or: args })),
	lte: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	gte: vi.fn((field: unknown, value: unknown) => ({ gte: field, value })),
	sql: Object.assign(
		vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
			strings,
			values,
		})),
		{ raw: vi.fn((s: string) => s) },
	),
}));

vi.mock("next/server", () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number }) => ({
			status: init?.status ?? 200,
			json: async () => body,
		}),
	},
}));

vi.mock("@/lib/ops-alert", () => ({
	sendOpsAlert: vi.fn(() => Promise.resolve()),
}));

vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: vi.fn(() => Promise.resolve({ success: true })),
}));

const startVideoProcessingWorkflowMock = vi.hoisted(() =>
	vi.fn(() => Promise.resolve("started")),
);
vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: startVideoProcessingWorkflowMock,
}));

// Real Effects for the storage boundary, executed through a plain runPromise —
// the headObject mock fails or succeeds per test via state.contentLength.
vi.mock("@/lib/server", async () => {
	const { Effect } = await import("effect");
	return {
		runPromise: (effect: unknown) => Effect.runPromise(effect as never),
	};
});

vi.mock("@/lib/video-storage", async () => {
	const { Effect } = await import("effect");
	return {
		getStorageAccessForVideo: () =>
			Effect.succeed([
				{
					headObject: (key: string) =>
						key.endsWith("/source/original.mp4")
							? state.editSource === "present"
								? Effect.succeed({ ContentLength: 1000 })
								: Effect.fail(
										state.editSource === "unreachable"
											? Object.assign(new Error("connect ETIMEDOUT"), {
													name: "TimeoutError",
												})
											: Object.assign(new Error("Object not found"), {
													name: "NoSuchKey",
												}),
									)
							: state.contentLength === null
							? Effect.fail(
									state.headFailure === "notfound"
										? Object.assign(new Error("Object not found"), {
												name: "NoSuchKey",
											})
										: Object.assign(new Error("connect ETIMEDOUT"), {
												name: "TimeoutError",
											}),
								)
							: Effect.succeed({ ContentLength: state.contentLength }),
				},
			]),
	};
});

const { GET } = await import("@/app/api/cron/recover-stale-ai-jobs/route");

const CRON_SECRET = "test-cron-secret";

function cronRequest(): Request {
	return {
		headers: {
			get: (name: string) =>
				name.toLowerCase() === "authorization" ? `Bearer ${CRON_SECRET}` : null,
		},
	} as unknown as Request;
}

const HOUR_MS = 60 * 60 * 1000;

/** One of the measured production rows: phase 'uploading', uploaded == total,
 * mode NULL, every byte in storage, updated an hour ago. */
function stuckUploadRow(id = "video-stuck") {
	return {
		video: {
			id,
			ownerId: "owner-1",
			orgId: "org-1",
			name: "Stuck upload",
			bucket: null,
			metadata: { isAudio: true },
			deletedAt: null,
		},
		upload: {
			videoId: id,
			phase: "uploading",
			uploaded: 165553362,
			total: 165553362,
			mode: null,
			// Nullable on purpose: the measured production rows carried NULL here,
			// and one test sets it to null to pin that path.
			rawFileKey: `owner-1/${id}/raw-upload.mp4` as string | null,
			updatedAt: new Date(Date.now() - HOUR_MS),
		},
	};
}

/** Arms the fake DB: the five earlier candidate queries match nothing; the
 * stale-upload hand-off pass (6th db() call) sees `rows`. */
function armStaleUploadRows(rows: unknown[]) {
	state.selectResults = [[], [], [], [], [], rows];
}

async function runCron() {
	const response = await GET(cronRequest());
	return { body: (await response.json()) as Record<string, unknown> };
}

describe("recover-stale-ai-jobs — lost processing hand-off (stale upload rows)", () => {
	beforeEach(() => {
		state.selectResults = [];
		state.updateCalls = 0;
		state.setArgs = [];
		state.inserts = [];
		startVideoProcessingWorkflowMock.mockClear();
		state.contentLength = 165553362;
		state.headFailure = "notfound";
		process.env.CRON_SECRET = CRON_SECRET;
	});

	it("a stale 'uploading' row whose raw object is present is relaunched with forceRestart", async () => {
		armStaleUploadRows([stuckUploadRow()]);
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).toHaveBeenCalledTimes(1);
		expect(startVideoProcessingWorkflowMock).toHaveBeenCalledWith(
			expect.objectContaining({
				videoId: "video-stuck",
				userId: "owner-1",
				rawFileKey: "owner-1/video-stuck/raw-upload.mp4",
				forceRestart: true,
			}),
		);
		expect(body.staleUploadRelaunched).toBe(1);
	});

	it("recovers a row that recorded NO rawFileKey, by deriving the canonical key", async () => {
		// THIS is the shape the production incident actually had, measured on
		// 2026-09-10: every stuck row carried `raw_file_key IS NULL` and
		// `mode IS NULL`. An earlier version of this pass required the column to
		// be set and would therefore have recovered NOTHING - the same mistake
		// as the marker the old cron keyed on, a condition only the successful
		// path fills in. The key is derivable from owner and video id, so the
		// pass probes it instead of trusting the column.
		const row = stuckUploadRow("video-nokey");
		row.upload.rawFileKey = null;
		armStaleUploadRows([row]);
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).toHaveBeenCalledTimes(1);
		expect(startVideoProcessingWorkflowMock).toHaveBeenCalledWith(
			expect.objectContaining({
				videoId: "video-nokey",
				rawFileKey: "owner-1/video-nokey/raw-upload.mp4",
				forceRestart: true,
			}),
		);
		expect(body.staleUploadRelaunched).toBe(1);
	});

	it("a row younger than the staleness window is left completely untouched", async () => {
		const young = stuckUploadRow();
		young.upload.updatedAt = new Date(Date.now() - 5 * 60 * 1000);
		armStaleUploadRows([young]);
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		expect(state.updateCalls).toBe(0);
		expect(body.staleUploadRelaunched).toBe(0);
	});

	it("a stale row whose raw object is ABSENT is never relaunched, and is RETIRED so it stops starving live rows", async () => {
		// Changed deliberately on 2026-09-10 after a blind review: leaving such a
		// row alone forever was the bug, not the fix. A row created with a
		// rawFileKey at phase 'uploading' and then abandoned never gets an
		// object and nothing else removes it, so three of them would occupy the
		// candidate set on every tick and starve every genuinely stuck upload —
		// a safety net that exists and never fires. It must never be relaunched
		// (the bytes are not there), and it must leave the set.
		state.contentLength = null; // the head request finds no object
		armStaleUploadRows([stuckUploadRow()]);
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		expect(body.staleUploadRelaunched).toBe(0);
		expect(body.staleUploadRetired).toBe(1);
		// Exactly one write: the retirement. Not a relaunch claim.
		expect(state.updateCalls).toBe(1);
	});

	it("when STORAGE cannot be reached it retires nothing and writes nothing", async () => {
		// The most damaging failure this pass could have: a blind review caught
		// that a boolean probe made "bucket unreachable" look identical to
		// "object genuinely gone", and an absent object gets the row retired.
		// One expired credential or a brief outage would then have condemned a
		// whole scan's worth of healthy, bytes-present uploads with a false
		// "Upload never completed" that only a manual retry undoes - and the
		// user this pass exists for never clicks it. Only a real 404 may mean
		// absent; anything else must wait for the next tick.
		state.contentLength = null;
		state.headFailure = "unreachable";
		armStaleUploadRows([stuckUploadRow(), stuckUploadRow("video-stuck-2")]);
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		expect(body.staleUploadRelaunched).toBe(0);
		expect(body.staleUploadRetired).toBe(0);
		expect(state.updateCalls).toBe(0);
	});

	it("NEVER relaunches a row whose key is an edit source or a result.mp4", async () => {
		// A blind review caught this on 2026-09-10. video_uploads rows are also
		// written by the editor (`<owner>/<video>/source/original.mp4`) and by
		// admin reprocess (`result.mp4`). Relaunching either re-encodes the
		// WRONG source: a trim whose row-delete was lost would be silently
		// reverted half an hour later, and a finished video would be re-encoded
		// onto itself. Only keys the upload-completion routes write are ours.
		const editRow = stuckUploadRow("video-edit-1");
		editRow.upload.rawFileKey = "user-1/video-edit-1/source/original.mp4";
		const reprocessRow = stuckUploadRow("video-reprocess-1");
		reprocessRow.upload.rawFileKey = "user-1/video-reprocess-1/result.mp4";
		armStaleUploadRows([editRow, reprocessRow]);
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		expect(body.staleUploadRelaunched).toBe(0);
		// Not ours to retire either — the editor has its own reconciler.
		expect(body.staleUploadRetired).toBe(0);
		expect(state.updateCalls).toBe(0);
	});

	it("relaunches at most 3 rows per invocation, however many are eligible", async () => {
		armStaleUploadRows([1, 2, 3, 4, 5].map((n) => stuckUploadRow(`video-stuck-${n}`)));
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).toHaveBeenCalledTimes(3);
		expect(body.staleUploadRelaunched).toBe(3);
	});
});

/** The 2026-09-25 prod shape: NO video_uploads row, transcriptionStatus NULL,
 * metadata {isAudio:true}, a complete raw-upload.mp4, never processed. */
function rowlessRow(id = "video-rowless") {
	return {
		video: {
			id,
			ownerId: "owner-1",
			orgId: "org-1",
			name: "Rowless upload",
			bucket: null,
			// processingRunAt = a new-code processing run started an hour ago and
			// then died (no processedAt, no progress since).
			metadata: {
				isAudio: true,
				processingRunAt: new Date(Date.now() - HOUR_MS).toISOString(),
			} as Record<string, unknown>,
			deletedAt: null as Date | null,
			transcriptionStatus: null as string | null,
			createdAt: new Date(Date.now() - HOUR_MS),
		},
		upload: null,
	};
}

function metadataSqlText(arg: Record<string, unknown>): string {
	const metadata = arg.metadata as
		| { strings?: TemplateStringsArray }
		| undefined;
	return metadata?.strings ? metadata.strings.join("?") : "";
}

describe("recover-stale-ai-jobs — rowless lost upload (no video_uploads row)", () => {
	beforeEach(() => {
		state.selectResults = [];
		state.updateCalls = 0;
		state.setArgs = [];
		state.inserts = [];
		startVideoProcessingWorkflowMock.mockClear();
		state.contentLength = 165553362;
		state.headFailure = "notfound";
		state.editSource = "absent";
		state.insertAffected = 1;
		state.lastSelectWhere = [];
		process.env.CRON_SECRET = CRON_SECRET;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("rowless + no processedAt + after the cutoff + raw object present → relaunched through a recreated upload row", async () => {
		armStaleUploadRows([rowlessRow()]);
		const { body } = await runCron();

		expect(state.inserts).toEqual([
			expect.objectContaining({
				videoId: "video-rowless",
				phase: "processing",
				rawFileKey: "owner-1/video-rowless/raw-upload.mp4",
			}),
		]);
		expect(startVideoProcessingWorkflowMock).toHaveBeenCalledTimes(1);
		expect(startVideoProcessingWorkflowMock).toHaveBeenCalledWith(
			expect.objectContaining({
				videoId: "video-rowless",
				rawFileKey: "owner-1/video-rowless/raw-upload.mp4",
				forceRestart: true,
			}),
		);
		// The per-video budget is booked before the launch.
		expect(
			state.setArgs.some((arg) =>
				metadataSqlText(arg).includes("$.rowlessRelaunchAttempts"),
			),
		).toBe(true);
		expect(body.staleUploadRowlessRelaunched).toBe(1);
		expect(body.staleUploadRelaunched).toBe(0);
	});

	function expectUntouched(body: Record<string, unknown>) {
		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		expect(state.inserts).toEqual([]);
		expect(state.updateCalls).toBe(0);
		expect(body.staleUploadRowlessRelaunched).toBe(0);
	}

	it("the same video WITH metadata.processedAt (processed fine) is left untouched", async () => {
		const row = rowlessRow();
		row.video.metadata.processedAt = new Date(Date.now() - HOUR_MS).toISOString();
		armStaleUploadRows([row]);
		expectUntouched((await runCron()).body);
	});

	it("a finished Loom import (processedAt written by completeImport) is left untouched", async () => {
		const row = rowlessRow("video-loom");
		row.video.metadata = {
			titleOrigin: "user",
			processedAt: new Date(Date.now() - HOUR_MS).toISOString(),
		};
		armStaleUploadRows([row]);
		expectUntouched((await runCron()).body);
	});

	it("a video with NO processingRunAt (no new-code run ever started — e.g. it predates the marker) is left untouched", async () => {
		const row = rowlessRow();
		delete row.video.metadata.processingRunAt;
		armStaleUploadRows([row]);
		expectUntouched((await runCron()).body);
	});

	it("a deleted video is left untouched", async () => {
		const row = rowlessRow();
		row.video.deletedAt = new Date();
		armStaleUploadRows([row]);
		expectUntouched((await runCron()).body);
	});

	it("a video already relaunched twice (rowlessRelaunchAttempts >= 2) is left untouched", async () => {
		const row = rowlessRow();
		row.video.metadata.rowlessRelaunchAttempts = 2;
		armStaleUploadRows([row]);
		expectUntouched((await runCron()).body);
	});

	it("a run still alive (fresh optimize progress heartbeat) is left untouched", async () => {
		const row = rowlessRow();
		row.video.metadata.processingUpdatedAt = new Date(
			Date.now() - 60 * 1000,
		).toISOString();
		armStaleUploadRows([row]);
		expectUntouched((await runCron()).body);
	});

	it("raw object ABSENT → never relaunched, no upload row recreated", async () => {
		state.contentLength = null; // real 404 for both canonical names
		armStaleUploadRows([rowlessRow()]);
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		expect(state.inserts).toEqual([]);
		expect(body.staleUploadRowlessRelaunched).toBe(0);
	});

	it("the cap of 3 per tick is SHARED with the row-backed relaunches", async () => {
		armStaleUploadRows([
			stuckUploadRow("video-stuck-1"),
			stuckUploadRow("video-stuck-2"),
			rowlessRow("video-rowless-1"),
			rowlessRow("video-rowless-2"),
			rowlessRow("video-rowless-3"),
		]);
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).toHaveBeenCalledTimes(3);
		expect(body.staleUploadRelaunched).toBe(2);
		expect(body.staleUploadRowlessRelaunched).toBe(1);
	});
});

describe("recover-stale-ai-jobs — rowless pass: review fixes (2026-09-25)", () => {
	beforeEach(() => {
		state.selectResults = [];
		state.updateCalls = 0;
		state.setArgs = [];
		state.inserts = [];
		startVideoProcessingWorkflowMock.mockClear();
		state.contentLength = 165553362;
		state.headFailure = "notfound";
		state.editSource = "absent";
		state.insertAffected = 1;
		state.lastSelectWhere = [];
		process.env.CRON_SECRET = CRON_SECRET;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function expectNoRelaunch(body: Record<string, unknown>) {
		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		expect(body.staleUploadRowlessRelaunched).toBe(0);
	}

	it("an EDITED video (source/original.mp4 present) is never relaunched from its pre-edit raw", async () => {
		state.editSource = "present";
		armStaleUploadRows([rowlessRow()]);
		const { body } = await runCron();

		expectNoRelaunch(body);
		expect(state.inserts).toEqual([]);
		expect(state.updateCalls).toBe(0);
	});

	it("when the edit-source probe cannot reach storage, nothing is relaunched", async () => {
		state.editSource = "unreachable";
		armStaleUploadRows([rowlessRow()]);
		const { body } = await runCron();

		expectNoRelaunch(body);
		expect(state.inserts).toEqual([]);
		expect(state.updateCalls).toBe(0);
	});

	it("a live run that just deleted its row (fresh processingRunAt, no progress yet) is left untouched", async () => {
		const row = rowlessRow();
		row.video.metadata.processingRunAt = new Date(
			Date.now() - 60 * 1000,
		).toISOString();
		armStaleUploadRows([row]);
		const { body } = await runCron();

		expectNoRelaunch(body);
		expect(state.inserts).toEqual([]);
		expect(state.updateCalls).toBe(0);
	});

	it("when the INSERT IGNORE claim affects 0 rows (a row appeared meanwhile), nothing is launched", async () => {
		state.insertAffected = 0;
		armStaleUploadRows([rowlessRow()]);
		const { body } = await runCron();

		expect(state.inserts).toHaveLength(1);
		expectNoRelaunch(body);
	});

	it("the scan SQL carries every rowless predicate", async () => {
		armStaleUploadRows([]);
		await runCron();

		// Dates serialise to their ISO string.
		const flat = JSON.stringify(state.lastSelectWhere);
		expect(flat).toContain('{"isNull":"videoUploads.videoId"}');
		expect(flat).toContain('{"isNull":"videos.transcriptionStatus"}');
		expect(flat).toContain("$.processedAt') IS NULL");
		expect(flat).toContain("$.processingRunAt') IS NOT NULL");
		expect(flat).toContain("$.processingRunAt");
		expect(flat).toContain("$.rowlessRelaunchAttempts') AS UNSIGNED), 0) < ");
	});
});