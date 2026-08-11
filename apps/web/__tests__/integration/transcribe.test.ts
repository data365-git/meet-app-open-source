import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cap/env", () => ({
	serverEnv: vi.fn(() => ({
		GEMINI_API_KEY: "test-gemini-api-key",
		DATABASE_URL: "mysql://test@localhost/test",
	})),
}));

const mockStart = vi.hoisted(() => vi.fn());
const schemaMocks = vi.hoisted(() => ({
	videos: { id: "id", settings: "settings" },
	organizations: { id: "id", settings: "settings" },
	s3Buckets: { id: "id" },
	videoUploads: { videoId: "videoId", phase: "phase" },
	users: { id: "id", geminiApiKey: "geminiApiKey" },
}));

vi.mock("workflow/api", () => ({
	start: mockStart,
}));

vi.mock("@/workflows/transcribe", () => ({
	transcribeVideoWorkflow: vi.fn(),
}));

// assertAiBudgetAvailable issues its own db() select chains (user/org/video
// spend lookups) that are out of scope for this test file, which only
// exercises transcribeVideo's own gating/workflow-trigger logic. Stub it as
// a no-op so it doesn't consume/derail the select mocks set up below.
vi.mock("@/lib/ai-cost-guard", () => ({
	assertAiBudgetAvailable: vi.fn(() => Promise.resolve()),
	BudgetExceededError: class BudgetExceededError extends Error {},
}));

let mockQueryResult: unknown[] = [];
let mockUploadQueryResult: unknown[] = [];
// Owner's saved Gemini key lookup. Defaults to "no saved key", which is fine
// since serverEnv() already provides GEMINI_API_KEY in most tests.
let mockOwnerQueryResult: unknown[] = [];
// Every db().update().set(arg) call, so tests can inspect the claim write
// (status + JSON_SET metadata expression) that transcribeVideo issues.
let updateSetCalls: Array<Record<string, unknown>> = [];

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: unknown) => {
				if (table === schemaMocks.videoUploads) {
					return {
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue(mockUploadQueryResult),
						}),
					};
				}

				if (table === schemaMocks.users) {
					return {
						where: vi.fn().mockReturnValue({
							limit: vi.fn().mockResolvedValue(mockOwnerQueryResult),
						}),
					};
				}

				const query = {
					leftJoin: vi.fn(() => query),
					where: vi
						.fn()
						.mockImplementation(() => Promise.resolve(mockQueryResult)),
				};
				return query;
			},
		}),
		update: () => ({
			set: (arg: Record<string, unknown>) => {
				updateSetCalls.push(arg);
				return {
					where: vi.fn().mockResolvedValue([]),
				};
			},
		}),
		delete: () => ({
			where: vi.fn().mockResolvedValue([]),
		}),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: schemaMocks.videos,
	organizations: schemaMocks.organizations,
	s3Buckets: schemaMocks.s3Buckets,
	videoUploads: schemaMocks.videoUploads,
	users: schemaMocks.users,
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field, value) => ({ field, value })),
	// `transcribeVideo` claims the job with a server-side JSON_SET so a
	// concurrent writer's metadata is not clobbered; that needs drizzle's `sql`
	// tag. A mock missing it throws INSIDE the try, which the function reports as
	// "failed to start" — the whole workflow-triggering group went red with a
	// message that named the mock, not the code.
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		sql: strings.join("?"),
		values,
	})),
}));

import type { Video } from "@cap/web-domain";
import { isUploadInProgress, transcribeVideo } from "@/lib/transcribe";
import { transcribeVideoWorkflow } from "@/workflows/transcribe";

describe("transcribeVideo", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockQueryResult = [];
		mockUploadQueryResult = [];
		mockOwnerQueryResult = [];
		updateSetCalls = [];
	});

	describe("input validation", () => {
		it("requires GEMINI_API_KEY environment variable", async () => {
			const { serverEnv } = await import("@cap/env");
			vi.mocked(serverEnv).mockReturnValueOnce({
				GEMINI_API_KEY: undefined,
			} as ReturnType<typeof serverEnv>);

			// Need a real video row so transcribeVideo reaches the Gemini-key gate
			// (lib/transcribe.ts checks video existence before the key check).
			// No saved owner key either, so neither source of a usable key exists.
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: null,
					},
					bucket: null,
					settings: null,
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			// updated: message text changed from the old
			// "Missing necessary environment variables" to a more actionable
			// message that names the GEMINI_API_KEY env var directly.
			expect(result.message).toContain("GEMINI_API_KEY");
		});

		it("rejects empty videoId", async () => {
			const result = await transcribeVideo("" as Video.VideoId, "user-456");

			expect(result.success).toBe(false);
			expect(result.message).toBe("userId or videoId not supplied");
		});

		it("rejects empty userId", async () => {
			const result = await transcribeVideo("video-123" as Video.VideoId, "");

			expect(result.success).toBe(false);
			expect(result.message).toBe("userId or videoId not supplied");
		});

		it("rejects when both videoId and userId are empty", async () => {
			const result = await transcribeVideo("" as Video.VideoId, "");

			expect(result.success).toBe(false);
			expect(result.message).toBe("userId or videoId not supplied");
		});
	});

	describe("video lookup", () => {
		it("returns error when video does not exist", async () => {
			mockQueryResult = [];

			const result = await transcribeVideo(
				"nonexistent-video" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			expect(result.message).toBe("Video does not exist");
		});

		it("returns error when video result is malformed", async () => {
			mockQueryResult = [
				{ video: null, bucket: null, settings: null, orgSettings: null },
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(false);
			expect(result.message).toBe("Video information is missing");
		});
	});

	describe("transcription disabled scenarios", () => {
		it("skips transcription when video settings disable it", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: { disableTranscript: true },
					},
					bucket: null,
					settings: { disableTranscript: true },
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("disabled");
			expect(mockStart).not.toHaveBeenCalled();
		});

		it("skips transcription when org settings disable it", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: null,
					},
					bucket: null,
					settings: null,
					orgSettings: { disableTranscript: true },
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("disabled");
		});

		it("video settings take precedence over org settings", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: { disableTranscript: false },
					},
					bucket: null,
					settings: { disableTranscript: false },
					orgSettings: { disableTranscript: true },
				},
			];
			// updated: transcribeVideoWorkflow must return a Promise so .catch() doesn't throw
			vi.mocked(transcribeVideoWorkflow).mockResolvedValueOnce(undefined as never);
			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			// updated: transcribeVideo now calls transcribeVideoWorkflow() inline
			expect(transcribeVideoWorkflow).toHaveBeenCalled();
		});
	});

	describe("existing transcription status", () => {
		it("returns early when transcription is already complete", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: "COMPLETE",
						settings: null,
					},
					bucket: null,
					settings: null,
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("already completed");
			expect(mockStart).not.toHaveBeenCalled();
		});

		it("returns early when transcription is in progress", async () => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: "PROCESSING",
						settings: null,
					},
					bucket: null,
					settings: null,
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("in progress");
			expect(mockStart).not.toHaveBeenCalled();
		});
	});

	describe("workflow triggering", () => {
		beforeEach(() => {
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: null,
						settings: null,
					},
					bucket: { id: "bucket-456" },
					settings: null,
					orgSettings: null,
				},
			];
			mockStart.mockResolvedValue({ id: "workflow-run-123" });
			// updated: transcribeVideoWorkflow is now called inline (not via start()); must return a Promise
			vi.mocked(transcribeVideoWorkflow).mockResolvedValue(undefined as never);
		});

		it("does not trigger while upload bytes are still arriving", async () => {
			mockUploadQueryResult = [
				{ phase: "uploading", uploaded: 500, total: 1000 },
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toBe("Video upload is still in progress");
			expect(transcribeVideoWorkflow).not.toHaveBeenCalled();
		});

		it("recovers a stuck-but-complete upload (interrupted finalize) and triggers the workflow", async () => {
			// The finalize that clears this row was interrupted (e.g. a redeploy
			// restart) so phase never left "uploading" — but every byte is already
			// in storage. This must NOT block transcription forever.
			mockUploadQueryResult = [
				{ phase: "uploading", uploaded: 1000, total: 1000 },
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			expect(result.message).toBe("Transcription started inline");
			expect(transcribeVideoWorkflow).toHaveBeenCalled();
		});

		it("triggers workflow for valid video", async () => {
			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			expect(result.success).toBe(true);
			// updated: transcribeVideo now calls transcribeVideoWorkflow() inline, not via workflow/api start()
			expect(result.message).toBe("Transcription started inline");
		});

		it("passes correct payload to workflow", async () => {
			await transcribeVideo("video-123" as Video.VideoId, "user-456", true);

			// updated: transcribeVideo now calls transcribeVideoWorkflow() inline, not via workflow/api start()
			expect(transcribeVideoWorkflow).toHaveBeenCalledWith({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: true,
			});
		});

		it("defaults aiGenerationEnabled to false", async () => {
			await transcribeVideo("video-123" as Video.VideoId, "user-456");

			// updated: transcribeVideo now calls transcribeVideoWorkflow() inline, not via workflow/api start()
			expect(transcribeVideoWorkflow).toHaveBeenCalledWith({
				videoId: "video-123",
				userId: "user-456",
				aiGenerationEnabled: false,
			});
		});

		it("claim WITHOUT an explicit override defers server-side to the row's already-claimed aiMode", async () => {
			// 2026-08-10 incident pin: two starts raced (two taps seconds apart);
			// the later one carried no per-click override, resolved the mode from a
			// STALE pre-claim read and overwrote the owner's claimed "cheap" with
			// the org default "fast" — the paid path. The claim must therefore
			// resolve aiMode INSIDE the UPDATE (COALESCE on the row's current
			// value), not from the in-process snapshot.
			await transcribeVideo("video-123" as Video.VideoId, "user-456", true);

			const claim = updateSetCalls.find(
				(setArg) => setArg.transcriptionStatus === "PROCESSING",
			) as { metadata?: { sql: string } } | undefined;
			expect(claim).toBeDefined();
			expect(claim?.metadata?.sql).toContain("'$.aiMode', COALESCE(");
			// The claim is also the first progress HEARTBEAT — the recovery cron
			// judges staleness by time since last progress, so every claim must
			// stamp it (round-3 review: the heartbeat mechanism).
			expect(claim?.metadata?.sql).toContain("'$.aiProgressAt'");
		});

		it("claim WITH an explicit per-click override writes that mode unconditionally", async () => {
			await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
				true,
				false,
				"cheap",
			);

			const claim = updateSetCalls.find(
				(setArg) => setArg.transcriptionStatus === "PROCESSING",
			) as { metadata?: { sql: string; values: unknown[] } } | undefined;
			expect(claim).toBeDefined();
			// The owner's click wins outright — no deferring to the stored mode.
			expect(claim?.metadata?.sql).not.toContain("'$.aiMode', COALESCE(");
			expect(claim?.metadata?.values).toContain("cheap");
		});

		it("a retry REFUSES a PROCESSING row whose claim marker is fresh (live workflow)", async () => {
			// isRetry is not a bypass on the caller's say-so: re-claiming a
			// genuinely LIVE row would run two workflows billing Gemini for the
			// same video. A recovery owner hands the row over by CLEARING
			// processingStartedAt; a fresh marker means someone is really working.
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: "PROCESSING",
						settings: null,
						metadata: {
							aiMode: "cheap",
							processingStartedAt: new Date().toISOString(),
						},
					},
					bucket: null,
					settings: null,
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
				true,
				true,
				"cheap",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("in progress");
			expect(transcribeVideoWorkflow).not.toHaveBeenCalled();
		});

		it("a FRESH owner start refunds the recovery budgets; a cron retry does not (round-8 (b))", async () => {
			// Only saveTranscription cleared autoRecoverAttempts/quotaRetry*, and
			// it only runs on success — so a video that ever burned its budgets
			// could never be successfully retried after a terminal state.
			await transcribeVideo("video-123" as Video.VideoId, "user-456", true);
			const freshClaim = updateSetCalls.find(
				(setArg) => setArg.transcriptionStatus === "PROCESSING",
			);
			expect(JSON.stringify(freshClaim)).toContain("$.autoRecoverAttempts");
			expect(JSON.stringify(freshClaim)).toContain("$.quotaRetryAttempts");

			updateSetCalls = [];
			await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
				true,
				true,
				"cheap",
			);
			const retryClaim = updateSetCalls.find(
				(setArg) => setArg.transcriptionStatus === "PROCESSING",
			);
			expect(JSON.stringify(retryClaim)).not.toContain("$.autoRecoverAttempts");
		});

		it("a retry REFUSES a long-running row whose progress HEARTBEAT is fresh (round-3 #1)", async () => {
			// The claim marker is hours old — a 2-3h recording legitimately runs
			// that long — but the last chunk completed minutes ago. Liveness is
			// judged by the heartbeat, not by time since claim; re-claiming here
			// would run two workflows billing Gemini for the same video.
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: "PROCESSING",
						settings: null,
						metadata: {
							aiMode: "cheap",
							processingStartedAt: new Date(
								Date.now() - 2 * 60 * 60 * 1000,
							).toISOString(),
							aiProgressAt: new Date(Date.now() - 3 * 60 * 1000).toISOString(),
						},
					},
					bucket: null,
					settings: null,
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
				true,
				true,
				"cheap",
			);

			expect(result.success).toBe(true);
			expect(result.message).toContain("in progress");
			expect(transcribeVideoWorkflow).not.toHaveBeenCalled();
		});

		it("a retry (isRetry=true) re-claims a PROCESSING row instead of returning early", async () => {
			// The cron re-kick no longer nulls the status first (no NULL window for
			// page loads), so the retry path must be able to pass the PROCESSING
			// guard and re-claim in place.
			mockQueryResult = [
				{
					video: {
						id: "video-123",
						transcriptionStatus: "PROCESSING",
						settings: null,
					},
					bucket: null,
					settings: null,
					orgSettings: null,
				},
			];

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
				true,
				true,
				"cheap",
			);

			expect(result.success).toBe(true);
			expect(result.message).toBe("Transcription started inline");
			expect(transcribeVideoWorkflow).toHaveBeenCalled();
		});

		it("handles workflow trigger failure gracefully", async () => {
			// updated: transcribeVideoWorkflow is fire-and-forget with .catch(); an async
			// rejection does NOT flip success — the function returns "started" immediately.
			// Only a SYNCHRONOUS throw from the trigger causes success:false.
			vi.mocked(transcribeVideoWorkflow).mockReturnValueOnce(
				Promise.reject(new Error("Async workflow failure")),
			);

			const result = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);

			// async rejection is swallowed by .catch() — callers sees "started"
			expect(result.success).toBe(true);
			expect(result.message).toBe("Transcription started inline");

			// Also verify: a synchronous throw (not a rejected promise) causes success:false
			vi.mocked(transcribeVideoWorkflow).mockImplementationOnce(() => {
				throw new Error("Sync trigger failure");
			});

			const syncResult = await transcribeVideo(
				"video-123" as Video.VideoId,
				"user-456",
			);
			expect(syncResult.success).toBe(false);
			expect(syncResult.message).toBe("Failed to start transcription workflow");
		});
	});
});

describe("isUploadInProgress", () => {
	it("blocks while bytes are still arriving", () => {
		expect(
			isUploadInProgress({ phase: "uploading", uploaded: 500, total: 1000 }),
		).toBe(true);
	});

	it("does NOT block a byte-complete singlepart row stuck at 'uploading' (interrupted finalize)", () => {
		expect(
			isUploadInProgress({
				phase: "uploading",
				uploaded: 1000,
				total: 1000,
				mode: "singlepart",
			}),
		).toBe(false);
	});

	it("STILL blocks a byte-complete MULTIPART row (parts not yet assembled in S3)", () => {
		expect(
			isUploadInProgress({
				phase: "uploading",
				uploaded: 1000,
				total: 1000,
				mode: "multipart",
			}),
		).toBe(true);
	});

	it("does NOT block a byte-complete row stuck at 'processing'", () => {
		expect(
			isUploadInProgress({ phase: "processing", uploaded: 42, total: 42 }),
		).toBe(false);
	});

	it("blocks a genuinely-processing row with an unknown total", () => {
		// total 0 → cannot prove completion → treat as in-progress (safe default).
		expect(
			isUploadInProgress({ phase: "generating_thumbnail", uploaded: 0, total: 0 }),
		).toBe(true);
	});

	it("does not block terminal / absent rows", () => {
		expect(isUploadInProgress({ phase: "error", uploaded: 1, total: 2 })).toBe(false);
		expect(isUploadInProgress(null)).toBe(false);
		expect(isUploadInProgress(undefined)).toBe(false);
	});
});
