/**
 * Owner order 2026-09-11: a Cancel control on an in-progress import upload.
 * This is the SAFETY half — cancelUpload must never be able to discard a
 * video that already started processing, whatever the client sends, because
 * the same server action reuses Videos.permanentlyDelete (irreversible).
 *
 * runPromise is mocked to a no-op rather than actually interpreting the
 * Effect: Effect.gen's generator body (the `yield* Videos` call) never runs
 * until something really executes the Effect, so this proves the SAFETY
 * CHECK's decision to attempt-or-refuse deletion without needing to fake the
 * whole Videos/Effect plumbing. Assertions are on the OUTCOME (was the
 * deletion path even attempted, what did the caller see) never on internals.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.hoisted(() => ({
	value: null as { id: string } | null,
}));
const videoRow = vi.hoisted(() => ({
	value: null as {
		id: string;
		ownerId: string;
		transcriptionStatus: string | null;
		metadata: Record<string, unknown> | null;
	} | null,
}));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(() => currentUser.value),
}));

// The video_uploads row. `deleteAffectedRows` models the conditional claim
// (DELETE ... WHERE phase = 'uploading'): by default it reflects the row's
// phase, and a test can force 0 to simulate /complete flipping the phase
// between the read and the delete.
const uploadRow = vi.hoisted(() => ({
	value: null as { videoId: string; phase: string } | null,
	deleteAffectedRows: null as number | null,
	inserted: [] as unknown[],
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: (table: { __table: string }) => ({
				where: () => ({
					limit: () => {
						if (table.__table === "video_uploads") {
							return Promise.resolve(uploadRow.value ? [uploadRow.value] : []);
						}
						return Promise.resolve(videoRow.value ? [videoRow.value] : []);
					},
				}),
			}),
		}),
		delete: () => ({
			where: () =>
				Promise.resolve([
					{
						affectedRows:
							uploadRow.deleteAffectedRows ??
							(uploadRow.value?.phase === "uploading" ? 1 : 0),
					},
				]),
		}),
		insert: () => ({
			values: (row: unknown) => {
				uploadRow.inserted.push(row);
				return Promise.resolve();
			},
		}),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: {
		__table: "videos",
		id: "videos.id",
		ownerId: "videos.ownerId",
		transcriptionStatus: "videos.transcriptionStatus",
		metadata: "videos.metadata",
	},
	videoUploads: {
		__table: "video_uploads",
		videoId: "videoUploads.videoId",
		phase: "videoUploads.phase",
	},
}));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
}));

vi.mock("@cap/web-backend", () => ({
	Videos: Symbol("Videos"),
	makeCurrentUserLayer: vi.fn(() => "fake-layer"),
}));

// The Effect never actually runs — see the file header — so this mock only
// needs to be observable, not correct: its call count proves whether the
// caller ever tried to reach the deletion effect.
const runPromiseMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock("@/lib/server", () => ({
	runPromise: runPromiseMock,
}));

// Effect.provide inspects its layer argument's real internal shape even
// though the resulting Effect is never interpreted here (runPromise is fully
// mocked above), so the fake "fake-layer" string from makeCurrentUserLayer's
// mock throws when Effect.provide's real implementation touches it. Only
// `provide` is replaced — with a curried identity that ignores the layer
// entirely — everything else in `effect` stays real.
vi.mock("effect", async (importOriginal) => {
	const actual = await importOriginal<typeof import("effect")>();
	return {
		...actual,
		Effect: {
			...actual.Effect,
			provide: () => (effectValue: unknown) => effectValue,
		},
	};
});

const { cancelUpload } = await import("@/actions/video/cancel-upload");

function makeVideoId(id: string) {
	return id as unknown as Parameters<typeof cancelUpload>[0];
}

describe("cancelUpload", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		currentUser.value = { id: "user-1" };
		videoRow.value = null;
		uploadRow.value = null;
		uploadRow.deleteAffectedRows = null;
		uploadRow.inserted = [];
	});

	it("refuses when unauthenticated, without touching the database", async () => {
		currentUser.value = null;
		const result = await cancelUpload(makeVideoId("video-1"));
		expect(result).toEqual({ ok: false, error: "Not authenticated" });
		expect(runPromiseMock).not.toHaveBeenCalled();
	});

	it("treats an already-gone row as success (idempotent — a retried cancel is fine)", async () => {
		videoRow.value = null; // no row at all: already cleaned up
		const result = await cancelUpload(makeVideoId("video-missing"));
		expect(result).toEqual({ ok: true });
		expect(runPromiseMock).not.toHaveBeenCalled();
	});

	it("REFUSES a video whose transcription already started — never attempts deletion", async () => {
		videoRow.value = {
			id: "video-started",
			ownerId: "user-1",
			transcriptionStatus: "PROCESSING",
			metadata: null,
		};
		const result = await cancelUpload(makeVideoId("video-started"));
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatch(/already started processing/i);
		}
		// The load-bearing assertion: the deletion path was never reached.
		expect(runPromiseMock).not.toHaveBeenCalled();
	});

	it("REFUSES a video with a processingStartedAt marker, even with transcriptionStatus NULL", async () => {
		videoRow.value = {
			id: "video-marked",
			ownerId: "user-1",
			transcriptionStatus: null,
			metadata: { processingStartedAt: "2026-09-11T00:00:00.000Z" },
		};
		const result = await cancelUpload(makeVideoId("video-marked"));
		expect(result.ok).toBe(false);
		expect(runPromiseMock).not.toHaveBeenCalled();
	});

	it("attempts deletion for a genuinely incomplete upload (no transcription, no marker)", async () => {
		videoRow.value = {
			id: "video-incomplete",
			ownerId: "user-1",
			transcriptionStatus: null,
			metadata: { isAudio: true },
		};
		uploadRow.value = { videoId: "video-incomplete", phase: "uploading" };
		const result = await cancelUpload(makeVideoId("video-incomplete"));
		expect(result).toEqual({ ok: true });
		expect(runPromiseMock).toHaveBeenCalledTimes(1);
	});

	it("reports failure without throwing when the delete effect rejects", async () => {
		videoRow.value = {
			id: "video-incomplete",
			ownerId: "user-1",
			transcriptionStatus: null,
			metadata: null,
		};
		uploadRow.value = { videoId: "video-incomplete", phase: "uploading" };
		runPromiseMock.mockRejectedValueOnce(new Error("storage unreachable"));
		const result = await cancelUpload(makeVideoId("video-incomplete"));
		expect(result.ok).toBe(false);
		// The claimed upload row is put back so a retried Cancel still works.
		expect(uploadRow.inserted).toEqual([
			{ videoId: "video-incomplete", phase: "uploading" },
		]);
	});

	// Review fix 2026-09-25: the transcription fields alone let a recording
	// that is processing, or processed-but-untranscribed, be erased for good.
	// Only a video_uploads row still in phase 'uploading' may be cancelled.
	describe("requires a video_uploads row in phase 'uploading'", () => {
		const untranscribed = {
			id: "video-x",
			ownerId: "user-1",
			transcriptionStatus: null,
			metadata: null,
		};

		it("REFUSES when there is no video_uploads row", async () => {
			videoRow.value = untranscribed;
			uploadRow.value = null;
			const result = await cancelUpload(makeVideoId("video-x"));
			expect(result.ok).toBe(false);
			expect(runPromiseMock).not.toHaveBeenCalled();
		});

		it("REFUSES when the upload row is in phase 'processing'", async () => {
			videoRow.value = untranscribed;
			uploadRow.value = { videoId: "video-x", phase: "processing" };
			const result = await cancelUpload(makeVideoId("video-x"));
			expect(result.ok).toBe(false);
			expect(runPromiseMock).not.toHaveBeenCalled();
		});

		it("REFUSES when the upload row is in phase 'error'", async () => {
			videoRow.value = untranscribed;
			uploadRow.value = { videoId: "video-x", phase: "error" };
			const result = await cancelUpload(makeVideoId("video-x"));
			expect(result.ok).toBe(false);
			expect(runPromiseMock).not.toHaveBeenCalled();
		});

		it("REFUSES when the phase flips away from 'uploading' before the claim", async () => {
			videoRow.value = untranscribed;
			uploadRow.value = { videoId: "video-x", phase: "uploading" };
			uploadRow.deleteAffectedRows = 0; // /complete won the race
			const result = await cancelUpload(makeVideoId("video-x"));
			expect(result.ok).toBe(false);
			expect(runPromiseMock).not.toHaveBeenCalled();
		});

		it("ALLOWS deletion when the upload row is in phase 'uploading'", async () => {
			videoRow.value = untranscribed;
			uploadRow.value = { videoId: "video-x", phase: "uploading" };
			const result = await cancelUpload(makeVideoId("video-x"));
			expect(result).toEqual({ ok: true });
			expect(runPromiseMock).toHaveBeenCalledTimes(1);
		});
	});
});
