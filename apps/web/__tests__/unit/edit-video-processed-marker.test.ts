import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A trim writes the edited result.mp4 but keeps the PRE-EDIT raw-upload.*
 * (save-edits.ts copies it, never deletes it). Without the durable
 * `metadata.processedAt` marker the recover-stale-ai-jobs rowless pass would
 * relaunch processing from that raw and silently undo the trim. Drives the
 * REAL editVideoWorkflow; only DB / storage / ffmpeg boundaries are stubbed.
 */

const state = vi.hoisted(() => ({
	videoRow: null as Record<string, unknown> | null,
	trimFails: false,
	trimmedPath: "",
}));

function isSqlExpression(
	value: unknown,
): value is { sql: string; values: unknown[] } {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { sql?: unknown }).sql === "string"
	);
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => Promise.resolve(state.videoRow ? [state.videoRow] : []),
				}),
			}),
		}),
		update: () => ({
			set: (values: Record<string, unknown>) => ({
				where: () => {
					if (state.videoRow) {
						for (const [key, value] of Object.entries(values)) {
							if (key === "metadata" && isSqlExpression(value)) {
								const next = {
									...((state.videoRow.metadata as Record<string, unknown>) ?? {}),
								};
								const segments = value.sql.split("?");
								for (let i = 0; i < segments.length - 1; i++) {
									const match = /'\$\.([A-Za-z0-9_]+)'\s*,\s*$/.exec(
										segments[i] ?? "",
									);
									if (match?.[1]) next[match[1]] = value.values[i];
								}
								state.videoRow.metadata = next;
							} else {
								state.videoRow[key] = value;
							}
						}
					}
					return Promise.resolve([{ affectedRows: 1 }]);
				},
			}),
		}),
		delete: () => ({ where: () => Promise.resolve([]) }),
	}),
}));

vi.mock("@cap/database/schema", () => ({
	videos: { id: "videos.id", metadata: "videos.metadata", duration: "videos.duration" },
	videoUploads: { videoId: "videoUploads.videoId", rawFileKey: "videoUploads.rawFileKey" },
}));

vi.mock("@cap/web-domain", () => ({ Video: {} }));

vi.mock("drizzle-orm", () => ({
	and: vi.fn((...args: unknown[]) => args),
	eq: vi.fn((field: unknown, value: unknown) => ({ field, value })),
	sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
		sql: strings.join("?"),
		values,
	})),
}));

vi.mock("workflow", () => ({
	FatalError: class FatalError extends Error {},
}));

vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));

vi.mock("@/lib/video-storage", async () => {
	const { Option } = await import("effect");
	return {
		getStorageAccessForVideo: vi.fn(() => ({
			pipe: () =>
				Promise.resolve([
					{
						getInternalSignedObjectUrl: () => ({
							pipe: () => Promise.resolve("https://storage.test/source.mp4"),
						}),
						putObject: () => ({ pipe: () => Promise.resolve(undefined) }),
						// No transcript yet — the remap step is a no-op.
						getObject: () => ({ pipe: () => Promise.resolve(Option.none()) }),
					},
				]),
		})),
	};
});

vi.mock("@/lib/video-convert", () => ({
	trimRemoteVideoToMp4: vi.fn(() =>
		state.trimFails
			? Promise.reject(new Error("ffmpeg exploded"))
			: Promise.resolve({
					filePath: state.trimmedPath,
					metadata: { durationSec: 30 },
					cleanup: () => Promise.resolve(),
				}),
	),
}));

vi.mock("@/lib/video-edits", () => ({
	getEditSpecOutputDuration: vi.fn(() => 30),
}));

vi.mock("@/lib/vtt-edit-remap", () => ({
	remapChaptersByStart: vi.fn(),
	remapChaptersByStartSec: vi.fn(),
	remapVttCuesForEdit: vi.fn(),
}));

const VIDEO_ID = "editvideo123456";

const run = async () => {
	const { editVideoWorkflow } = await import("@/workflows/edit-video");
	return editVideoWorkflow({
		videoId: VIDEO_ID,
		userId: "owner-1",
		sourceKey: `owner-1/${VIDEO_ID}/source/original.mp4`,
		previousSpec: {} as never,
		editSpec: {} as never,
		keepRanges: [{ start: 5, end: 35 }],
		aiGenerationEnabled: false,
	});
};

describe("editVideoWorkflow — durable processedAt marker", () => {
	beforeAll(async () => {
		state.trimmedPath = join(tmpdir(), `edit-video-marker-${Date.now()}.mp4`);
		await fs.writeFile(state.trimmedPath, Buffer.from([0, 1, 2, 3]));
	});

	afterAll(async () => {
		await fs.rm(state.trimmedPath, { force: true });
	});

	beforeEach(() => {
		state.trimFails = false;
		state.videoRow = {
			id: VIDEO_ID,
			ownerId: "owner-1",
			width: 1280,
			height: 720,
			fps: 30,
			metadata: {},
		};
	});

	it("a finished trim writes metadata.processedAt (ISO)", async () => {
		await run();

		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		expect(typeof metadata.processedAt).toBe("string");
		expect(new Date(Date.parse(metadata.processedAt as string)).toISOString()).toBe(
			metadata.processedAt,
		);
	});

	it("a failed trim writes no marker", async () => {
		state.trimFails = true;

		await expect(run()).rejects.toThrow("ffmpeg exploded");

		const metadata = state.videoRow?.metadata as Record<string, unknown>;
		expect(metadata.processedAt).toBeUndefined();
	});
});
