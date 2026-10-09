import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two explicit start modes (2026-09-10): "Only transcript" and "Full AI
 * analysis".
 *
 * These tests assert the OUTCOME of each mode, not that a handler fired: the
 * value that actually governs the run is `transcribeVideo`'s third argument
 * (aiGenerationEnabled) - it becomes the workflow payload flag that
 * shouldQueueAiGeneration checks FIRST, before any metadata marker. On
 * 2026-09-05 this exact area shipped as a no-op because tests asserted an
 * argument at a boundary nobody read; here the boundary asserted IS the
 * pipeline's switch, and swapping the two modes' values in the route (or in
 * bankedStartRequestsFullAnalysis) turns this file red.
 *
 * The two upload-time redemption paths (process-video.ts and the recovery
 * cron) are proven with the real workflow/cron in
 * __tests__/integration/pending-ai-request.test.ts.
 */

const currentUser = vi.hoisted(() => ({
	value: { id: "user-1", isAdmin: true } as { id: string; isAdmin?: boolean },
}));
const videoRows = vi.hoisted(() => ({ value: [] as unknown[] }));
const updateCalls = vi.hoisted(() => [] as { set: unknown; where: unknown }[]);

interface SqlFragment {
	sql: string;
	values: unknown[];
}

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(() => currentUser.value),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => ({
					limit: vi.fn(() => Promise.resolve(videoRows.value)),
				})),
			})),
		})),
		update: () => ({
			set: (set: unknown) => {
				updateCalls.push({ set, where: null });
				return { where: () => Promise.resolve() };
			},
		}),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		orgId: "videos.orgId",
		transcriptionStatus: "videos.transcriptionStatus",
		metadata: "videos.metadata",
		deletedAt: "videos.deletedAt",
		name: "videos.name",
	},
	organizations: { id: "organizations.id", ownerId: "organizations.ownerId" },
	organizationMembers: {
		organizationId: "organizationMembers.organizationId",
		userId: "organizationMembers.userId",
		role: "organizationMembers.role",
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	isNull: vi.fn((field: unknown) => ({ isNull: field })),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		sql: strings.join("?"),
		values,
	})),
}));

vi.mock("@cap/web-domain", () => ({ Video: {} }));

vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: vi.fn(() => Promise.resolve({ success: true })),
}));

// The real transcribeVideo resolves either a bare success or a coded outcome
// (UPLOAD_IN_PROGRESS is the one this file banks a press on), so the mock's
// resolved type has to admit the code/message fields the tests set.
type TranscribeOutcome = {
	success: boolean;
	code?: string;
	message?: string;
};
const transcribeVideoMock = vi.hoisted(() =>
	vi.fn((): Promise<TranscribeOutcome> => Promise.resolve({ success: true })),
);

vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: transcribeVideoMock,
}));

function unstartedVideoRow(metadata: Record<string, unknown> = {}) {
	return {
		id: "video-1",
		ownerId: "user-1",
		orgId: null,
		transcriptionStatus: null,
		metadata,
	};
}

async function postGenerate(body: Record<string, unknown>) {
	const { POST } = await import("@/app/api/videos/[videoId]/generate/route");
	return POST(
		new Request("http://localhost", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}) as unknown as NextRequest,
		{ params: Promise.resolve({ videoId: "video-1" }) },
	);
}

/** The metadata SQL fragments the route asked the DB to write. */
function firstMetadataWrite(): SqlFragment {
	const write = metadataWrites()[0];
	if (!write) throw new Error("expected a metadata write, got none");
	return write;
}

function metadataWrites(): SqlFragment[] {
	return updateCalls
		.map((call) => (call.set as { metadata?: SqlFragment }).metadata)
		.filter((fragment): fragment is SqlFragment => Boolean(fragment));
}

describe("two explicit start modes on an unanalysed recording", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updateCalls.length = 0;
		currentUser.value = { id: "user-1", isAdmin: true };
		videoRows.value = [unstartedVideoRow()];
		transcribeVideoMock.mockResolvedValue({ success: true });
	});

	it('"Only transcript" reaches the pipeline with AI generation OFF', async () => {
		const response = await postGenerate({ mode: "transcript" });
		expect(response.status).toBe(200);

		// The value that governs the run: the workflow payload flag comes from
		// this argument, and shouldQueueAiGeneration short-circuits on it.
		expect(transcribeVideoMock).toHaveBeenCalledTimes(1);
		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"video-1",
			"user-1",
			false,
			false,
		);
	});

	it('"Full AI analysis" reaches the pipeline with AI generation ON', async () => {
		const response = await postGenerate({ mode: "full" });
		expect(response.status).toBe(200);

		expect(transcribeVideoMock).toHaveBeenCalledTimes(1);
		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"video-1",
			"user-1",
			true,
			false,
		);
		// The full run banks the durable AI request so the status poll keeps
		// watching for the transcript-to-QUEUED handoff (and a remounted panel
		// knows AI stages are coming).
		expect(
			metadataWrites().some((fragment) =>
				fragment.sql.includes("'$.aiGenerationRequestedAt', ?"),
			),
		).toBe(true);
	});

	it('"Only transcript" cannot be re-enabled by a stale banked AI request', async () => {
		// The 2026-09-05 no-op: a durable aiGenerationRequestedAt makes
		// shouldStartAiAfterTranscription OR the auto-chain straight back in.
		// An explicit transcript-only press must remove it, and the flag must
		// be OFF regardless of what the row carried.
		videoRows.value = [
			unstartedVideoRow({
				aiGenerationRequestedAt: "2026-09-01T00:00:00.000Z",
			}),
		];

		const response = await postGenerate({ mode: "transcript" });
		expect(response.status).toBe(200);

		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"video-1",
			"user-1",
			false,
			false,
		);
		const removal = metadataWrites().find((fragment) =>
			fragment.sql.includes("JSON_REMOVE"),
		);
		expect(removal?.sql).toContain("'$.aiGenerationRequestedAt'");
	});

	it("a press with no mode (legacy callers) stays transcript-only", async () => {
		const response = await postGenerate({});
		expect(response.status).toBe(200);

		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"video-1",
			"user-1",
			false,
			false,
		);
	});

	it("a press with no mode resolves an outstanding FULL intent (retry of a full run)", async () => {
		videoRows.value = [
			unstartedVideoRow({
				aiGenerationRequestedAt: "2026-09-01T00:00:00.000Z",
			}),
		];

		const response = await postGenerate({});
		expect(response.status).toBe(200);

		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"video-1",
			"user-1",
			true,
			false,
		);
	});
});

describe("the press banked while the upload is still processing", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		updateCalls.length = 0;
		currentUser.value = { id: "user-1", isAdmin: true };
		videoRows.value = [unstartedVideoRow()];
		transcribeVideoMock.mockResolvedValue({
			success: true,
			code: "UPLOAD_IN_PROGRESS",
			message: "Upload in progress",
		});
	});

	it('"Full AI analysis" banks a full one-shot order', async () => {
		const response = await postGenerate({ mode: "full" });
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.queued).toBe(true);

		const write = firstMetadataWrite();
		// The redeemers' switch: aiStartMode travels with the one-shot order.
		expect(write.sql).toContain("'$.aiStartMode'");
		expect(write.values).toContain("full");
		// The durable AI request is stamped: this run really chains into AI.
		expect(write.sql).toContain("'$.aiGenerationRequestedAt', ?");
	});

	it('"Only transcript" banks a transcript-only order with NO AI request', async () => {
		const response = await postGenerate({ mode: "transcript" });
		const body = (await response.json()) as Record<string, unknown>;
		expect(body.queued).toBe(true);

		const write = firstMetadataWrite();
		expect(write.sql).toContain("'$.aiStartMode'");
		expect(write.values).toContain("transcript");
		// No SET of the durable AI request - only its removal, so the OR in
		// shouldStartAiAfterTranscription cannot re-enable the auto-chain.
		expect(write.sql).not.toContain("'$.aiGenerationRequestedAt', ?");
		expect(write.sql).toContain("JSON_REMOVE");
		expect(write.sql).toContain("'$.aiGenerationRequestedAt'");
	});
});

describe("bankedStartRequestsFullAnalysis", () => {
	it.each([
		[{}, false],
		[{ aiStartMode: "transcript" }, false],
		[{ aiStartMode: "full" }, true],
		[{ aiGenerationRequestedAt: "2026-09-01T00:00:00.000Z" }, false],
	])("maps %j to %s", async (metadata, expected) => {
		// Deliberately partial metadata shapes - the helper must cope with each.
		const { bankedStartRequestsFullAnalysis } = await import(
			"@/lib/ai-generation-request"
		);
		expect(
			bankedStartRequestsFullAnalysis(metadata as Parameters<typeof bankedStartRequestsFullAnalysis>[0]),
		).toBe(expected);
	});
});
