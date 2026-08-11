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
	whereArgs: [] as unknown[][],
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: (...args: unknown[]) => {
					state.whereArgs.push(args);
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

const sendOpsAlertMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/ops-alert", () => ({
	sendOpsAlert: sendOpsAlertMock,
}));

const continueAiJobOnPaidMock = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ success: true, message: "ok" })),
);
vi.mock("@/lib/ai-job-control", () => ({
	continueAiJobOnPaid: continueAiJobOnPaidMock,
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
		state.whereArgs = [];
		process.env.CRON_SECRET = CRON_SECRET;
	});

	function armWithCandidate(metadata: Record<string, unknown>) {
		const candidate = {
			id: "vid-cheap-1",
			ownerId: "owner-1",
			name: "68-min recording",
			metadata,
		};
		// Query order in the route: stale transcription, quota-blocked,
		// stale aiGeneration, stale refinement.
		state.selectResults = [[candidate], [], [], []];
	}

	function armWithStaleCheapCandidate() {
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		// A genuinely CRASHED cheap job: no quota-park flag, no pending Batch,
		// no progress heartbeat for 2h — old enough to be stale, young enough
		// (< 4h job clock) that the time-based paid flip does not win first.
		armWithCandidate({
			aiMode: "cheap",
			processingStartedAt: twoHoursAgo,
			aiJobStartedAt: twoHoursAgo,
		});
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

	it("NEVER kills a job with a fresh progress heartbeat, whatever its total runtime (round-3 #1)", async () => {
		// A healthy 2-3h cheap recording at chunk 12/20: started long ago, but
		// the last chunk completed 5 minutes ago. Chunk progress is the third
		// liveness case (neither aiQuotaWaiting nor aiBatchJobs marks it) —
		// re-kicking here spawned a SECOND concurrent workflow on the same
		// video and stamped a live job dead by ~3h.
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000).toISOString();
		armWithCandidate({
			aiMode: "cheap",
			processingStartedAt: twoHoursAgo,
			aiJobStartedAt: twoHoursAgo,
			transcriptionChunksCompleted: 12,
			transcriptionChunksTotal: 20,
			aiProgressAt: fiveMinAgo,
		});

		const res = await GET(cronRequest());
		const body = (await res.json()) as { skippedAlive?: number };

		expect(transcribeVideoMock).not.toHaveBeenCalled();
		expect(continueAiJobOnPaidMock).not.toHaveBeenCalled();
		expect(sendOpsAlertMock).not.toHaveBeenCalled();
		expect(body.skippedAlive).toBe(1);
	});

	it("a LEGACY quota-parked row (pre-round-8) takes the NORMAL stale re-kick — the quota ladder branch is gone", async () => {
		// Cheap no longer parks (each chunk falls back to paid when free is
		// out), so PROCESSING + aiQuotaWaiting only exists on legacy rows.
		// They drain through the ordinary bounded re-kick, which completes them
		// under the new semantics — no ladder booking, no special schedule.
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		armWithCandidate({
			aiMode: "cheap",
			aiQuotaWaiting: true,
			processingStartedAt: twoHoursAgo,
			aiJobStartedAt: twoHoursAgo,
		});

		await GET(cronRequest());

		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"vid-cheap-1",
			"owner-1",
			true,
			true,
			"cheap",
		);
		// No ladder slot is booked anymore.
		const laddered = state.setCalls.find((setArg) =>
			JSON.stringify(setArg.metadata ?? {}).includes("quotaRetryAttempts"),
		);
		expect(laddered).toBeUndefined();
		// And the retry BUDGET moves (round-9 #2): with the ladder gone, the
		// counter is this row's only terminator — an exempt row would re-kick
		// forever.
		const counted = state.setCalls.find(
			(setArg) =>
				(setArg.metadata as { autoRecoverAttempts?: number } | undefined)
					?.autoRecoverAttempts === 1,
		);
		expect(counted).toBeDefined();
	});

	it("NO automatic paid flip for transcription: a 5h-old crashed cheap job is re-kicked FREE, never continued on paid (round-6 owner decision)", async () => {
		// The 4h flip is removed: cheap continues on the discounted Batch the
		// moment free fails, so age alone must never buy a full-price rescue.
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		armWithCandidate({
			aiMode: "cheap",
			processingStartedAt: fiveHoursAgo,
			aiJobStartedAt: fiveHoursAgo,
		});

		await GET(cronRequest());

		expect(continueAiJobOnPaidMock).not.toHaveBeenCalled();
		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"vid-cheap-1",
			"owner-1",
			true,
			true,
			"cheap",
		);
	});

	it("a cheap job OUT of free retries goes terminal ERROR + ops alert - no automatic full-price rescue (round-6)", async () => {
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		armWithCandidate({
			aiMode: "cheap",
			autoRecoverAttempts: 2,
			processingStartedAt: fiveHoursAgo,
			aiJobStartedAt: fiveHoursAgo,
		});

		await GET(cronRequest());

		expect(continueAiJobOnPaidMock).not.toHaveBeenCalled();
		const dead = state.setCalls.find(
			(setArg) => setArg.transcriptionStatus === "ERROR",
		);
		expect(dead).toBeDefined();
		expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);
	});

	it("the candidate SQL treats a row with NO liveness markers as infinitely stale (round-4 #2)", async () => {
		// NULL <= ? is NULL in MySQL: without an explicit fallback arm, a
		// PROCESSING row whose takeover cleared both markers (and whose
		// re-claim then failed) was invisible to the cron forever — permanent
		// spinner, no ERROR, no flip. The '' COALESCE arm is that fallback.
		armWithStaleCheapCandidate();
		await GET(cronRequest());

		const fragments = state.whereArgs
			.flat(Number.POSITIVE_INFINITY)
			.filter(
				(arg): arg is { strings: TemplateStringsArray } =>
					typeof arg === "object" &&
					arg !== null &&
					"strings" in (arg as Record<string, unknown>),
			)
			.map((arg) => arg.strings.join("?"));
		const stalenessFragment = fragments.find((text) =>
			text.includes("$.aiProgressAt"),
		);
		expect(stalenessFragment).toBeDefined();
		expect(stalenessFragment).toContain("''");
	});

	// (round-3's "offered the PAID path before death" test was deliberately
	// REMOVED in round 6: the owner's decision forbids any automatic
	// cheap→full-price continuation — see the terminal-ERROR tests above.)
});
