import { promises as fs, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The lost "AI tahlil" press (owner incident, 2026-08-16).
 *
 * The user pressed AI analysis one minute BEFORE processVideoWorkflow finished
 * optimizing his upload. transcribeVideo refuses while the upload row is still
 * in an in-progress phase — and it refuses with success:true — so the route
 * answered {"started":true} and NOTHING was ever recorded or started. The video
 * sat at transcriptionStatus NULL until it was rescued by hand 25 minutes later.
 *
 * These tests drive the REAL route, the REAL transcribeVideo, the REAL
 * processVideoWorkflow and the REAL recovery cron against one shared in-memory
 * video row; only the DB / storage / workflow-launch boundaries are stubbed.
 * The assertions are on the state that survives (the row) and on the workflow
 * actually being launched — not on a value authored at the test boundary.
 */

const state = vi.hoisted(() => ({
	videoRow: null as Record<string, unknown> | null,
	uploadRow: null as Record<string, unknown> | null,
	uploadDeleted: false,
	/**
	 * Simulates LOSING the claim race: transcribeVideo's claim is a conditional
	 * UPDATE, so a row another starter already claimed matches nothing and mysql
	 * reports affectedRows = 0. The row is left untouched, exactly as the real
	 * conditional write would leave it.
	 */
	claimLost: false,
}));

const schemaMocks = vi.hoisted(() => ({
	videos: { id: "videos.id", metadata: "videos.metadata", ownerId: "videos.ownerId", transcriptionStatus: "videos.transcriptionStatus", deletedAt: "videos.deletedAt", name: "videos.name" },
	videoUploads: { videoId: "videoUploads.videoId", phase: "videoUploads.phase", uploaded: "videoUploads.uploaded", total: "videoUploads.total", mode: "videoUploads.mode", updatedAt: "videoUploads.updatedAt", rawFileKey: "videoUploads.rawFileKey" },
	organizations: { id: "organizations.id", ownerId: "organizations.ownerId", settings: "organizations.settings", tombstoneAt: "organizations.tombstoneAt" },
	organizationMembers: {
		organizationId: "organizationMembers.organizationId",
		userId: "organizationMembers.userId",
		role: "organizationMembers.role",
	},
	users: { id: "users.id", geminiApiKey: "users.geminiApiKey" },
	s3Buckets: { id: "s3Buckets.id" },
}));

const transcribeVideoWorkflowMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));

/** The `'$.key'` paths of every JSON_REMOVE(...) call in a SQL fragment. */
function jsonRemovePaths(sqlText: string): string[] {
	const keys: string[] = [];
	const marker = "JSON_REMOVE(";
	let from = sqlText.indexOf(marker);
	while (from !== -1) {
		let depth = 1;
		let i = from + marker.length;
		for (; i < sqlText.length && depth > 0; i++) {
			if (sqlText[i] === "(") depth++;
			else if (sqlText[i] === ")") depth--;
		}
		const args = sqlText.slice(from + marker.length, i - 1);
		for (const match of args.matchAll(/'\$\.([A-Za-z0-9_]+)'/g)) {
			keys.push(match[1] as string);
		}
		from = sqlText.indexOf(marker, i);
	}
	return keys;
}

/**
 * Applies a drizzle `sql` metadata expression to a plain object the way MySQL
 * would, so the server-side merge is observable in the fake DB instead of the
 * test hand-writing the resulting row:
 *   - a NESTED expression (transcribeVideo's claim base is interpolated as a
 *     value, so its own SQL text never reaches this template) is applied first,
 *     which is what makes the non-retry claim's JSON_REMOVE of the recovery
 *     counters visible here at all;
 *   - then every JSON_REMOVE path in THIS fragment is deleted;
 *   - then every `'$.key', ?` pair sets that key.
 */
function applyJsonSet(
	expression: { sql: string; values: unknown[] },
	current: Record<string, unknown>,
): Record<string, unknown> {
	let next = { ...current };
	for (const value of expression.values) {
		if (isSqlExpression(value)) next = applyJsonSet(value, next);
	}
	// Only the paths INSIDE the JSON_REMOVE(...) argument list count: a claim
	// expression is JSON_SET(JSON_REMOVE(base, counters...), setPaths...), and
	// treating the outer JSON_SET paths as removals would make this fake lie.
	for (const key of jsonRemovePaths(expression.sql)) delete next[key];
	const segments = expression.sql.split("?");
	for (let i = 0; i < segments.length - 1; i++) {
		const match = /'\$\.([A-Za-z0-9_]+)'\s*,\s*$/.exec(segments[i] ?? "");
		if (match?.[1]) next[match[1]] = expression.values[i];
	}
	return next;
}

function isSqlExpression(
	value: unknown,
): value is { sql: string; values: unknown[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { sql?: unknown }).sql === "string"
	);
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: unknown) => {
				if (table === schemaMocks.videoUploads) {
					return {
						where: () => ({
							limit: () =>
								Promise.resolve(state.uploadRow ? [state.uploadRow] : []),
						}),
					};
				}
				if (table === schemaMocks.users) {
					return { where: () => ({ limit: () => Promise.resolve([]) }) };
				}
				if (table === schemaMocks.organizations) {
					return { leftJoin: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }) };
				}

				// videos
				let joined = false;
				// The recovery cron's stale-upload pass LEFT-joins video_uploads
				// onto videos; no fixture here is a lost hand-off (row-backed or
				// rowless), so it must match nothing.
				const staleUploadScan = {
					where: () => ({
						orderBy: () => ({
							limit: () => Promise.resolve([]),
						}),
					}),
				};
				const query = {
					leftJoin: (joinedTable: unknown) => {
						if (joinedTable === schemaMocks.videoUploads) return staleUploadScan;
						joined = true;
						return query;
					},
					innerJoin: () => ({
						where: () => ({
							limit: () => Promise.resolve([]),
						}),
					}),
					where: (condition: unknown) => {
						if (joined) {
							// transcribeVideo's video+org lookup, awaited directly.
							return Promise.resolve(
								state.videoRow
									? [{ video: state.videoRow, settings: null, orgSettings: null }]
									: [],
							);
						}
						const predicate = JSON.stringify(condition ?? {});
						const rows = () => {
							if (predicate.includes("aiStartPendingUpload")) {
								// The recovery cron's pending-request query: an OUTSTANDING
								// one-shot start order on an unclaimed row. Keying on
								// aiGenerationRequestedAt (which nothing ever clears) is the
								// bug this mirrors — the marker must be gone once redeemed.
								const row = state.videoRow;
								if (
									!row ||
									row.transcriptionStatus !== null ||
									!(row.metadata as Record<string, unknown> | null)
										?.aiStartPendingUpload
								)
									return [];
								return [row];
							}
							// Other cron candidate queries (stale PROCESSING, quota-blocked
							// ERROR, stale generation, stale refinement) match nothing here.
							if (
								predicate.includes("transcriptionError") ||
								predicate.includes("aiGenerationStatus") ||
								predicate.includes("timestampRefinement") ||
								predicate.includes("PROCESSING")
							)
								return [];
							// startPendingAiRequest's own query filters on deletedAt IS NULL —
							// a soft-deleted row must not match, exactly the prod incident
							// (deleted 18:15:55, started processing 18:24:51 anyway).
							if (
								predicate.includes('"isNull"') &&
								predicate.includes("deletedAt") &&
								state.videoRow?.deletedAt != null
							)
								return [];
							return state.videoRow ? [state.videoRow] : [];
						};
						const result = {
							limit: () => Promise.resolve(rows()),
							then: (
								resolve: (value: unknown[]) => unknown,
								reject?: (reason: unknown) => unknown,
							) => Promise.resolve(rows()).then(resolve, reject),
						};
						return result;
					},
				};
				return query;
			},
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: () => {
					// The transcription claim is a conditional UPDATE. When the race is
					// lost it matches no row: nothing is written and mysql reports
					// affectedRows = 0.
					if (state.claimLost && values.transcriptionStatus === "PROCESSING") {
						return Promise.resolve([{ affectedRows: 0 }]);
					}
					if (state.videoRow) {
						for (const [key, value] of Object.entries(values)) {
							if (key === "metadata" && isSqlExpression(value)) {
								state.videoRow.metadata = applyJsonSet(
									value,
									(state.videoRow.metadata as Record<string, unknown>) ?? {},
								);
							} else {
								state.videoRow[key] = value;
							}
						}
					}
					// mysql2's shape: [ResultSetHeader, FieldPacket[]].
					return Promise.resolve([{ affectedRows: 1 }]);
				},
			}),
		}),
		delete: () => ({
			where: () => {
				state.uploadRow = null;
				state.uploadDeleted = true;
				return Promise.resolve([]);
			},
		}),
	}),
}));

vi.mock("@cap/database/schema", () => schemaMocks);

vi.mock("@cap/database/crypto", () => ({
	decrypt: vi.fn(() => Promise.resolve("")),
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(() => ({ id: "user-1", isAdmin: true })),
}));

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({
		GEMINI_API_KEY: "test-gemini-api-key",
		DATABASE_URL: "mysql://test@localhost/test",
	})),
}));

vi.mock("@cap/web-domain", () => ({ Video: {} }));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	inArray: vi.fn((field: unknown, values: unknown[]) => ({ field, values })),
	isNotNull: vi.fn((field: unknown) => ({ isNotNull: field })),
	isNull: vi.fn((field: unknown) => ({ isNull: field })),
	like: vi.fn((field: unknown, pattern: unknown) => ({ like: field, pattern })),
	lte: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	or: vi.fn((...args: unknown[]) => args),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		sql: strings.join("?"),
		values,
	})),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("@/workflows/transcribe", () => ({
	transcribeVideoWorkflow: transcribeVideoWorkflowMock,
}));

vi.mock("@/lib/ai-cost-guard", () => ({
	assertAiBudgetAvailable: vi.fn(() => Promise.resolve()),
	BudgetExceededError: class BudgetExceededError extends Error {},
}));

vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: vi.fn(() => Promise.resolve({ success: true, message: "" })),
}));

vi.mock("@/lib/ops-alert", () => ({ sendOpsAlert: vi.fn() }));

// Storage/ffmpeg boundary for processVideoWorkflow. The optimize step itself is
// not what this test is about — what matters is that the completion path runs.
const optimizedFile = vi.hoisted(() => ({ path: "" }));

vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));

vi.mock("@/lib/video-storage", () => ({
	getStorageAccessForVideo: vi.fn(() => ({
		pipe: () =>
			Promise.resolve([
				{
					getInternalSignedObjectUrl: () => ({
						pipe: () => Promise.resolve("https://storage.test/raw.mp4"),
					}),
					putObject: () => ({ pipe: () => Promise.resolve(undefined) }),
				},
			]),
	})),
}));

vi.mock("@/lib/video-convert", () => ({
	optimizeRemoteVideoToMp4: vi.fn(() =>
		Promise.resolve({
			filePath: optimizedFile.path,
			metadata: { durationSec: 42 },
			cleanup: () => Promise.resolve(),
		}),
	),
	probeRemoteVideo: vi.fn(() => Promise.resolve({ durationSec: 42 })),
}));

const VIDEO_ID = "kc45xjnar36v9gg";

function inProgressUploadRow() {
	// Multipart at its last progress tick: uploaded === total, but S3 has not
	// assembled the object yet — exactly the production shape.
	return { phase: "uploading", uploaded: 1000, total: 1000, mode: "multipart" };
}

function freshVideoRow() {
	return {
		id: VIDEO_ID,
		ownerId: "user-1",
		orgId: null,
		name: "Meeting",
		transcriptionStatus: null,
		metadata: {},
	};
}

async function postGenerate(body: Record<string, unknown> = {}) {
	const { POST } = await import("@/app/api/videos/[videoId]/generate/route");
	return POST(
		new Request("http://localhost", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}) as unknown as NextRequest,
		{ params: Promise.resolve({ videoId: VIDEO_ID }) },
	);
}

async function runRecoveryCron(): Promise<Record<string, unknown>> {
	const { GET } = await import("@/app/api/cron/recover-stale-ai-jobs/route");
	const response = await GET(
		new Request("http://localhost/api/cron/recover-stale-ai-jobs", {
			headers: { authorization: "Bearer test-cron-secret" },
		}),
	);
	return (await response.json()) as Record<string, unknown>;
}

describe("AI request made while the upload is still processing", () => {
	beforeAll(async () => {
		optimizedFile.path = join(tmpdir(), `pending-ai-request-${Date.now()}.mp4`);
		await fs.writeFile(optimizedFile.path, Buffer.from([0, 1, 2, 3]));
	});

	afterAll(async () => {
		await fs.rm(optimizedFile.path, { force: true });
	});

	beforeEach(() => {
		vi.clearAllMocks();
		state.videoRow = freshVideoRow();
		state.uploadRow = inProgressUploadRow();
		state.uploadDeleted = false;
		state.claimLost = false;
		process.env.CRON_SECRET = "test-cron-secret";
	});

	it("records the request instead of claiming it started", async () => {
		const response = await postGenerate();
		const body = (await response.json()) as Record<string, unknown>;

		expect(response.status).toBe(200);
		// The lie that lost the request.
		expect(body.started).toBeUndefined();
		expect(body.queued).toBe(true);

		// Nothing was launched...
		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();
		expect(state.videoRow?.transcriptionStatus).toBeNull();
		// ...but the user's ask is now durable on the row.
		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		expect(metadata.aiGenerationRequestedBy).toBe("user-1");
		// The one-shot start order the two redeemers consume.
		expect(typeof metadata.aiStartPendingUpload).toBe("string");
		// 2026-09-05 — the OUTCOME that makes transcript-first real for the
		// owner's most common flow (pressing while the upload still runs).
		// `aiGenerationRequestedAt` must NOT be stamped here: nothing ever
		// clears it and shouldStartAiAfterTranscription ORs it back in, so
		// writing it silently re-enabled the auto-chain and made the
		// aiGenerationEnabled=false flips in process-video.ts and
		// recover-stale-ai-jobs a no-op. On a video with no transcript, this
		// button IS the transcript button.
		expect(metadata.aiGenerationRequestedAt).toBeUndefined();
	});

	it("an upload-time press does NOT auto-chain into AI once the transcript lands", async () => {
		// The end-to-end outcome behind the assertion above: press during
		// upload -> redeemer starts transcription -> the post-transcript
		// decision must come out FALSE, so the summary waits for its own press.
		await postGenerate();
		const metadata = (state.videoRow?.metadata ?? {}) as Record<
			string,
			unknown
		>;
		const { shouldStartAiAfterTranscription } = await import(
			"@/lib/ai-generation-request"
		);
		expect(
			shouldStartAiAfterTranscription({
				metadata: metadata as never,
				// what process-video.ts and the recover cron now pass
				aiGenerationEnabled: false,
			}),
		).toBe(false);
	});

	it("starts transcription when the processing workflow finishes", async () => {
		await postGenerate();
		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();

		const { processVideoWorkflow } = await import("@/workflows/process-video");
		const result = await processVideoWorkflow({
			videoId: VIDEO_ID,
			userId: "user-1",
			rawFileKey: `user-1/${VIDEO_ID}/raw.mp4`,
			bucketId: null,
		});

		expect(result.success).toBe(true);
		expect(state.uploadDeleted).toBe(true);
		// The whole point: the request the user made a minute earlier is honoured
		// — it still STARTS the job rather than being silently lost.
		// `aiGenerationEnabled: false` since 2026-09-05: what it starts is the
		// TRANSCRIPT. AI summary/tasks are a separate "Xulosalash" press once the
		// transcript is ready, at every entry point — this redeemer included.
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledTimes(1);
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledWith({
			videoId: VIDEO_ID,
			userId: "user-1",
			aiGenerationEnabled: false,
		});
		expect(state.videoRow?.transcriptionStatus).toBe("PROCESSING");
	});

	it("a FULL upload-time press redeems with AI generation ON (process-video)", async () => {
		// 2026-09-10 two-mode chooser: "Full AI analysis" pressed while the upload
		// still runs banks aiStartMode='full'. The redemption must reach the
		// pipeline with the run's REAL switch ON — the summary and tasks chain in
		// the same run, with no second press.
		await postGenerate({ mode: "full" });
		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();

		const { processVideoWorkflow } = await import("@/workflows/process-video");
		const result = await processVideoWorkflow({
			videoId: VIDEO_ID,
			userId: "user-1",
			rawFileKey: `user-1/${VIDEO_ID}/raw.mp4`,
			bucketId: null,
		});

		expect(result.success).toBe(true);
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledWith({
			videoId: VIDEO_ID,
			userId: "user-1",
			aiGenerationEnabled: true,
		});
		expect(state.videoRow?.transcriptionStatus).toBe("PROCESSING");
	});

	it("a FULL upload-time press redeems with AI generation ON (recovery cron)", async () => {
		// The restart-proof redeemer carries the same mode: app restarted after
		// the full press, the cron still starts the chained run, not a bare
		// transcript that would need a second press the owner does not know about.
		await postGenerate({ mode: "full" });
		state.uploadRow = null;

		const body = await runRecoveryCron();

		expect(body.pendingRequestStarted).toBe(1);
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledWith({
			videoId: VIDEO_ID,
			userId: "user-1",
			aiGenerationEnabled: true,
		});
	});

	it("ignores a soft-deleted video — startPendingAiRequest must not start it (test 5)", async () => {
		await postGenerate();
		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();

		// Soft-deleted between the "AI tahlil" press and processing finishing —
		// exactly the prod incident (deleted 18:15:55, started 18:24:51).
		state.videoRow!.deletedAt = new Date("2026-08-18T18:15:55.000Z");

		const { processVideoWorkflow } = await import("@/workflows/process-video");
		await processVideoWorkflow({
			videoId: VIDEO_ID,
			userId: "user-1",
			rawFileKey: `user-1/${VIDEO_ID}/raw.mp4`,
			bucketId: null,
		}).catch(() => {});

		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();
		expect(state.videoRow?.transcriptionStatus).toBeNull();
	});

	it("does not start anything when no AI request was made", async () => {
		// No generate press: processing completes and must stay silent.
		const { processVideoWorkflow } = await import("@/workflows/process-video");
		await processVideoWorkflow({
			videoId: VIDEO_ID,
			userId: "user-1",
			rawFileKey: `user-1/${VIDEO_ID}/raw.mp4`,
			bucketId: null,
		});

		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();
		expect(state.videoRow?.transcriptionStatus).toBeNull();
	});

	it("does not start a second run after the request was already redeemed", async () => {
		await postGenerate();
		const { processVideoWorkflow } = await import("@/workflows/process-video");
		await processVideoWorkflow({
			videoId: VIDEO_ID,
			userId: "user-1",
			rawFileKey: `user-1/${VIDEO_ID}/raw.mp4`,
			bucketId: null,
		});
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledTimes(1);
		// Redeemed means CONSUMED: the marker is gone from the row.
		expect(
			(state.videoRow?.metadata as Record<string, unknown>)
				.aiStartPendingUpload,
		).toBeUndefined();

		// An operator resets the status to NULL by hand — the documented habit
		// behind the 2026-08-16 rescue. Nothing may re-launch paid work.
		state.videoRow!.transcriptionStatus = null;
		const body = await runRecoveryCron();

		expect(body.pendingRequestStarted).toBe(0);
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledTimes(1);
	});

	it("keeps the request when the start is refused for a still-running upload", async () => {
		await postGenerate();
		// The cron ticks while the bytes are genuinely still landing.
		const body = await runRecoveryCron();

		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();
		expect(body.pendingRequestStarted).toBe(0);
		// Nothing was redeemed, so the ask must survive for the real redeemer.
		expect(
			typeof (state.videoRow?.metadata as Record<string, unknown>)
				.aiStartPendingUpload,
		).toBe("string");

		const { processVideoWorkflow } = await import("@/workflows/process-video");
		await processVideoWorkflow({
			videoId: VIDEO_ID,
			userId: "user-1",
			rawFileKey: `user-1/${VIDEO_ID}/raw.mp4`,
			bucketId: null,
		});
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledTimes(1);
	});

	it("ignores a video that merely has aiGenerationRequestedAt", async () => {
		// The already-PROCESSING branch of the generate route writes this marker
		// too, and shouldStartAiAfterTranscription needs it to survive — so it is
		// NOT a queue entry. A row carrying only it was never queued by the
		// upload-in-progress branch and must be invisible to the cron.
		state.uploadRow = null;
		state.videoRow!.metadata = {
			aiGenerationRequestedAt: "2026-08-16T09:00:00.000Z",
			aiGenerationRequestedBy: "user-1",
		};

		const body = await runRecoveryCron();

		expect(body.pendingRequestStarted).toBe(0);
		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();
		expect(state.videoRow?.transcriptionStatus).toBeNull();
	});

	it("launches nothing when the claim race is lost", async () => {
		await postGenerate();
		state.uploadRow = null;
		// Another starter claimed the row between the status guard and the claim:
		// the conditional UPDATE matches zero rows.
		state.claimLost = true;

		const body = await runRecoveryCron();

		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();
		expect(body.pendingRequestStarted).toBe(1);
		// The row is untouched — the winner owns it, we did not stomp its claim.
		expect(state.videoRow?.transcriptionStatus).toBeNull();
	});

	it("does not refund the recovery budget when the cron starts the request", async () => {
		await postGenerate();
		state.uploadRow = null;
		// The video already burned auto-recover attempts. A cron start must not
		// wipe them: that is what let a failing video retry forever and kept the
		// bounded-retry ops alert from ever firing.
		(state.videoRow!.metadata as Record<string, unknown>).autoRecoverAttempts = 2;
		(state.videoRow!.metadata as Record<string, unknown>).quotaRetryAttempts = 1;

		await runRecoveryCron();

		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledTimes(1);
		expect(metadata.autoRecoverAttempts).toBe(2);
		expect(metadata.quotaRetryAttempts).toBe(1);
	});

	it("the recovery cron rescues the request if the app restarted meanwhile", async () => {
		await postGenerate();
		// Processing finished while the app was down: the upload row is gone but
		// nothing ever redeemed the pending request.
		state.uploadRow = null;
		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();

		const { GET } = await import(
			"@/app/api/cron/recover-stale-ai-jobs/route"
		);
		const response = await GET(
			new Request("http://localhost/api/cron/recover-stale-ai-jobs", {
				headers: { authorization: "Bearer test-cron-secret" },
			}),
		);
		const body = (await response.json()) as Record<string, unknown>;

		expect(body.pendingRequestStarted).toBe(1);
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledTimes(1);
		expect(state.videoRow?.transcriptionStatus).toBe("PROCESSING");
	});
	// ── round-21 review findings ─────────────────────────────────────────────
	it("KEEPS the request when the start failed for a reason that carries no code (budget/key)", async () => {
		// Round-21 #2: removal was gated on `code !== "UPLOAD_IN_PROGRESS"` alone,
		// but several refusals launch nothing and carry NO code — no usable key,
		// "AI budget exceeded", a failed workflow launch. Consuming the one-shot
		// order on those turns a transient blip into permanent silent loss of the
		// user's press, which is the incident this whole feature exists to stop.
		await postGenerate();
		state.uploadRow = null; // bytes have landed; the refusal is NOT upload-related
		const { assertAiBudgetAvailable } = await import("@/lib/ai-cost-guard");
		vi.mocked(assertAiBudgetAvailable).mockRejectedValueOnce(
			new Error("AI budget exceeded"),
		);

		const body = await runRecoveryCron();

		expect(transcribeVideoWorkflowMock).not.toHaveBeenCalled();
		expect(body.pendingRequestStarted).toBe(0);
		// The ask must SURVIVE so the next tick (or the other redeemer) can honour it.
		expect(
			typeof (state.videoRow?.metadata as Record<string, unknown>)
				.aiStartPendingUpload,
		).toBe("string");
	});

	it("the cron's pending start may NOT take over a row that is already PROCESSING", () => {
		// Round-21 #1: `isRetry` carried TWO meanings — "do not refund the recovery
		// budget" AND "may re-claim a PROCESSING row". The pending starter needs
		// only the first; with the second it could win the CAS against a row the
		// process-video redeemer had just claimed, launching a SECOND paid
		// transcription for one video. The 5th argument (reclaimProcessing) must
		// stay `false` here. Asserted on the source because the fake DB in this
		// file does not evaluate the claim's WHERE clause — see the review note.
		const src = readFileSync(
			join(process.cwd(), "app/api/cron/recover-stale-ai-jobs/route.ts"),
			"utf8",
		);
		// The call is written across several lines with a trailing comma, so the
		// pattern has to tolerate both forms.
		// 3rd arg is aiGenerationEnabled — since 2026-09-10 it is the BANKED
		// MODE's flag (wantsFullAnalysis, read from aiStartMode), not a literal:
		// "Only transcript" redeems OFF, "Full AI analysis" redeems ON (the two
		// behavior tests above prove the outcomes; this pins the wiring). The
		// invariant this test directly guards is the 5th arg, reclaimProcessing.
		const pendingCall = src.match(
			/transcribeVideo\(\s*candidate\.id,\s*candidate\.ownerId,\s*(\w+),\s*true,\s*(\w+)\s*,?\s*\)/,
		);
		expect(
			pendingCall,
			"the pending-request start must pass aiGenerationEnabled and reclaimProcessing explicitly",
		).not.toBeNull();
		expect(pendingCall?.[1]).toBe("wantsFullAnalysis");
		expect(pendingCall?.[2]).toBe("false");
	});
});
