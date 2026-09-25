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

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => Promise.resolve(videoRow.value ? [videoRow.value] : []),
				}),
			}),
		}),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: {
		id: "videos.id",
		ownerId: "videos.ownerId",
		transcriptionStatus: "videos.transcriptionStatus",
		metadata: "videos.metadata",
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
		runPromiseMock.mockRejectedValueOnce(new Error("storage unreachable"));
		const result = await cancelUpload(makeVideoId("video-incomplete"));
		expect(result.ok).toBe(false);
	});
});
