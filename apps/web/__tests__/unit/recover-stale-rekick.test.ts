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

	it("a quota-PARKED cheap job with NO Batch gets a FREE ladder re-kick when due (round-4 #1)", async () => {
		// The no-paid-key deployment: submitCheapChunkBatch could not submit, so
		// the row parked with aiQuotaWaiting and no aiBatchJobs. Skipping it
		// entirely (round-3 shape) made the 4h PAID flip its only exit — the
		// owner's original "cheap billed as paid" complaint reintroduced. The
		// exit is the same bounded free backoff ladder the quota-ERROR loop
		// uses; the 4h flip stays the ceiling.
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		armWithCandidate({
			aiMode: "cheap",
			aiQuotaWaiting: true,
			processingStartedAt: twoHoursAgo,
			aiJobStartedAt: twoHoursAgo,
			// No quotaRetryNextAt yet -> first ladder attempt is due now.
		});

		const res = await GET(cronRequest());
		const body = (await res.json()) as { quotaRetried?: number };

		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"vid-cheap-1",
			"owner-1",
			true,
			true,
			"cheap",
		);
		expect(body.quotaRetried).toBe(1);
		// The re-kick books the next ladder slot via a server-side JSON_SET
		// merge (round-5 #5): a plain-object spread of the tick-start snapshot
		// could erase an aiBatchJobs handle the workflow gained meanwhile,
		// orphaning a BILLED Batch.
		const scheduled = state.setCalls
			.map(
				(setArg) =>
					setArg.metadata as
						| { strings?: TemplateStringsArray; values?: unknown[] }
						| undefined,
			)
			.find((metadata) => {
				const text = metadata?.strings?.join("?") ?? "";
				return text.includes("$.quotaRetryAttempts");
			});
		expect(scheduled).toBeDefined();
		const scheduledText = scheduled?.strings?.join("?") ?? "";
		expect(scheduledText).toContain("JSON_SET");
		expect(scheduledText).toContain("JSON_REMOVE");
		expect(scheduled?.values).toContain(1);
	});

	it("a FAILED paid flip is counted, and at the bound the row goes terminal ERROR + ops alert (round-5 #3)", async () => {
		// The reachable trigger: transcribeVideo inside continueAiJobOnPaid
		// returns "AI budget exceeded" for any org over budget. Silence here
		// meant the flip re-ran every 30-min tick forever: permanent spinner,
		// no alert, no exit.
		continueAiJobOnPaidMock.mockResolvedValue({
			success: false,
			message: "AI budget exceeded",
		});
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();

		// First failure: counted (server-side), not silent, not yet dead.
		armWithCandidate({
			aiMode: "cheap",
			processingStartedAt: fiveHoursAgo,
			aiJobStartedAt: fiveHoursAgo,
		});
		await GET(cronRequest());
		const counted = state.setCalls
			.map(
				(setArg) =>
					setArg.metadata as { strings?: TemplateStringsArray } | undefined,
			)
			.find((metadata) =>
				(metadata?.strings?.join("?") ?? "").includes("$.paidFlipAttempts"),
			);
		expect(counted).toBeDefined();
		expect(sendOpsAlertMock).not.toHaveBeenCalled();

		// At the bound: terminal ERROR + ops alert — the same exit every other
		// exhausted state has.
		state.selectCall = 0;
		state.setCalls = [];
		armWithCandidate({
			aiMode: "cheap",
			paidFlipAttempts: 2,
			processingStartedAt: fiveHoursAgo,
			aiJobStartedAt: fiveHoursAgo,
		});
		await GET(cronRequest());
		const dead = state.setCalls.find(
			(setArg) => setArg.transcriptionStatus === "ERROR",
		);
		expect(dead).toBeDefined();
		expect(sendOpsAlertMock).toHaveBeenCalledTimes(1);
	});

	it("a quota-PARKED cheap job whose ladder slot is NOT due yet is left alone (no hourly ffmpeg, no flag flicker)", async () => {
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		const inOneHour = new Date(Date.now() + 60 * 60 * 1000).toISOString();
		armWithCandidate({
			aiMode: "cheap",
			aiQuotaWaiting: true,
			quotaRetryAttempts: 1,
			quotaRetryNextAt: inOneHour,
			processingStartedAt: twoHoursAgo,
			aiJobStartedAt: twoHoursAgo,
		});

		const res = await GET(cronRequest());
		const body = (await res.json()) as { skippedQuotaWaiting?: number };

		expect(transcribeVideoMock).not.toHaveBeenCalled();
		expect(body.skippedQuotaWaiting).toBe(1);
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

	it("a cheap job out of free retries is offered the PAID path before being declared dead (round-3 #2)", async () => {
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
		armWithCandidate({
			aiMode: "cheap",
			autoRecoverAttempts: 2, // free retries exhausted
			processingStartedAt: twoHoursAgo,
			aiJobStartedAt: twoHoursAgo, // < 4h, so the time-based flip is not due
		});

		await GET(cronRequest());

		expect(continueAiJobOnPaidMock).toHaveBeenCalledWith({
			videoId: "vid-cheap-1",
			ownerId: "owner-1",
			phase: "transcription",
		});
		// NOT declared dead, no ops death alert.
		expect(sendOpsAlertMock).not.toHaveBeenCalled();
		expect(transcribeVideoMock).not.toHaveBeenCalled();
	});
});
