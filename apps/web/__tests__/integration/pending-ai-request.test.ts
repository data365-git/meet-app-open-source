import { promises as fs } from "node:fs";
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
}));

const schemaMocks = vi.hoisted(() => ({
	videos: { id: "videos.id", metadata: "videos.metadata", ownerId: "videos.ownerId", transcriptionStatus: "videos.transcriptionStatus", deletedAt: "videos.deletedAt", name: "videos.name" },
	videoUploads: { videoId: "videoUploads.videoId", phase: "videoUploads.phase", uploaded: "videoUploads.uploaded", total: "videoUploads.total", mode: "videoUploads.mode" },
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

/**
 * Applies a drizzle `sql` JSON_SET expression to a plain metadata object the
 * way MySQL would: every `'$.key', ?` pair in the template sets that key, and
 * every other placeholder (the COALESCE/JSON_REMOVE base) is left alone. This
 * is what makes the server-side merge observable in the fake DB instead of the
 * test hand-writing the resulting row.
 */
function applyJsonSet(
	expression: { sql: string; values: unknown[] },
	current: Record<string, unknown>,
): Record<string, unknown> {
	const next = { ...current };
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
				const query = {
					leftJoin: () => {
						joined = true;
						return query;
					},
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
							if (predicate.includes("aiGenerationRequestedAt")) {
								// The recovery cron's pending-request query.
								const row = state.videoRow;
								if (
									!row ||
									row.transcriptionStatus !== null ||
									!(row.metadata as Record<string, unknown> | null)
										?.aiGenerationRequestedAt
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
					return Promise.resolve([]);
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
	isNull: vi.fn((field: unknown) => ({ isNull: field })),
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

async function postGenerate() {
	const { POST } = await import("@/app/api/videos/[videoId]/generate/route");
	return POST(
		new Request("http://localhost", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		}) as unknown as NextRequest,
		{ params: Promise.resolve({ videoId: VIDEO_ID }) },
	);
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
		expect(typeof metadata.aiGenerationRequestedAt).toBe("string");
		expect(metadata.aiGenerationRequestedBy).toBe("user-1");
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
		// The whole point: the request the user made a minute earlier is honoured.
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledTimes(1);
		expect(transcribeVideoWorkflowMock).toHaveBeenCalledWith({
			videoId: VIDEO_ID,
			userId: "user-1",
			aiGenerationEnabled: true,
		});
		expect(state.videoRow?.transcriptionStatus).toBe("PROCESSING");
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
});
