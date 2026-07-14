import { beforeEach, describe, expect, it, vi } from "vitest";

const H = vi.hoisted(() => ({
	user: null as { id: string } | null,
	video: null as {
		id: string;
		ownerId: string;
		orgId: string;
		transcriptionStatus: string | null;
	} | null,
	serverEnv: vi.fn(),
	assertAiBudgetAvailable: vi.fn(),
	patchVideoMetadata: vi.fn(),
	refineWorkflow: vi.fn(),
	after: vi.fn(),
	revalidatePath: vi.fn(),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({ where: async () => (H.video ? [H.video] : []) }),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: () => Promise.resolve(H.user),
}));
vi.mock("@cap/database/schema", () => ({ videos: { id: "videos.id" } }));
vi.mock("@cap/env", () => ({ serverEnv: () => H.serverEnv() }));
vi.mock("drizzle-orm", () => ({ eq: vi.fn() }));
vi.mock("next/cache", () => ({
	revalidatePath: (path: string) => H.revalidatePath(path),
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => H.after(fn) }));
vi.mock("@/lib/ai-cost-guard", () => ({
	assertAiBudgetAvailable: (input: unknown) => H.assertAiBudgetAvailable(input),
	BudgetExceededError: class BudgetExceededError extends Error {},
}));
vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: (id: string, patch: (current: object) => object) =>
		H.patchVideoMetadata(id, patch),
}));
vi.mock("@/workflows/transcribe", () => ({
	refineVideoTimestampsWorkflow: (payload: unknown) => H.refineWorkflow(payload),
}));

const { refineVideoTimestamps } = await import(
	"@/actions/video/refine-timestamps"
);

beforeEach(() => {
	H.user = { id: "owner" };
	H.video = {
		id: "video-1",
		ownerId: "owner",
		orgId: "org-1",
		transcriptionStatus: "COMPLETE",
	};
	H.serverEnv.mockReset().mockReturnValue({ ELEVENLABS_API_KEY: "key" });
	H.assertAiBudgetAvailable.mockReset().mockResolvedValue(undefined);
	H.patchVideoMetadata.mockReset().mockImplementation(
		async (_id: string, patch: (current: object) => object) => patch({}),
	);
	H.refineWorkflow.mockReset().mockResolvedValue({ success: true });
	H.after.mockReset();
	H.revalidatePath.mockReset();
});

describe("refineVideoTimestamps", () => {
	it("rejects a non-owner before budget or background work", async () => {
		H.user = { id: "intruder" };

		expect(await refineVideoTimestamps("video-1")).toEqual({
			ok: false,
			reason: "unauthorized",
		});
		expect(H.assertAiBudgetAvailable).not.toHaveBeenCalled();
		expect(H.after).not.toHaveBeenCalled();
	});

	it("does not queue paid work when Scribe is not configured", async () => {
		H.serverEnv.mockReturnValue({});

		expect(await refineVideoTimestamps("video-1")).toEqual({
			ok: false,
			reason: "missing_key",
		});
		expect(H.after).not.toHaveBeenCalled();
	});

	it("requires an existing completed Gemini transcript", async () => {
		if (H.video) H.video.transcriptionStatus = null;

		expect(await refineVideoTimestamps("video-1")).toEqual({
			ok: false,
			reason: "missing_transcript",
		});
		expect(H.after).not.toHaveBeenCalled();
	});

	it("marks processing and queues exactly one owner-scoped refinement", async () => {
		const result = await refineVideoTimestamps("video-1");

		expect(result).toEqual({ ok: true });
		expect(H.patchVideoMetadata).toHaveBeenCalledOnce();
		const patch = H.patchVideoMetadata.mock.calls[0]?.[1] as (
			current: Record<string, unknown>,
		) => Record<string, unknown>;
		expect(patch({ kept: true })).toMatchObject({
			kept: true,
			timestampRefinement: { status: "PROCESSING" },
		});
		expect(H.after).toHaveBeenCalledOnce();
		expect(H.refineWorkflow).not.toHaveBeenCalled();
	});
});
