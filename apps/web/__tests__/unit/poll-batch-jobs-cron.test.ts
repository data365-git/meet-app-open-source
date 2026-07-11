import { beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for the durable-Batch collector cron (poll-batch-jobs GET).
// This code runs UNATTENDED, spends money (paid Batch) and moves transcription
// data, so its branch behavior is the highest-risk untested surface. Each test
// drives the real GET handler with mocked db/storage/gemini and asserts the
// orchestration: succeeded → merge+usage+re-kick, failed → drop+re-kick, pending
// → keep, no-longer-cheap → cancel+clear, and — critically — a storage read
// error on a succeeded batch KEEPS the job (never overwrites a real partial and
// never re-kicks on an ambiguous read).

const H = vi.hoisted(() => ({
	candidates: [] as Array<{ video: unknown }>,
	collectResult: undefined as unknown,
	// storage
	getObjectResult: { _tag: "Some", value: "WEBVTT\n\nEXISTING" } as unknown,
	getObjectThrows: false,
	getObject: vi.fn((_k: string) => {}),
	putObject: vi.fn((_k: string, _b: string, _o: unknown) => {}),
	// spies
	cancelBatch: vi.fn(async (_n: string, _k: string) => {}),
	deleteBatchFile: vi.fn(async (_n: string, _k: string) => {}),
	collectBatchResult: vi.fn((_n: string, _o: unknown) => undefined as unknown),
	transcribeVideo: vi.fn(async (..._a: unknown[]) => ({ success: true })),
	patchVideoMetadata: vi.fn(
		async (_id: string, _u: (m: Record<string, unknown>) => unknown) =>
			undefined as unknown,
	),
	insertUsage: vi.fn(async () => {}),
	updateVideo: vi.fn(async (_v: unknown) => {}),
	// the metadata patchVideoMetadata applies its updater to
	currentMetadata: {} as Record<string, unknown>,
	geminiKey: "server-paid-key" as string | undefined,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({ from: () => ({ where: async () => H.candidates }) }),
		insert: () => ({
			values: () => ({ onDuplicateKeyUpdate: async () => H.insertUsage() }),
		}),
		update: () => ({
			set: (v: unknown) => ({ where: async () => H.updateVideo(v) }),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({
	aiUsageEvents: { id: "aiUsageEvents.id" },
	videos: {
		id: "videos.id",
		metadata: "videos.metadata",
		deletedAt: "videos.deletedAt",
	},
}));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ GEMINI_API_KEY: H.geminiKey }),
}));
vi.mock("@cap/utils", () => ({ priceForMicros: () => 1234 }));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("drizzle-orm", () => ({
	and: (...a: unknown[]) => a,
	eq: (f: unknown, v: unknown) => ({ f, v }),
	isNull: (f: unknown) => ({ isNull: f }),
	sql: Object.assign((s: TemplateStringsArray, ...v: unknown[]) => ({ s, v }), {
		raw: (s: string) => s,
	}),
}));
vi.mock("effect", () => ({
	Option: { isNone: (o: { _tag?: string }) => o?._tag === "None" },
}));
vi.mock("next/server", () => ({
	NextResponse: {
		json: (body: unknown, init?: { status?: number }) => ({
			status: init?.status ?? 200,
			json: async () => body,
		}),
	},
}));
vi.mock("@/lib/batch-merge", () => ({
	mergeBatchChunkIntoPartial: (_p: string, _b: string, _s: number) =>
		"WEBVTT\n\nMERGED",
	removeBatchJob: (
		jobs: Array<{ batchName: string }> | undefined,
		name: string,
	) => (jobs ?? []).filter((j) => j.batchName !== name),
}));
vi.mock("@/lib/gemini-batch-transcribe", () => ({
	cancelBatch: (n: string, k: string) => H.cancelBatch(n, k),
	collectBatchResult: (n: string, o: unknown) => H.collectBatchResult(n, o),
	deleteBatchFile: (n: string, k: string) => H.deleteBatchFile(n, k),
}));
vi.mock("@/lib/server", () => ({ runPromise: () => undefined }));
vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: (...a: unknown[]) => H.transcribeVideo(...a),
}));
vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: (
		id: string,
		updater: (m: Record<string, unknown>) => unknown,
	) => H.patchVideoMetadata(id, updater),
}));
vi.mock("@/lib/video-storage", () => ({
	getStorageAccessForVideo: () => ({
		pipe: () =>
			Promise.resolve([
				{
					getObject: (k: string) => {
						H.getObject(k);
						return {
							pipe: () =>
								H.getObjectThrows
									? Promise.reject(new Error("storage read boom"))
									: Promise.resolve(H.getObjectResult),
						};
					},
					putObject: (k: string, body: string, opts: unknown) => {
						H.putObject(k, body, opts);
						return { pipe: () => Promise.resolve(undefined) };
					},
				},
			]),
	}),
}));

const { GET } = await import("@/app/api/cron/poll-batch-jobs/route");

const SECRET = "cron-secret-xyz";
const JOB = {
	batchName: "batches/a",
	fileName: "files/a",
	startSec: 900,
	durationSec: 900,
	submittedAt: "t1",
};

function videoWith(metadata: Record<string, unknown>) {
	return {
		id: "v1",
		ownerId: "owner1",
		orgId: "org1",
		metadata,
		deletedAt: null,
	};
}

function authedRequest(secret = SECRET) {
	return new Request("http://localhost/api/cron/poll-batch-jobs", {
		headers: { authorization: `Bearer ${secret}` },
	});
}

async function bodyOf(res: { json: () => Promise<unknown> }) {
	return (await res.json()) as Record<string, number>;
}

beforeEach(() => {
	process.env.CRON_SECRET = SECRET;
	H.candidates = [];
	H.geminiKey = "server-paid-key";
	H.getObjectResult = { _tag: "Some", value: "WEBVTT\n\nEXISTING" };
	H.getObjectThrows = false;
	H.getObject.mockReset();
	H.putObject.mockReset();
	H.cancelBatch.mockReset().mockResolvedValue(undefined);
	H.deleteBatchFile.mockReset().mockResolvedValue(undefined);
	H.collectBatchResult.mockReset();
	H.transcribeVideo.mockReset().mockResolvedValue({ success: true });
	H.insertUsage.mockReset().mockResolvedValue(undefined);
	H.updateVideo.mockReset().mockResolvedValue(undefined);
	// Default: patch applies the updater to the candidate's metadata and returns it.
	H.patchVideoMetadata
		.mockReset()
		.mockImplementation(
			async (_id: string, updater: (m: Record<string, unknown>) => unknown) =>
				updater(H.currentMetadata),
		);
});

describe("poll-batch-jobs GET — auth + config guards", () => {
	it("500 when CRON_SECRET is not configured", async () => {
		delete process.env.CRON_SECRET;
		const res = await GET(authedRequest());
		expect(res.status).toBe(500);
	});

	it("401 on a wrong bearer token", async () => {
		const res = await GET(authedRequest("wrong-secret-of-len"));
		expect(res.status).toBe(401);
	});

	it("401 when the authorization header is missing", async () => {
		const res = await GET(
			new Request("http://localhost/api/cron/poll-batch-jobs"),
		);
		expect(res.status).toBe(401);
	});

	it("500 when no paid GEMINI_API_KEY is set", async () => {
		H.geminiKey = undefined;
		const res = await GET(authedRequest());
		expect(res.status).toBe(500);
	});
});

describe("poll-batch-jobs GET — orchestration branches", () => {
	it("no-longer-cheap: cancels stray Batch, clears aiBatchJobs, never re-kicks", async () => {
		H.currentMetadata = { aiMode: "fast", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];

		const res = await GET(authedRequest());
		const body = await bodyOf(res);

		expect(H.cancelBatch).toHaveBeenCalledWith("batches/a", "server-paid-key");
		expect(H.deleteBatchFile).toHaveBeenCalledWith(
			"files/a",
			"server-paid-key",
		);
		// aiBatchJobs cleared to undefined via the patch updater.
		const patched = H.patchVideoMetadata.mock.results[0]?.value;
		await expect(patched).resolves.toMatchObject({ aiBatchJobs: undefined });
		expect(H.transcribeVideo).not.toHaveBeenCalled();
		expect(body.cleared).toBe(1);
	});

	it("pending: keeps the job and does not re-kick", async () => {
		H.currentMetadata = { aiMode: "cheap", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];
		H.collectBatchResult.mockResolvedValue({ status: "pending" });

		const res = await GET(authedRequest());
		const body = await bodyOf(res);

		expect(body.pending).toBe(1);
		expect(body.retried ?? 0).toBe(0);
		expect(H.transcribeVideo).not.toHaveBeenCalled();
		expect(H.putObject).not.toHaveBeenCalled();
	});

	it("succeeded: merges into the partial, records usage, drops the job, re-kicks cheap", async () => {
		H.currentMetadata = { aiMode: "cheap", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];
		H.collectBatchResult.mockResolvedValue({
			status: "succeeded",
			transcriptVtt: "WEBVTT\n\nCHUNK",
			inputTokens: 100,
			outputTokens: 40,
			audioInTokens: 30,
		});

		const res = await GET(authedRequest());
		const body = await bodyOf(res);

		// Partial read at the partial key, merged content written back.
		expect(H.getObject).toHaveBeenCalledWith(
			"owner1/v1/transcription-partial.vtt",
		);
		expect(H.putObject).toHaveBeenCalledWith(
			"owner1/v1/transcription-partial.vtt",
			"WEBVTT\n\nMERGED",
			expect.objectContaining({ contentType: "text/vtt" }),
		);
		// Batch-rate usage recorded.
		expect(H.insertUsage).toHaveBeenCalledTimes(1);
		// All jobs resolved → re-kick the cheap workflow from the fuller checkpoint.
		expect(H.transcribeVideo).toHaveBeenCalledWith(
			"v1",
			"owner1",
			true,
			true,
			"cheap",
		);
		expect(body.succeeded).toBe(1);
		expect(body.retried).toBe(1);
	});

	it("treats a MISSING partial as an empty base and still merges + writes", async () => {
		H.currentMetadata = { aiMode: "cheap", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];
		H.getObjectResult = { _tag: "None" };
		H.collectBatchResult.mockResolvedValue({
			status: "succeeded",
			transcriptVtt: "WEBVTT\n\nCHUNK",
			inputTokens: 10,
			outputTokens: 5,
			audioInTokens: 3,
		});

		const res = await GET(authedRequest());
		const body = await bodyOf(res);

		expect(H.putObject).toHaveBeenCalledTimes(1);
		expect(body.succeeded).toBe(1);
	});

	it("DATA SAFETY: a storage read error on a succeeded batch KEEPS the job — no merge, no usage, no re-kick", async () => {
		H.currentMetadata = { aiMode: "cheap", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];
		H.getObjectThrows = true;
		H.collectBatchResult.mockResolvedValue({
			status: "succeeded",
			transcriptVtt: "WEBVTT\n\nCHUNK",
			inputTokens: 10,
			outputTokens: 5,
			audioInTokens: 3,
		});

		const res = await GET(authedRequest());
		const body = await bodyOf(res);

		// The ambiguous read must NOT overwrite the partial, spend accounting, or
		// resume the workflow — the job survives for the next tick.
		expect(H.putObject).not.toHaveBeenCalled();
		expect(H.insertUsage).not.toHaveBeenCalled();
		expect(H.transcribeVideo).not.toHaveBeenCalled();
		expect(body.succeeded).toBe(0);
		expect(body.retried ?? 0).toBe(0);
	});

	it("failed/expired: drops the job and re-kicks cheap so the chunk is redone", async () => {
		H.currentMetadata = { aiMode: "cheap", aiBatchJobs: [JOB] };
		H.candidates = [{ video: videoWith(H.currentMetadata) }];
		H.collectBatchResult.mockResolvedValue({
			status: "failed",
			reason: "terminal state",
		});

		const res = await GET(authedRequest());
		const body = await bodyOf(res);

		expect(H.putObject).not.toHaveBeenCalled();
		expect(H.transcribeVideo).toHaveBeenCalledWith(
			"v1",
			"owner1",
			true,
			true,
			"cheap",
		);
		expect(body.failed).toBe(1);
		expect(body.retried).toBe(1);
	});
});
