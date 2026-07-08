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
	shouldAutoFlipCheapJobToPaid,
	shouldAutoRetry,
	staleThresholdMsForMetadata,
	withIncrementedAutoRecoverAttempts,
} = await import("@/app/api/cron/recover-stale-ai-jobs/route");

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
	it("uses 20 minutes for cheap and 60 minutes for fast/default", () => {
		expect(staleThresholdMsForMetadata({ aiMode: "cheap" })).toBe(
			20 * 60 * 1000,
		);
		expect(staleThresholdMsForMetadata({ aiMode: "fast" })).toBe(
			60 * 60 * 1000,
		);
		expect(staleThresholdMsForMetadata({})).toBe(60 * 60 * 1000);
	});
});
