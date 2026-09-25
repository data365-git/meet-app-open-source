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
			from: () => {
				const builder = {
					// The stale-upload hand-off pass joins video_uploads onto videos.
					innerJoin: () => builder,
					leftJoin: () => builder,
					where: (...args: unknown[]) => {
						state.whereArgs.push(args);
						const result =
							state.selectResults[state.selectCall++] ?? ([] as unknown[]);
						const promise = Promise.resolve(result) as Promise<unknown[]> & {
							limit: (n: number) => Promise<unknown[]>;
							orderBy: () => unknown;
						};
						promise.limit = () => Promise.resolve(result);
						promise.orderBy = () => promise;
						return promise;
					},
				};
				return builder;
			},
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

const startAiGenerationMock = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ success: true })),
);
vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: startAiGenerationMock,
}));

const transcribeVideoMock = vi.hoisted(() =>
	vi.fn(() => Promise.resolve({ success: true, message: "ok" })),
);
vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: transcribeVideoMock,
}));

// The stale-upload hand-off pass added these imports to the route; they pull
// the server-only runtime graph, so they must be mocked like the rest.
vi.mock("@/lib/server", () => ({
	runPromise: vi.fn(),
}));

vi.mock("@/lib/video-processing", () => ({
	startVideoProcessingWorkflow: vi.fn(() => Promise.resolve("started")),
}));

vi.mock("@/lib/video-storage", () => ({
	getStorageAccessForVideo: vi.fn(),
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

	it("(c) the re-kick is a plain retry — no speed-mode argument exists anymore", async () => {
		armWithStaleCheapCandidate();

		await GET(cronRequest());

		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"vid-cheap-1",
			"owner-1",
			true,
			true,
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

	it("a stale cheap GENERATION row past 4h is re-kicked as a retry, NEVER auto-flipped to paid (round-10 #2)", async () => {
		// The generation flip died with the parks: cheap generation pays inline
		// when free is genuinely out, so age must never buy a paid escalation —
		// and the re-kick must not refund its own budget (isRetry: true).
		const fiveHoursAgo = new Date(
			Date.now() - 5 * 60 * 60 * 1000,
		).toISOString();
		state.selectResults = [
			[],
			[],
			[
				{
					id: "vid-cheap-1",
					ownerId: "owner-1",
					name: "68-min recording",
					metadata: {
						aiMode: "cheap",
						aiGenerationStatus: "PROCESSING",
						aiJobStartedAt: fiveHoursAgo,
						aiProcessingStartedAt: fiveHoursAgo,
					},
				},
			],
			[],
		];

		await GET(cronRequest());

		expect(continueAiJobOnPaidMock).not.toHaveBeenCalled();
		expect(startAiGenerationMock).toHaveBeenCalledWith(
			"vid-cheap-1",
			"owner-1",
			{ force: true, isRetry: true },
		);
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

describe("recover-stale-ai-jobs quota re-kick — a refused start must stay recoverable", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		state.selectResults = [];
		state.selectCall = 0;
		state.setCalls = [];
		state.whereArgs = [];
		process.env.CRON_SECRET = CRON_SECRET;
	});

	function armQuotaBlocked() {
		// Query order: stale transcription, quota-blocked, ...
		state.selectResults = [
			[],
			[
				{
					id: "vid-quota-1",
					ownerId: "owner-1",
					name: "Quota-blocked recording",
					metadata: {
						transcriptionError: {
							code: "QUOTA",
							message: "credits depleted",
							at: "2026-09-25T00:00:00.000Z",
						},
					},
				},
			],
			[],
			[],
		];
	}

	function restoredQuotaWrites() {
		return state.setCalls.filter((setArg) => {
			const metadata = setArg.metadata as
				| { strings?: TemplateStringsArray; values?: unknown[] }
				| undefined;
			if (!metadata?.strings) return false;
			return (
				metadata.strings.join("?").includes("$.transcriptionError") &&
				(metadata.values ?? []).some(
					(value) =>
						typeof value === "string" && value.includes('"code":"QUOTA"'),
				)
			);
		});
	}

	it("'AI budget exceeded' (nothing started) restores the QUOTA code, keeps the booked backoff, and is not counted as retried", async () => {
		// Prod 2026-09-25: three rows left ERROR with NO code after this exact
		// refusal — invisible to every recovery pass forever.
		armQuotaBlocked();
		transcribeVideoMock.mockResolvedValueOnce({
			success: false,
			message: "AI budget exceeded",
		});

		const res = await GET(cronRequest());
		const body = (await res.json()) as Record<string, unknown>;

		expect(transcribeVideoMock).toHaveBeenCalledTimes(1);
		expect(restoredQuotaWrites()).toHaveLength(1);
		const booked = state.setCalls.find(
			(setArg) =>
				(setArg.metadata as { quotaRetryAttempts?: number } | undefined)
					?.quotaRetryAttempts === 1,
		);
		expect(
			(booked?.metadata as { quotaRetryNextAt?: string } | undefined)
				?.quotaRetryNextAt,
		).toEqual(expect.any(String));
		expect(body.quotaRetried).toBe(0);
		expect(body.quotaRetryBlocked).toBe(1);
	});

	it("a start that took is counted as retried and the code is NOT restored", async () => {
		armQuotaBlocked();
		transcribeVideoMock.mockResolvedValueOnce({
			success: true,
			message: "Transcription started inline",
		});

		const res = await GET(cronRequest());
		const body = (await res.json()) as Record<string, unknown>;

		expect(restoredQuotaWrites()).toHaveLength(0);
		expect(body.quotaRetried).toBe(1);
		expect(body.quotaRetryBlocked).toBe(0);
	});
});