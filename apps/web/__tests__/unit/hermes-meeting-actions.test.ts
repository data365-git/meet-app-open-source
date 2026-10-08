import type { VideoMetadata } from "@cap/database/types";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ADR 2026-10-08 part A must-fixes: the Hermes dialog actions are ADMINS ONLY
// (the video-owner exception is gone), the hermes status race is re-checked
// INSIDE the patchVideoMetadata updater, and queue on a non-COMPLETE
// transcript starts the pipeline exactly like the generate route in
// transcript mode: transcribeVideo(..., false, false).

const currentUser = vi.hoisted(() => ({
	value: { id: "user-1" } as { id: string; isAdmin?: boolean },
}));
const selectResults = vi.hoisted(() => ({ queue: [] as unknown[][] }));
const effectiveRole = vi.hoisted(() => ({ value: "admin" as string }));
const transcribeVideoMock = vi.hoisted(() => vi.fn());
const patchState = vi.hoisted(() => ({
	current: {} as VideoMetadata,
}));
const patchVideoMetadataMock = vi.hoisted(() =>
	vi.fn(async (_videoId: string, patch: (cur: VideoMetadata) => VideoMetadata) =>
		patch({ ...patchState.current }),
	),
);

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(async () => currentUser.value),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: vi.fn(() => ({
			from: () => ({
				where: () => ({
					limit: () => {
						const next = selectResults.queue.shift() ?? [];
						return Promise.resolve(next);
					},
				}),
				leftJoin: () => ({
					where: () => ({
						limit: () => {
							const next = selectResults.queue.shift() ?? [];
							return Promise.resolve(next);
						},
					}),
				}),
			}),
		})),
		update: () => ({
			set: () => ({ where: () => Promise.resolve() }),
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
		libraryKind: "videos.libraryKind",
		source: "videos.source",
		deletedAt: "videos.deletedAt",
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

vi.mock("@cap/web-domain", () => ({
	Video: {},
}));

vi.mock("@cap/env", () => ({
	serverEnv: () => ({}),
}));

vi.mock("next/cache", () => ({
	revalidatePath: vi.fn(),
}));

vi.mock("@/lib/permissions/roles", () => ({
	getEffectiveOrganizationRole: vi.fn(() => effectiveRole.value),
}));

vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: transcribeVideoMock,
}));

vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: patchVideoMetadataMock,
}));

// A Meetings-library video row as loadVideoForHermes returns it.
function meetingsVideoRow(over: Record<string, unknown> = {}) {
	return {
		id: "video-1",
		ownerId: "owner-1",
		orgId: "org-1",
		transcriptionStatus: "COMPLETE",
		metadata: {},
		libraryKind: "meeting",
		source: null,
		...over,
	};
}

const QUEUED_HERMES = {
	status: "queued",
	clientName: "Ali",
	company: "ACME",
	queuedAt: "2026-10-08T10:00:00.000Z",
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	currentUser.value = { id: "user-1" };
	selectResults.queue = [];
	effectiveRole.value = "admin";
	patchState.current = {};
	transcribeVideoMock.mockReset();
	transcribeVideoMock.mockResolvedValue({ success: true });
});

describe("hermes-meeting actions: admins only (no owner exception)", () => {
	it("denies a non-admin org member", async () => {
		currentUser.value = { id: "user-1" };
		effectiveRole.value = "member";
		selectResults.queue = [
			[meetingsVideoRow()],
			[{ ownerId: "owner-1", memberRole: "member" }],
		];
		const { declineHermesMeeting } = await import(
			"@/actions/videos/hermes-meeting"
		);

		const result = await declineHermesMeeting("video-1");

		expect(result).toEqual({
			success: false,
			error: "Faqat adminlar uchun",
		});
		expect(patchVideoMetadataMock).not.toHaveBeenCalled();
	});

	it("denies a non-admin video OWNER (ADR: admins only)", async () => {
		currentUser.value = { id: "owner-1" }; // == video.ownerId
		effectiveRole.value = "member";
		selectResults.queue = [
			[meetingsVideoRow()],
			[{ ownerId: "owner-1", memberRole: "member" }],
		];
		const { declineHermesMeeting } = await import(
			"@/actions/videos/hermes-meeting"
		);

		const result = await declineHermesMeeting("video-1");

		expect(result).toEqual({
			success: false,
			error: "Faqat adminlar uchun",
		});
		expect(patchVideoMetadataMock).not.toHaveBeenCalled();
	});

	it("denies a non-admin video OWNER even with no org at all", async () => {
		currentUser.value = { id: "owner-1" };
		selectResults.queue = [
			[
				meetingsVideoRow({
					ownerId: "owner-1",
					orgId: null,
					libraryKind: null,
					source: { type: "extensionWeb", context: "meeting" },
				}),
			],
		];
		const { queueHermesMeeting } = await import(
			"@/actions/videos/hermes-meeting"
		);

		const result = await queueHermesMeeting("video-1", "Ali", "ACME");

		expect(result).toEqual({
			success: false,
			error: "Faqat adminlar uchun",
		});
		expect(transcribeVideoMock).not.toHaveBeenCalled();
		expect(patchVideoMetadataMock).not.toHaveBeenCalled();
	});

	it("denies a non-Meetings video even for an admin", async () => {
		selectResults.queue = [[meetingsVideoRow({ libraryKind: "recording" })]];
		const { declineHermesMeeting } = await import(
			"@/actions/videos/hermes-meeting"
		);

		const result = await declineHermesMeeting("video-1");

		expect(result).toEqual({
			success: false,
			error: "Faqat Meetings kutubxonasidagi videolar uchun",
		});
		expect(patchVideoMetadataMock).not.toHaveBeenCalled();
	});
});

describe("queueHermesMeeting", () => {
	it("starts transcription with AI disabled args on a non-COMPLETE transcript", async () => {
		selectResults.queue = [
			[meetingsVideoRow({ transcriptionStatus: null })],
			[{ ownerId: "owner-1", memberRole: "admin" }],
		];
		const { queueHermesMeeting } = await import(
			"@/actions/videos/hermes-meeting"
		);

		const result = await queueHermesMeeting("video-1", "Ali", "ACME");

		expect(result.success).toBe(true);
		expect(transcribeVideoMock).toHaveBeenCalledTimes(1);
		// Exactly the generate route's transcript mode: no AI, no notification.
		expect(transcribeVideoMock).toHaveBeenCalledWith(
			"video-1",
			"owner-1",
			false,
			false,
		);
	});

	it("keeps queuedAt when the row became queued between read and patch", async () => {
		// The pre-read sees no hermes state; the locked row inside the patch
		// is already queued by someone else — the race the review found.
		selectResults.queue = [
			[meetingsVideoRow({ transcriptionStatus: "COMPLETE", metadata: {} })],
			[{ ownerId: "owner-1", memberRole: "admin" }],
		];
		patchState.current = { hermes: { ...QUEUED_HERMES } };
		const { queueHermesMeeting } = await import(
			"@/actions/videos/hermes-meeting"
		);

		const result = await queueHermesMeeting("video-1", "Boshqa", "Mijoz");

		expect(result.success).toBe(true);
		// Idempotent success, and the FIRST queuer's fields survive untouched.
		expect(result).toEqual({
			success: true,
			hermes: { ...QUEUED_HERMES },
		});
	});
});

describe("declineHermesMeeting race", () => {
	it("refuses to decline a video that became queued before the patch", async () => {
		selectResults.queue = [
			[meetingsVideoRow({ metadata: {} })],
			[{ ownerId: "owner-1", memberRole: "admin" }],
		];
		patchState.current = { hermes: { ...QUEUED_HERMES } };
		const { declineHermesMeeting } = await import(
			"@/actions/videos/hermes-meeting"
		);

		const result = await declineHermesMeeting("video-1");

		expect(result).toEqual({
			success: false,
			error: "Bu video allaqachon Hermesga yuborilgan",
		});
	});

	it("records the decline for an admin on an unclaimed Meetings video", async () => {
		selectResults.queue = [
			[meetingsVideoRow({ metadata: {} })],
			[{ ownerId: "owner-1", memberRole: "admin" }],
		];
		patchState.current = {};
		const { declineHermesMeeting } = await import(
			"@/actions/videos/hermes-meeting"
		);

		const result = await declineHermesMeeting("video-1");

		expect(result).toEqual({ success: true, hermes: { status: "declined" } });
	});
});
