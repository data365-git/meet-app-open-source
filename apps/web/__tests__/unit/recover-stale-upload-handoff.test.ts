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
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	/** One entry per db() select, in call order; shifted as GET runs. */
	selectResults: [] as unknown[][],
	updateCalls: 0,
	/** Raw-object size the storage head reports; null = head fails (absent). */
	contentLength: 165553362 as number | null,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => {
			const result = state.selectResults.shift() ?? [];
			const chain = () => {
				const promise = Promise.resolve(result) as Promise<unknown[]> & {
					from: () => unknown;
					innerJoin: () => unknown;
					where: () => unknown;
					limit: () => unknown;
				};
				promise.from = chain;
				promise.innerJoin = chain;
				promise.where = chain;
				promise.limit = chain;
				return promise;
			};
			return chain();
		},
		update: () => ({
			set: () => {
				state.updateCalls++;
				return { where: () => Promise.resolve({ rowsAffected: 1 }) };
			},
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
	lte: vi.fn((field: unknown, value: unknown) => ({ field, value })),
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
					headObject: () =>
						state.contentLength === null
							? Effect.fail(new Error("NoSuchKey: object absent"))
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
			rawFileKey: `owner-1/${id}/raw-upload.mp4`,
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
		state.contentLength = 165553362;
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

	it("a row younger than the staleness window is left completely untouched", async () => {
		const young = stuckUploadRow();
		young.upload.updatedAt = new Date(Date.now() - 5 * 60 * 1000);
		armStaleUploadRows([young]);
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		expect(state.updateCalls).toBe(0);
		expect(body.staleUploadRelaunched).toBe(0);
	});

	it("a stale row whose raw object is ABSENT from storage is left completely untouched", async () => {
		state.contentLength = null; // the head request finds no object
		armStaleUploadRows([stuckUploadRow()]);
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).not.toHaveBeenCalled();
		expect(state.updateCalls).toBe(0);
		expect(body.staleUploadRelaunched).toBe(0);
	});

	it("relaunches at most 3 rows per invocation, however many are eligible", async () => {
		armStaleUploadRows([1, 2, 3, 4, 5].map((n) => stuckUploadRow(`video-stuck-${n}`)));
		const { body } = await runCron();

		expect(startVideoProcessingWorkflowMock).toHaveBeenCalledTimes(3);
		expect(body.staleUploadRelaunched).toBe(3);
	});
});
