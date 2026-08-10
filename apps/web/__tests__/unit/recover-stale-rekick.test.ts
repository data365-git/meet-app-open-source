/**
 * Route-level pins for the 2026-08-10 "AI tahlil" incident (recover-stale cron):
 *
 *  (b) a re-kick must NEVER pass the row's transcriptionStatus through NULL —
 *      a page load in that window read NULL and rendered "start AI analysis?"
 *      for a job that was alive;
 *  (c) the owner's CHEAP choice must survive a re-kick — the cron must hand
 *      the job's own resolved speed mode to transcribeVideo (as a retry), not
 *      let the claim fall back to the org default (= FAST = the paid path).
 *
 * Repo rule honored: both assertions FAIL against the pre-fix route (which set
 * transcriptionStatus: null and called transcribeVideo with 3 args).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	selectResults: [] as unknown[][],
	selectCall: 0,
	setCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => {
					const result =
						state.selectResults[state.selectCall++] ?? ([] as unknown[]);
					const promise = Promise.resolve(result) as Promise<unknown[]> & {
						limit: (n: number) => Promise<unknown[]>;
					};
					promise.limit = () => Promise.resolve(result);
					return promise;
				},
			}),
		}),
		update: () => ({
			set: (arg: Record<string, unknown>) => {
				state.setCalls.push(arg);
				return { where: () => Promise.resolve() };
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

const transcribeVideoMock = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ success: true, message: "ok" })),
);
vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: transcribeVideoMock,
}));

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

describe("recover-stale-ai-jobs re-kick (transcription)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.selectResults = [];
		state.selectCall = 0;
		state.setCalls = [];
		process.env.CRON_SECRET = CRON_SECRET;
	});

	function armWithStaleCheapCandidate() {
		const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
		const staleCheapCandidate = {
			id: "vid-cheap-1",
			ownerId: "owner-1",
			name: "68-min recording",
			metadata: {
				aiMode: "cheap",
				aiQuotaWaiting: true,
				// Old enough to be selected as "stale", young enough (< 4h) that
				// the paid flip does not win the branch.
				processingStartedAt: oneHourAgo,
				aiJobStartedAt: oneHourAgo,
			},
		};
		// Query order in the route: stale transcription, quota-blocked,
		// stale aiGeneration, stale refinement.
		state.selectResults = [[staleCheapCandidate], [], [], []];
	}

	it("(b) never resets transcriptionStatus to NULL on a re-kick", async () => {
		armWithStaleCheapCandidate();

		const res = await GET(cronRequest());
		expect(res.status).toBe(200);
		expect(transcribeVideoMock).toHaveBeenCalledTimes(1);

		const nulledStatus = state.setCalls.filter(
			(setArg) =>
				"transcriptionStatus" in setArg && setArg.transcriptionStatus === null,
		);
		expect(nulledStatus).toEqual([]);
	});

	it("(c) the re-kick passes the job's own CHEAP mode (as a retry) so the owner's choice survives", async () => {
		armWithStaleCheapCandidate();

		await GET(cronRequest());

		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"vid-cheap-1",
			"owner-1",
			true,
			true,
			"cheap",
		);
	});
});
