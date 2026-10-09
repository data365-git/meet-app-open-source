import { beforeEach, describe, expect, it, vi } from "vitest";

// A1 — retry-transcription re-spends PAID transcription with no guard. This route
// has zero callers anywhere (dead upstream leftover per the plan), so the fix is a
// cheap, self-contained guard: if the video already has a COMPLETE transcript,
// require an explicit confirm/force flag before deleting it and re-running.

const currentUser = vi.hoisted(() => ({
	value: { id: "user-1" } as { id: string } | null,
}));
const videoRows = vi.hoisted(() => ({ value: [] as unknown[] }));
const deleteWhereMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const deleteMock = vi.hoisted(() => vi.fn(() => ({ where: deleteWhereMock })));
const updateWhereMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const updateSetMock = vi.hoisted(() =>
	vi.fn(() => ({ where: updateWhereMock })),
);
const revalidatePathMock = vi.hoisted(() => vi.fn());
const transcribeVideoMock = vi.hoisted(() =>
	vi.fn(async (..._a: unknown[]) => ({ success: true, message: "started" })),
);

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
		delete: deleteMock,
		update: vi.fn(() => ({ set: updateSetMock })),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: { id: "videos.id" },
	transcriptChunks: { videoId: "transcriptChunks.videoId" },
}));

vi.mock("drizzle-orm", () => ({
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

vi.mock("next/cache", () => ({
	revalidatePath: (path: string) => revalidatePathMock(path),
}));

vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: (...a: unknown[]) => transcribeVideoMock(...a),
}));

import { POST } from "@/app/api/videos/[videoId]/retry-transcription/route";

function makeProps(videoId: string) {
	return { params: Promise.resolve({ videoId }) } as unknown as Parameters<
		typeof POST
	>[1];
}

function makeRequest(body?: unknown): Request {
	return new Request("http://localhost/api/videos/video-1/retry-transcription", {
		method: "POST",
		...(body !== undefined
			? {
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}
			: {}),
	});
}

describe("POST /api/videos/[videoId]/retry-transcription — paid re-run guard (A1)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentUser.value = { id: "user-1" };
		videoRows.value = [];
		deleteMock.mockReturnValue({ where: deleteWhereMock });
		deleteWhereMock.mockResolvedValue(undefined);
		updateSetMock.mockReturnValue({ where: updateWhereMock });
		updateWhereMock.mockResolvedValue(undefined);
		transcribeVideoMock.mockResolvedValue({
			success: true,
			message: "started",
		});
	});

	// 2026-08-10 review finding #3b: after the reset this route used to STOP,
	// with a comment claiming get-status.ts would auto-trigger the retry —
	// false since get-status stopped auto-triggering. The row stayed NULL
	// forever: a "retry" that permanently un-starts the video.
	it("actually STARTS transcription after the reset (nothing auto-triggers on NULL)", async () => {
		videoRows.value = [
			{ id: "video-1", ownerId: "user-1", transcriptionStatus: "ERROR" },
		];

		const response = await POST(makeRequest(), makeProps("video-1"));
		const body = await response.json();

		expect(body.success).toBe(true);
		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"video-1",
			"user-1",
			true,
		);
	});

	it("surfaces a trigger failure instead of silently leaving the row not-started", async () => {
		videoRows.value = [
			{ id: "video-1", ownerId: "user-1", transcriptionStatus: "ERROR" },
		];
		transcribeVideoMock.mockResolvedValue({
			success: false,
			message: "AI budget exceeded",
		});

		const response = await POST(makeRequest(), makeProps("video-1"));

		expect(response.status).toBe(500);
	});

	it("returns 409 and does NOT delete/reset when a COMPLETE transcript exists and no confirm is sent", async () => {
		videoRows.value = [
			{ id: "video-1", ownerId: "user-1", transcriptionStatus: "COMPLETE" },
		];

		const response = await POST(makeRequest(), makeProps("video-1"));
		const body = await response.json();

		expect(response.status).toBe(409);
		expect(body.error).toMatch(/already has a transcript/i);
		expect(deleteMock).not.toHaveBeenCalled();
		expect(updateSetMock).not.toHaveBeenCalled();
		expect(revalidatePathMock).not.toHaveBeenCalled();
	});

	it("returns 409 when confirm is present but falsy", async () => {
		videoRows.value = [
			{ id: "video-1", ownerId: "user-1", transcriptionStatus: "COMPLETE" },
		];

		const response = await POST(
			makeRequest({ confirm: false }),
			makeProps("video-1"),
		);

		expect(response.status).toBe(409);
		expect(deleteMock).not.toHaveBeenCalled();
	});

	it("proceeds (deletes chunks + resets status) when confirm:true is sent with a COMPLETE transcript", async () => {
		videoRows.value = [
			{ id: "video-1", ownerId: "user-1", transcriptionStatus: "COMPLETE" },
		];

		const response = await POST(
			makeRequest({ confirm: true }),
			makeProps("video-1"),
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(deleteMock).toHaveBeenCalledTimes(1);
		expect(updateSetMock).toHaveBeenCalledWith({ transcriptionStatus: null });
	});

	it("proceeds when force:true is sent instead of confirm", async () => {
		videoRows.value = [
			{ id: "video-1", ownerId: "user-1", transcriptionStatus: "COMPLETE" },
		];

		const response = await POST(
			makeRequest({ force: true }),
			makeProps("video-1"),
		);

		expect(response.status).toBe(200);
		expect(deleteMock).toHaveBeenCalledTimes(1);
	});

	it("proceeds without any confirm flag when there is no existing transcript", async () => {
		videoRows.value = [
			{ id: "video-1", ownerId: "user-1", transcriptionStatus: null },
		];

		const response = await POST(makeRequest(), makeProps("video-1"));
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body.success).toBe(true);
		expect(deleteMock).toHaveBeenCalledTimes(1);
	});

	it("proceeds without any confirm flag when the previous run ERRORed (not COMPLETE)", async () => {
		videoRows.value = [
			{ id: "video-1", ownerId: "user-1", transcriptionStatus: "ERROR" },
		];

		const response = await POST(makeRequest(), makeProps("video-1"));

		expect(response.status).toBe(200);
		expect(deleteMock).toHaveBeenCalledTimes(1);
	});

	it("still 401s when unauthenticated, before the guard even runs", async () => {
		currentUser.value = null;

		const response = await POST(makeRequest(), makeProps("video-1"));

		expect(response.status).toBe(401);
		expect(deleteMock).not.toHaveBeenCalled();
	});
});
