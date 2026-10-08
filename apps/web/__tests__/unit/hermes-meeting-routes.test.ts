import type { NextRequest } from "next/server";
import type { VideoMetadata } from "@cap/database/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR 2026-10-08 part A must-fixes for the Hermes pull routes: the token
// gate (401/503), the exact response shape {id, fileName, text}, per-row
// error isolation, transcript-missing rows marked failed, and the ack 404s.

const envState = vi.hoisted(() => ({ token: "test-token" as string | undefined }));
const dbState = vi.hoisted(() => ({ rows: [] as unknown[] }));
const transcriptTextMock = vi.hoisted(() => vi.fn());
const patchState = vi.hoisted(() => ({ current: {} as VideoMetadata }));
const patchResults = vi.hoisted(() => ({ last: null as VideoMetadata | null }));
const patchVideoMetadataMock = vi.hoisted(() =>
	vi.fn(async (_videoId: string, patch: (cur: VideoMetadata) => VideoMetadata) => {
		const next = patch(JSON.parse(JSON.stringify(patchState.current)));
		patchResults.last = next;
		return next;
	}),
);

vi.mock("@cap/env", () => ({
	serverEnv: () => ({ HERMES_QUEUE_TOKEN: envState.token }),
}));

vi.mock("@cap/database", () => {
	const chain: Record<string, unknown> = {};
	chain.from = () => chain;
	chain.where = () => chain;
	chain.orderBy = () => chain;
	chain.leftJoin = () => chain;
	chain.limit = () => Promise.resolve(dbState.rows);
	return {
		db: () => ({
			select: () => chain,
		}),
	};
});

vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		orgId: "videos.orgId",
		transcriptionStatus: "videos.transcriptionStatus",
		metadata: "videos.metadata",
		libraryKind: "videos.libraryKind",
		source: "videos.source",
		deletedAt: "videos.deletedAt",
		createdAt: "videos.createdAt",
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

vi.mock("@cap/web-domain", () => ({
	Video: {},
}));

vi.mock("@/lib/transcript-text", () => ({
	fetchVideoTranscriptText: transcriptTextMock,
}));

vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: patchVideoMetadataMock,
}));

function queuedRow(id: string, over: Record<string, unknown> = {}) {
	return {
		id,
		transcriptionStatus: "COMPLETE",
		metadata: {
			hermes: {
				status: "queued",
				clientName: "Ali",
				company: "ACME",
				queuedAt: "2026-10-08T10:00:00.000Z",
			},
		},
		createdAt: new Date("2026-10-08T10:00:00.000Z"),
		...over,
	};
}

function authedGet() {
	return new Request("http://localhost/api/hermes/meetings/queue", {
		headers: { authorization: `Bearer ${envState.token}` },
	}) as unknown as NextRequest;
}

beforeEach(() => {
	vi.clearAllMocks();
	envState.token = "test-token";
	dbState.rows = [];
	patchState.current = {};
	patchResults.last = null;
	transcriptTextMock.mockReset();
	transcriptTextMock.mockResolvedValue("transcript text");
});

describe("GET /api/hermes/meetings/queue", () => {
	it("is 503 when HERMES_QUEUE_TOKEN is unset", async () => {
		envState.token = undefined;
		const { GET } = await import("@/app/api/hermes/meetings/queue/route");

		const response = await GET(authedGet());

		expect(response.status).toBe(503);
	});

	it("is 401 with no or wrong token", async () => {
		const { GET } = await import("@/app/api/hermes/meetings/queue/route");

		const noHeader = await GET(
			new Request("http://localhost") as unknown as NextRequest,
		);
		expect(noHeader.status).toBe(401);

		const wrong = await GET(
			new Request("http://localhost", {
				headers: { authorization: "Bearer boshqa-token" },
			}) as unknown as NextRequest,
		);
		expect(wrong.status).toBe(401);
	});

	it("answers items with EXACTLY {id, fileName, text}", async () => {
		dbState.rows = [queuedRow("video-1")];
		const { GET } = await import("@/app/api/hermes/meetings/queue/route");

		const response = await GET(authedGet());
		const body = (await response.json()) as Array<Record<string, unknown>>;

		expect(response.status).toBe(200);
		expect(body).toHaveLength(1);
		const item = body[0];
		if (!item) throw new Error("expected exactly one item");
		expect(Object.keys(item).sort()).toEqual(["fileName", "id", "text"]);
		expect(item.id).toBe("video-1");
		expect(item.text).toBe("transcript text");
		expect(item.fileName).toBe("2026-10-08_Ali_ACME_meet.txt");
	});

	it("marks a transcript-missing row failed and omits it from the response", async () => {
		dbState.rows = [queuedRow("video-1")];
		transcriptTextMock.mockResolvedValue(null);
		patchState.current = {
			hermes: {
				status: "queued",
				clientName: "Ali",
				company: "ACME",
				queuedAt: "2026-10-08T10:00:00.000Z",
			},
		};
		const { GET } = await import("@/app/api/hermes/meetings/queue/route");

		const response = await GET(authedGet());
		const body = (await response.json()) as Array<Record<string, unknown>>;

		expect(response.status).toBe(200);
		expect(body).toHaveLength(0);
		// The row is marked failed so it leaves the oldest-20 window for good.
		expect(patchVideoMetadataMock).toHaveBeenCalledWith(
			"video-1",
			expect.any(Function),
		);
		expect(patchResults.last?.hermes).toEqual({
			status: "failed",
			failedReason: "transcript_missing",
			clientName: "Ali",
			company: "ACME",
			queuedAt: "2026-10-08T10:00:00.000Z",
		});
	});

	it("one bad row never fails the whole response", async () => {
		dbState.rows = [queuedRow("video-bad"), queuedRow("video-good")];
		transcriptTextMock.mockImplementation(async (row: { id: string }) => {
			if (row.id === "video-bad") throw new Error("storage exploded");
			return "good text";
		});
		const { GET } = await import("@/app/api/hermes/meetings/queue/route");

		const response = await GET(authedGet());
		const body = (await response.json()) as Array<Record<string, unknown>>;

		expect(response.status).toBe(200);
		expect(body).toHaveLength(1);
		const item = body[0];
		if (!item) throw new Error("expected exactly one item");
		expect(item.id).toBe("video-good");
	});
});

describe("POST /api/hermes/meetings/ack", () => {
	function ackRequest(body: unknown, token = envState.token) {
		return new Request("http://localhost/api/hermes/meetings/ack", {
			method: "POST",
			headers: { authorization: `Bearer ${token}` },
			body: JSON.stringify(body),
		}) as unknown as NextRequest;
	}

	it("is 401 with a wrong token and 503 when unset", async () => {
		const { POST } = await import("@/app/api/hermes/meetings/ack/route");

		const wrong = await POST(
			ackRequest({ id: "video-1", fileName: "a.txt" }, "wrong"),
		);
		expect(wrong.status).toBe(401);

		envState.token = undefined;
		const unset = await POST(ackRequest({ id: "video-1", fileName: "a.txt" }));
		expect(unset.status).toBe(503);
	});

	it("is 404 for an unknown id", async () => {
		dbState.rows = [];
		const { POST } = await import("@/app/api/hermes/meetings/ack/route");

		const response = await POST(
			ackRequest({ id: "nope", fileName: "a.txt" }),
		);

		expect(response.status).toBe(404);
		expect(patchVideoMetadataMock).not.toHaveBeenCalled();
	});

	it("is 404 for a video never queued for Hermes", async () => {
		dbState.rows = [
			{
				id: "video-1",
				metadata: { hermes: { status: "declined" } },
			},
		];
		const { POST } = await import("@/app/api/hermes/meetings/ack/route");

		const response = await POST(
			ackRequest({ id: "video-1", fileName: "a.txt" }),
		);

		expect(response.status).toBe(404);
		expect(patchVideoMetadataMock).not.toHaveBeenCalled();
	});

	it("marks a queued video delivered", async () => {
		dbState.rows = [queuedRow("video-1")];
		patchState.current = {
			hermes: {
				status: "queued",
				clientName: "Ali",
				company: "ACME",
				queuedAt: "2026-10-08T10:00:00.000Z",
			},
		};
		const { POST } = await import("@/app/api/hermes/meetings/ack/route");

		const response = await POST(
			ackRequest({ id: "video-1", fileName: "2026-10-08_Ali_ACME_meet.txt" }),
		);

		expect(response.status).toBe(200);
		expect(patchResults.last?.hermes?.status).toBe("delivered");
		expect(patchResults.last?.hermes?.fileName).toBe(
			"2026-10-08_Ali_ACME_meet.txt",
		);
	});
});
