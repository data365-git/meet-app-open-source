import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const currentUser = vi.hoisted(() => ({
	value: { id: "user-1" } as { id: string; isAdmin?: boolean },
}));
const videoRows = vi.hoisted(() => ({
	value: [] as unknown[],
}));
const updateWhereMock = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const updateSetMock = vi.hoisted(() =>
	vi.fn(() => ({ where: updateWhereMock })),
);
const startAiGenerationMock = vi.hoisted(() => vi.fn());
const transcribeVideoMock = vi.hoisted(() => vi.fn());

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
		update: vi.fn(() => ({
			set: updateSetMock,
		})),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: { id: "videos.id" },
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

vi.mock("@/lib/permissions/roles", () => ({
	getEffectiveOrganizationRole: vi.fn(() => "admin"),
}));

vi.mock("@/lib/generate-ai", () => ({
	startAiGeneration: startAiGenerationMock,
}));

vi.mock("@/lib/transcribe", () => ({
	transcribeVideo: transcribeVideoMock,
}));

describe("POST /api/videos/[videoId]/generate", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// AI generation is admin-gated (canUseAI) — the route 403s for non-admins.
		currentUser.value = { id: "user-1", isAdmin: true };
		videoRows.value = [];
		updateSetMock.mockReturnValue({ where: updateWhereMock });
		updateWhereMock.mockResolvedValue(undefined);
	});

	it("records manual AI intent when transcription is already processing", async () => {
		videoRows.value = [
			{
				id: "video-1",
				ownerId: "user-1",
				orgId: null,
				transcriptionStatus: "PROCESSING",
				metadata: { sourceName: "Meet tab" },
			},
		];

		const { POST } = await import("@/app/api/videos/[videoId]/generate/route");
		const response = await POST(
			new Request("http://localhost") as unknown as NextRequest,
			{
				params: Promise.resolve({ videoId: "video-1" }),
			},
		);
		const body = await response.json();

		expect(response.status).toBe(200);
		expect(body).toEqual({
			alreadyRunning: true,
			queuedAfterTranscription: true,
		});
		// The request markers are written via a server-side JSON_SET merge (so
		// concurrent workflow writes survive), not a plain object replace.
		const setArg = (
			updateSetMock.mock.calls[0] as unknown[] | undefined
		)?.[0] as {
			metadata: { sql: string; values: unknown[] };
		};
		expect(setArg.metadata.sql).toContain("JSON_SET");
		expect(setArg.metadata.sql).toContain("'$.aiGenerationRequestedAt'");
		expect(setArg.metadata.sql).toContain("'$.aiGenerationRequestedBy'");
		expect(setArg.metadata.values).toContain("user-1");
		expect(startAiGenerationMock).not.toHaveBeenCalled();
		expect(transcribeVideoMock).not.toHaveBeenCalled();
	});

	it("NEVER changes a RUNNING job's mode and never clobbers workflow-written metadata", async () => {
		// 2026-08-10 review finding #2: this branch used to write
		// {...metadata, aiMode: speedMode ?? ...} — a plain spread of a row read
		// seconds earlier. (a) a stale panel posting speedMode:"fast" flipped a
		// RUNNING cheap job to the paid path; (b) everything the workflow wrote
		// in between (aiBatchJobs, aiQuotaWaiting, chunk progress) was reverted,
		// and a lost Batch handle is never collected.
		videoRows.value = [
			{
				id: "video-1",
				ownerId: "user-1",
				orgId: null,
				transcriptionStatus: "PROCESSING",
				metadata: {
					aiMode: "cheap",
					aiBatchJobs: [{ batchName: "batches/a" }],
					aiQuotaWaiting: true,
				},
			},
		];

		const { POST } = await import("@/app/api/videos/[videoId]/generate/route");
		const response = await POST(
			new Request("http://localhost", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ speedMode: "fast" }),
			}) as unknown as NextRequest,
			{
				params: Promise.resolve({ videoId: "video-1" }),
			},
		);

		expect(response.status).toBe(200);
		expect(updateSetMock).toHaveBeenCalledTimes(1);
		const setArg = (
			updateSetMock.mock.calls[0] as unknown[] | undefined
		)?.[0] as {
			metadata: { sql: string; values: unknown[] } | Record<string, unknown>;
		};
		// The whole write must be a server-side merge, not an object replace...
		expect("sql" in setArg.metadata).toBe(true);
		const serialized = JSON.stringify(setArg.metadata);
		// ...and it must not touch aiMode at all — a start request cannot
		// change the mode of a job that is already running.
		expect(serialized).not.toContain("aiMode");
		expect(serialized).not.toContain('"fast"');
		expect(transcribeVideoMock).not.toHaveBeenCalled();
	});
});
