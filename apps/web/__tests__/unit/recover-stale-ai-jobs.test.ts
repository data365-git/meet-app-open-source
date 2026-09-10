import { describe, expect, it, vi } from "vitest";

vi.mock("@cap/database", () => ({
	db: () => ({
		select: vi.fn(() => ({
			from: vi.fn(() => ({ where: vi.fn(() => Promise.resolve([])) })),
		})),
		update: vi.fn(() => ({
			set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
		})),
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
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	isNull: vi.fn((field: unknown) => ({ isNull: field })),
	like: vi.fn((field: unknown, pattern: unknown) => ({ like: field, pattern })),
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

const {
	hasPendingBatchJobs,
	isTranscriptionJobStale,
	shouldAutoRetry,
	withIncrementedAutoRecoverAttempts,
} = await import("@/app/api/cron/recover-stale-ai-jobs/stale-job-helpers");

describe("hasPendingBatchJobs (recovery skips the collector's jobs)", () => {
	const job = {
		batchName: "batches/a",
		fileName: "files/a",
		startSec: 0,
		durationSec: 900,
		submittedAt: "t1",
	};

	it("is true only when aiBatchJobs is a non-empty array", () => {
		expect(hasPendingBatchJobs({ aiBatchJobs: [job] })).toBe(true);
		expect(hasPendingBatchJobs({ aiBatchJobs: [] })).toBe(false);
		expect(hasPendingBatchJobs({})).toBe(false);
	});

	it("a legacy row with a pending Batch is skipped for the collector, however old (no 4h flip exists anymore — round-10)", () => {
		const nowMs = Date.parse("2026-07-11T12:00:00.000Z");
		const fiveHoursAgo = new Date(nowMs - 5 * 60 * 60 * 1000).toISOString();
		expect(
			hasPendingBatchJobs({
				aiMode: "cheap",
				aiJobStartedAt: fiveHoursAgo,
				aiBatchJobs: [job],
			}),
		).toBe(true);
	});
});

describe("shouldAutoRetry", () => {
	it("retries when there is no prior attempt", () => {
		expect(shouldAutoRetry(undefined)).toBe(true);
	});

	it("retries after 1 prior attempt", () => {
		expect(shouldAutoRetry(1)).toBe(true);
	});

	it("gives up after 2 prior attempts", () => {
		expect(shouldAutoRetry(2)).toBe(false);
	});

	it("gives up beyond 2 prior attempts", () => {
		expect(shouldAutoRetry(5)).toBe(false);
	});

	it("NO quota-wait exemption: the retry budget applies to every row (round-9 #2 — its bounding branch was deleted in round 8)", () => {
		// The old cheap+aiQuotaWaiting carve-out returned true unconditionally,
		// which was only safe while the quota-ladder branch bounded those rows
		// first. With the ladder gone, an exempt legacy row would re-kick
		// forever and never reach ERROR.
		expect(shouldAutoRetry(5)).toBe(false);
	});
});

describe("withIncrementedAutoRecoverAttempts", () => {
	it("sets attempts to 1 and clears stale timestamps when none existed", () => {
		const result = withIncrementedAutoRecoverAttempts({
			processingStartedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(result.autoRecoverAttempts).toBe(1);
		expect(result.processingStartedAt).toBeUndefined();
		expect(result.aiProcessingStartedAt).toBeUndefined();
	});

	it("increments an existing attempt count and preserves other fields", () => {
		const result = withIncrementedAutoRecoverAttempts({
			autoRecoverAttempts: 1,
			aiProcessingStartedAt: "2026-01-01T00:00:00.000Z",
			sourceName: "Meet tab",
		});

		expect(result.autoRecoverAttempts).toBe(2);
		expect(result.aiProcessingStartedAt).toBeUndefined();
		expect(result.sourceName).toBe("Meet tab");
	});

	it("clears the progress heartbeat on handover (or the re-claim guard reads stale liveness)", () => {
		const result = withIncrementedAutoRecoverAttempts({
			processingStartedAt: "2026-01-01T00:00:00.000Z",
			aiProgressAt: "2026-01-01T00:30:00.000Z",
		});

		expect(result.aiProgressAt).toBeUndefined();
	});

	it("increments attempts for cheap quota waits too — no exemption remains (round-9 #2)", () => {
		const result = withIncrementedAutoRecoverAttempts({
			aiMode: "cheap",
			aiQuotaWaiting: true,
			autoRecoverAttempts: 2,
			processingStartedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(result.autoRecoverAttempts).toBe(3);
		expect(result.processingStartedAt).toBeUndefined();
	});
});

describe("isTranscriptionJobStale — liveness by TIME SINCE LAST PROGRESS", () => {
	const now = Date.parse("2026-08-10T12:00:00.000Z");
	const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
	const H = 60 * 60 * 1000;
	const MIN = 60 * 1000;

	it("a job started hours ago with a fresh heartbeat is ALIVE (any total runtime)", () => {
		expect(
			isTranscriptionJobStale(
				{
					aiMode: "cheap",
					processingStartedAt: iso(3 * H),
					aiProgressAt: iso(5 * MIN),
				},
				now,
			),
		).toBe(false);
	});

	it("a job with an old heartbeat is stale even if it once made progress", () => {
		expect(
			isTranscriptionJobStale(
				{
					aiMode: "cheap",
					processingStartedAt: iso(3 * H),
					aiProgressAt: iso(2 * H),
				},
				now,
			),
		).toBe(true);
	});

	it("falls back to the claim time for pre-heartbeat rows", () => {
		expect(
			isTranscriptionJobStale({ processingStartedAt: iso(30 * MIN) }, now),
		).toBe(false);
		expect(
			isTranscriptionJobStale({ processingStartedAt: iso(2 * H) }, now),
		).toBe(true);
	});

	it("no markers at all = handed over / unclaimed = stale (safe to take)", () => {
		expect(isTranscriptionJobStale({}, now)).toBe(true);
	});
});
