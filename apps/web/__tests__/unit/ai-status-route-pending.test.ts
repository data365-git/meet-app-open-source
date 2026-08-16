import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Pins the CONTRACT the share panel polls: /api/video/ai must report the live
// transcription status and whether the user's press is still banked. Without
// those fields the panel can only see stale server-rendered props, which is
// what made a genuinely-pending analysis render the start button again.
const videoRows = vi.hoisted(() => ({ value: [] as unknown[] }));

vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: vi.fn(() => ({ id: "user-1" })),
}));

vi.mock("@cap/database", () => ({
	db: () => ({
		select: vi.fn(() => ({
			from: vi.fn(() => ({
				where: vi.fn(() => Promise.resolve(videoRows.value)),
			})),
		})),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: { id: "videos.id", deletedAt: "videos.deletedAt" },
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
}));

vi.mock("@/lib/permissions/roles", () => ({
	getEffectiveOrganizationRole: vi.fn(() => "member"),
}));

import { GET } from "@/app/api/video/ai/route";

const request = () =>
	({ url: "https://example.com/api/video/ai?videoId=vid_1" }) as NextRequest;

beforeEach(() => {
	videoRows.value = [];
});

describe("GET /api/video/ai", () => {
	it("reports a banked press as pending, with the live transcription status", async () => {
		videoRows.value = [
			{
				id: "vid_1",
				ownerId: "user-1",
				transcriptionStatus: null,
				metadata: {
					aiStartPendingUpload: "2026-08-16T09:00:00.000Z",
					aiGenerationRequestedAt: "2026-08-16T09:00:00.000Z",
				},
			},
		];
		const body = await (await GET(request())).json();
		expect(body.aiRequestPending).toBe(true);
		expect(body.transcriptionStatus).toBeNull();
		expect(body.aiGenerationStatus).toBeNull();
	});

	it("stops reporting pending once the pipeline claims the row", async () => {
		videoRows.value = [
			{
				id: "vid_1",
				ownerId: "user-1",
				transcriptionStatus: "PROCESSING",
				metadata: { aiGenerationRequestedAt: "2026-08-16T09:00:00.000Z" },
			},
		];
		const body = await (await GET(request())).json();
		expect(body.aiRequestPending).toBe(false);
		expect(body.transcriptionStatus).toBe("PROCESSING");
	});

	it("carries the fields on the in-progress branch too", async () => {
		videoRows.value = [
			{
				id: "vid_1",
				ownerId: "user-1",
				transcriptionStatus: "COMPLETE",
				metadata: { aiGenerationStatus: "PROCESSING" },
			},
		];
		const body = await (await GET(request())).json();
		expect(body.processing).toBe(true);
		expect(body.transcriptionStatus).toBe("COMPLETE");
		expect(body.aiGenerationStatus).toBe("PROCESSING");
		expect(body.aiRequestPending).toBe(false);
	});
});
