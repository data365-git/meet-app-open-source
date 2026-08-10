import { beforeEach, describe, expect, it, vi } from "vitest";

// Integration test for the paid-takeover continuation path (spec §5 C5): the
// four-hour flip and the manual "continue on paid" button both route through
// continueAiJobOnPaid, which MUST abandon any pending durable Batch jobs (cancel
// remote + delete Files API input) and clear aiBatchJobs before paid Standard
// repeats the chunk — otherwise a cancelled-but-alive Batch keeps spending.

const H = vi.hoisted(() => ({
	selectResult: [] as unknown[],
	updateSet: vi.fn(),
	cancelBatch: vi.fn(async (_n: string, _k: string) => {}),
	deleteBatchFile: vi.fn(async (_n: string, _k: string) => {}),
	transcribeVideo: vi.fn(async (..._a: unknown[]) => ({
		success: true,
		message: "t",
	})),
	startAiGeneration: vi.fn(async (..._a: unknown[]) => ({
		success: true,
		message: "g",
	})),
	geminiKey: "server-paid-key" as string | undefined,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({ limit: async () => H.selectResult }),
			}),
		}),
		update: () => ({
			set: (v: unknown) => ({ where: async () => H.updateSet(v) }),
		}),
	}),
}));
vi.mock("@cap/database/schema", () => ({ videos: { id: "videos.id" } }));
vi.mock("@cap/env", () => ({
	serverEnv: () => ({ GEMINI_API_KEY: H.geminiKey }),
}));
vi.mock("@cap/web-domain", () => ({}));
vi.mock("drizzle-orm", () => ({ eq: (f: unknown, v: unknown) => ({ f, v }) }));
vi.mock("@/lib/gemini-batch-transcribe", () => ({
	cancelBatch: (n: string, k: string) => H.cancelBatch(n, k),
	deleteBatchFile: (n: string, k: string) => H.deleteBatchFile(n, k),
}));
vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: (...a: unknown[]) => H.startAiGeneration(...a),
}));
vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: (...a: unknown[]) => H.transcribeVideo(...a),
}));

const { abandonPendingBatchJobs, continueAiJobOnPaid } = await import(
	"@/lib/ai-job-control"
);

const JOB_A = {
	batchName: "batches/a",
	fileName: "files/a",
	startSec: 0,
	durationSec: 900,
	submittedAt: "t1",
};
const JOB_B = {
	batchName: "batches/b",
	fileName: "files/b",
	startSec: 900,
	durationSec: 900,
	submittedAt: "t2",
};

beforeEach(() => {
	H.selectResult = [];
	H.updateSet.mockReset();
	H.cancelBatch.mockReset().mockResolvedValue(undefined);
	H.deleteBatchFile.mockReset().mockResolvedValue(undefined);
	H.transcribeVideo
		.mockReset()
		.mockResolvedValue({ success: true, message: "t" });
	H.startAiGeneration
		.mockReset()
		.mockResolvedValue({ success: true, message: "g" });
	H.geminiKey = "server-paid-key";
});

describe("abandonPendingBatchJobs", () => {
	it("is a no-op when there are no jobs", async () => {
		await abandonPendingBatchJobs({});
		await abandonPendingBatchJobs({ aiBatchJobs: [] });
		expect(H.cancelBatch).not.toHaveBeenCalled();
		expect(H.deleteBatchFile).not.toHaveBeenCalled();
	});

	it("is a no-op when no paid key is configured (cannot resolve the project)", async () => {
		H.geminiKey = undefined;
		await abandonPendingBatchJobs({ aiBatchJobs: [JOB_A] });
		expect(H.cancelBatch).not.toHaveBeenCalled();
		expect(H.deleteBatchFile).not.toHaveBeenCalled();
	});

	it("cancels the remote Batch AND deletes the Files API input for every job", async () => {
		await abandonPendingBatchJobs({ aiBatchJobs: [JOB_A, JOB_B] });
		expect(H.cancelBatch).toHaveBeenCalledWith("batches/a", "server-paid-key");
		expect(H.cancelBatch).toHaveBeenCalledWith("batches/b", "server-paid-key");
		expect(H.deleteBatchFile).toHaveBeenCalledWith(
			"files/a",
			"server-paid-key",
		);
		expect(H.deleteBatchFile).toHaveBeenCalledWith(
			"files/b",
			"server-paid-key",
		);
	});

	it("never throws even if a cleanup call rejects", async () => {
		H.cancelBatch.mockRejectedValueOnce(new Error("network"));
		await expect(
			abandonPendingBatchJobs({ aiBatchJobs: [JOB_A] }),
		).resolves.toBeUndefined();
	});
});

describe("continueAiJobOnPaid", () => {
	it("returns a failure and does not touch anything when the video is missing", async () => {
		H.selectResult = [];
		const out = await continueAiJobOnPaid({
			videoId: "v1" as never,
			ownerId: "u1",
			phase: "transcription",
		});
		expect(out.success).toBe(false);
		expect(H.updateSet).not.toHaveBeenCalled();
		expect(H.transcribeVideo).not.toHaveBeenCalled();
	});

	it("transcription: abandons the pending Batch, clears aiBatchJobs, flips to fast, re-runs transcription", async () => {
		H.selectResult = [
			{
				metadata: {
					aiMode: "cheap",
					aiQuotaWaiting: true,
					aiBatchJobs: [JOB_A],
					// A recent chunk heartbeat: the handover must CLEAR it, or the
					// retry re-claim guard reads it as "live" and refuses the flip.
					aiProgressAt: new Date().toISOString(),
				},
			},
		];

		const out = await continueAiJobOnPaid({
			videoId: "v1" as never,
			ownerId: "u1",
			phase: "transcription",
		});

		// The stray Batch is cancelled + its file deleted (no orphan spend).
		expect(H.cancelBatch).toHaveBeenCalledWith("batches/a", "server-paid-key");
		expect(H.deleteBatchFile).toHaveBeenCalledWith(
			"files/a",
			"server-paid-key",
		);

		// The persisted metadata drops the batch jobs + quota wait and flips to
		// fast — WITHOUT resetting transcriptionStatus. The no-NULL law applies
		// here too (review finding #3, 2026-08-10): this flip fires unattended
		// at hour 4, and a NULL window during transcribeVideo's multi-second
		// pre-claim work rendered "start AI analysis?" for a continuing job.
		// Handing the row over = clearing processingStartedAt, which is what
		// lets the isRetry re-claim pass the fresh-claim guard.
		const setArg = H.updateSet.mock.calls[0]?.[0] as {
			transcriptionStatus?: unknown;
			metadata: {
				aiMode?: string;
				aiBatchJobs?: unknown;
				aiQuotaWaiting?: unknown;
				processingStartedAt?: unknown;
			};
		};
		expect("transcriptionStatus" in setArg).toBe(false);
		expect(setArg.metadata.aiMode).toBe("fast");
		expect(setArg.metadata.aiBatchJobs).toBeUndefined();
		expect(setArg.metadata.aiQuotaWaiting).toBeUndefined();
		expect(setArg.metadata.processingStartedAt).toBeUndefined();
		expect(
			(setArg.metadata as { aiProgressAt?: unknown }).aiProgressAt,
		).toBeUndefined();

		// Paid Standard transcription resumes from the checkpoint (fast, not
		// cheap) — as a RETRY, so it re-claims the still-PROCESSING row in place.
		expect(H.transcribeVideo).toHaveBeenCalledWith(
			"v1",
			"u1",
			true,
			true,
			"fast",
		);
		expect(H.startAiGeneration).not.toHaveBeenCalled();
		expect(out.success).toBe(true);
	});

	it("generation: clears aiBatchJobs + generation status and restarts generation on fast", async () => {
		H.selectResult = [{ metadata: { aiMode: "cheap", aiBatchJobs: [JOB_A] } }];

		await continueAiJobOnPaid({
			videoId: "v1" as never,
			ownerId: "u1",
			phase: "generation",
		});

		const setArg = H.updateSet.mock.calls[0]?.[0] as {
			metadata: {
				aiBatchJobs?: unknown;
				aiGenerationStatus?: unknown;
				aiMode?: string;
			};
		};
		expect(setArg.metadata.aiBatchJobs).toBeUndefined();
		expect(setArg.metadata.aiGenerationStatus).toBeUndefined();
		expect(setArg.metadata.aiMode).toBe("fast");
		expect(H.startAiGeneration).toHaveBeenCalledWith("v1", "u1", {
			force: true,
			speedModeOverride: "fast",
		});
		expect(H.transcribeVideo).not.toHaveBeenCalled();
	});
});
