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

vi.mock("@/lib/ai-job-control", () => ({
	continueAiJobOnPaid: vi.fn(() => Promise.resolve({ success: true })),
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
	shouldAutoFlipCheapJobToPaid,
	shouldAutoRetry,
	staleThresholdMsForMetadata,
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

	it("skips a cheap job with a pending Batch BEFORE 4h, but the 4h flip still wins after", () => {
		const nowMs = Date.parse("2026-07-11T12:00:00.000Z");
		const twoHoursAgo = new Date(nowMs - 2 * 60 * 60 * 1000).toISOString();
		const fiveHoursAgo = new Date(nowMs - 5 * 60 * 60 * 1000).toISOString();

		const beforeFlip = {
			aiMode: "cheap" as const,
			aiJobStartedAt: twoHoursAgo,
			aiBatchJobs: [job],
		};
		// Before 4h: not flipping, but has a pending Batch → recovery skips it.
		expect(shouldAutoFlipCheapJobToPaid(beforeFlip, nowMs)).toBe(false);
		expect(hasPendingBatchJobs(beforeFlip)).toBe(true);

		const afterFlip = { ...beforeFlip, aiJobStartedAt: fiveHoursAgo };
		// After 4h: the flip check (evaluated first in the loop) wins over the skip.
		expect(shouldAutoFlipCheapJobToPaid(afterFlip, nowMs)).toBe(true);
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

	it("keeps retrying cheap quota waits even after the normal death limit", () => {
		expect(
			shouldAutoRetry(5, { aiMode: "cheap", aiQuotaWaiting: true }),
		).toBe(true);
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

	it("does not increment attempts for cheap quota waits", () => {
		const result = withIncrementedAutoRecoverAttempts({
			aiMode: "cheap",
			aiQuotaWaiting: true,
			autoRecoverAttempts: 2,
			processingStartedAt: "2026-01-01T00:00:00.000Z",
		});

		expect(result.autoRecoverAttempts).toBe(2);
		expect(result.processingStartedAt).toBeUndefined();
	});
});

describe("shouldAutoFlipCheapJobToPaid", () => {
	it("flips cheap jobs after 4 hours", () => {
		const now = Date.parse("2026-07-08T12:00:00.000Z");
		expect(
			shouldAutoFlipCheapJobToPaid(
				{
					aiMode: "cheap",
					aiJobStartedAt: "2026-07-08T07:59:59.000Z",
				},
				now,
			),
		).toBe(true);
	});

	it("does not flip cheap jobs before 4 hours or fast jobs", () => {
		const now = Date.parse("2026-07-08T12:00:00.000Z");
		expect(
			shouldAutoFlipCheapJobToPaid(
				{
					aiMode: "cheap",
					aiJobStartedAt: "2026-07-08T08:30:00.000Z",
				},
				now,
			),
		).toBe(false);
		expect(
			shouldAutoFlipCheapJobToPaid(
				{
					aiMode: "fast",
					aiJobStartedAt: "2026-07-08T07:00:00.000Z",
				},
				now,
			),
		).toBe(false);
	});
});

describe("staleThresholdMsForMetadata", () => {
	it("a HEALTHY cheap job is NOT stale at 25 minutes (cheap is the patient hours-long path)", () => {
		// Regression pin for the 2026-08-10 restart treadmill: with a 20-min cheap
		// threshold the cron killed and re-kicked a healthy free-tier/Batch job on
		// every tick, burning Gemini calls. Cheap staleness must comfortably
		// exceed an ordinary quota wait.
		expect(staleThresholdMsForMetadata({ aiMode: "cheap" })).toBeGreaterThan(
			25 * 60 * 1000,
		);
	});

	it("uses 60 minutes for cheap (crash detection) and 60 minutes for fast/default", () => {
		expect(staleThresholdMsForMetadata({ aiMode: "cheap" })).toBe(
			60 * 60 * 1000,
		);
		expect(staleThresholdMsForMetadata({ aiMode: "fast" })).toBe(
			60 * 60 * 1000,
		);
		expect(staleThresholdMsForMetadata({})).toBe(60 * 60 * 1000);
	});

	it("a CRASHED cheap job is re-kicked on the FREE path before it is ever flipped to paid", () => {
		// Invariant from the 2026-08-10 review: with the cheap threshold at the
		// 4h flip window, a cheap row only ever became a candidate when the flip
		// (checked first, keyed on the preserved aiJobStartedAt <=
		// processingStartedAt) was already due — the free re-kick branch was
		// unreachable and a crash at t+5min cost paid money at hour 4 against an
		// explicit cheap choice. So: at first staleness eligibility PLUS a full
		// cron interval of lag, the flip must still NOT be due — the free
		// re-kick handles the crash first.
		const t0 = Date.parse("2026-08-10T12:00:00.000Z");
		const iso = (ms: number) => new Date(ms).toISOString();
		const crashedCheap = {
			aiMode: "cheap" as const,
			aiJobStartedAt: iso(t0),
			processingStartedAt: iso(t0),
			// No evidence-of-life markers: not quota-waiting, no pending Batch —
			// this row is genuinely dead, not patiently waiting.
		};
		const cronIntervalMs = 30 * 60 * 1000;
		const firstRecoveryTick =
			t0 + staleThresholdMsForMetadata(crashedCheap) + cronIntervalMs;

		expect(
			shouldAutoFlipCheapJobToPaid(crashedCheap, firstRecoveryTick),
		).toBe(false);
		expect(shouldAutoRetry(0, crashedCheap)).toBe(true);
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
