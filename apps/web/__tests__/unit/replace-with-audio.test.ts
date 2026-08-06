import { beforeEach, describe, expect, it, vi } from "vitest";

// T4b "replace video with audio" — a DATA-LOSS server action. These tests
// exist to pin the safety-first ordering: the newly-written audio object
// MUST read back correctly (step 6 verify) before anything is deleted (step
// 7 reclaim). Test 5 is mutation-critical: if the verify guard is ever
// removed/weakened, deleteObject gets called on a verify_failed path and
// this test goes red.

const H = vi.hoisted(() => ({
	getCurrentUser: vi.fn(),
	video: null as {
		id: string;
		ownerId: string;
		metadata: Record<string, unknown>;
	} | null,
	// key -> byte size of the object currently "in storage"
	existingObjects: new Map<string, number>(),
	// when true, a putObject call acks success but does NOT update
	// existingObjects — simulating a write that didn't actually persist.
	putSkipsWrite: false,
	callOrder: [] as string[],
	putObjectCalls: [] as Array<{
		key: string;
		body: Buffer;
		fields: unknown;
	}>,
	deleteObjectCalls: [] as string[],
	extractAudioForDownload: vi.fn(),
	extractAudioToBuffer: vi.fn(),
	patchVideoMetadata: vi.fn(
		async (
			_id: string,
			patch: (m: Record<string, unknown>) => Record<string, unknown>,
		) => patch({}),
	),
	revalidatePath: vi.fn(),
	getStorageAccessForVideo: vi.fn(),
}));

function makeBucket() {
	return {
		headObject: (key: string) => {
			H.callOrder.push(`head:${key}`);
			return {
				pipe: () => {
					const size = H.existingObjects.get(key);
					if (size === undefined) {
						return Promise.reject(new Error("NoSuchKey"));
					}
					return Promise.resolve({ ContentLength: size });
				},
			};
		},
		getInternalSignedObjectUrl: (key: string) => {
			H.callOrder.push(`signUrl:${key}`);
			return { pipe: () => Promise.resolve(`https://signed/${key}`) };
		},
		putObject: (
			key: string,
			body: Buffer,
			fields: { contentType?: string; contentLength?: number },
		) => {
			H.callOrder.push(`put:${key}`);
			H.putObjectCalls.push({ key, body, fields });
			return {
				pipe: () => {
					if (!H.putSkipsWrite) {
						H.existingObjects.set(key, body.length);
					}
					return Promise.resolve(undefined);
				},
			};
		},
		deleteObject: (key: string) => {
			H.callOrder.push(`delete:${key}`);
			H.deleteObjectCalls.push(key);
			return {
				pipe: () => {
					H.existingObjects.delete(key);
					return Promise.resolve(undefined);
				},
			};
		},
	};
}

vi.mock("@cap/database", () => ({
	db: () => ({
		select: () => ({
			from: () => ({
				where: async () => (H.video ? [H.video] : []),
			}),
		}),
	}),
}));
vi.mock("@cap/database/auth/session", () => ({
	getCurrentUser: () => H.getCurrentUser(),
}));
vi.mock("@cap/database/schema", () => ({
	videos: { id: "videos.id", ownerId: "videos.ownerId", metadata: "videos.metadata" },
}));
vi.mock("drizzle-orm", () => ({
	eq: (f: unknown, v: unknown) => ({ f, v }),
}));
vi.mock("next/cache", () => ({
	revalidatePath: (path: string) => H.revalidatePath(path),
}));
vi.mock("@/lib/audio-extract", () => ({
	extractAudioForDownload: (url: string) => H.extractAudioForDownload(url),
	// Exposed only so the test below can prove it is NOT the one used here.
	extractAudioToBuffer: (url: string) => H.extractAudioToBuffer(url),
}));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("@/lib/video-metadata", () => ({
	patchVideoMetadata: (
		id: string,
		patch: (m: Record<string, unknown>) => Record<string, unknown>,
	) => H.patchVideoMetadata(id, patch),
}));
vi.mock("@/lib/video-storage", () => ({
	getStorageAccessForVideo: (video: unknown) => H.getStorageAccessForVideo(video),
}));

const { replaceVideoWithAudio } = await import("@/actions/video/replace-with-audio");

const OWNER_ID = "owner1";
const VIDEO_ID = "v1";
const RESULT_KEY = `${OWNER_ID}/${VIDEO_ID}/result.mp4`;
const RAW_MP4_KEY = `${OWNER_ID}/${VIDEO_ID}/raw-upload.mp4`;
const RAW_WEBM_KEY = `${OWNER_ID}/${VIDEO_ID}/raw-upload.webm`;

beforeEach(() => {
	H.getCurrentUser.mockReset();
	H.video = { id: VIDEO_ID, ownerId: OWNER_ID, metadata: {} };
	H.existingObjects = new Map();
	H.putSkipsWrite = false;
	H.callOrder = [];
	H.putObjectCalls = [];
	H.deleteObjectCalls = [];
	H.extractAudioForDownload.mockReset();
	H.patchVideoMetadata.mockReset().mockImplementation(
		async (
			_id: string,
			patch: (m: Record<string, unknown>) => Record<string, unknown>,
		) => patch({}),
	);
	H.revalidatePath.mockReset();
	H.getStorageAccessForVideo
		.mockReset()
		.mockImplementation(() => ({ pipe: () => Promise.resolve([makeBucket()]) }));
});

describe("replaceVideoWithAudio", () => {
	it("1. non-owner is rejected before any storage call", async () => {
		H.getCurrentUser.mockResolvedValue({ id: "intruder" });

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({ ok: false, reason: "unauthorized" });
		expect(H.getStorageAccessForVideo).not.toHaveBeenCalled();
		expect(H.putObjectCalls).toHaveLength(0);
		expect(H.deleteObjectCalls).toHaveLength(0);
	});

	it("2. already isAudio short-circuits with no storage calls", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		H.video = { id: VIDEO_ID, ownerId: OWNER_ID, metadata: { isAudio: true } };

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({ ok: false, reason: "already_audio" });
		expect(H.getStorageAccessForVideo).not.toHaveBeenCalled();
		expect(H.putObjectCalls).toHaveLength(0);
		expect(H.deleteObjectCalls).toHaveLength(0);
	});

	it("3. no supported source key exists -> unsupported_source, no delete", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		// existingObjects stays empty — none of result.mp4/raw-upload.mp4/.webm exist

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({ ok: false, reason: "unsupported_source" });
		expect(H.putObjectCalls).toHaveLength(0);
		expect(H.deleteObjectCalls).toHaveLength(0);
	});

	// The audio this action writes is EVERYTHING THAT SURVIVES — the video is
	// deleted — and a person listens to it. It originally used the Gemini-grade
	// extractor (mono / 24 kHz / 64 kbit/s), which is correct for a speech model
	// and telephone quality for a human. The owner replaced a 53-minute client
	// meeting on 2026-08-06 and got exactly that, unrecoverably. RED against
	// that version.
	it("0. uses the LISTENING-grade extractor, never the Gemini-grade one", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		H.existingObjects.set(RESULT_KEY, 1_000_000);
		H.extractAudioForDownload.mockResolvedValue(Buffer.alloc(500, 1));

		await replaceVideoWithAudio(VIDEO_ID);

		expect(H.extractAudioForDownload).toHaveBeenCalledTimes(1);
		expect(H.extractAudioToBuffer).not.toHaveBeenCalled();
	});

	it("4. happy path: extract -> put -> verify -> reclaim -> patch metadata, in order", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		H.existingObjects.set(RESULT_KEY, 1_000_000); // pre-existing video bytes
		H.existingObjects.set(RAW_MP4_KEY, 900_000); // reclaimable
		// RAW_WEBM_KEY intentionally absent — must NOT show up in reclaimedFrom
		const audioBuf = Buffer.alloc(500, 1);
		H.extractAudioForDownload.mockResolvedValue(audioBuf);
		H.patchVideoMetadata.mockImplementation(
			async (
				_id: string,
				patch: (m: Record<string, unknown>) => Record<string, unknown>,
			) => patch({ aiSummary: { overview: "kept" } }),
		);

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({
			ok: true,
			reclaimedFrom: [RAW_MP4_KEY],
		});

		// put wrote the audio bytes to result.mp4 as audio/mpeg
		expect(H.putObjectCalls).toEqual([
			{
				key: RESULT_KEY,
				body: audioBuf,
				fields: { contentType: "audio/mpeg", contentLength: audioBuf.length },
			},
		]);

		// SAFETY ordering: put happens strictly before the reclaim delete.
		const putIndex = H.callOrder.indexOf(`put:${RESULT_KEY}`);
		const deleteIndex = H.callOrder.indexOf(`delete:${RAW_MP4_KEY}`);
		expect(putIndex).toBeGreaterThanOrEqual(0);
		expect(deleteIndex).toBeGreaterThan(putIndex);

		expect(H.deleteObjectCalls).toEqual([RAW_MP4_KEY]);

		// metadata patch flips isAudio while keeping existing fields (AI analysis).
		expect(H.patchVideoMetadata).toHaveBeenCalledTimes(1);
		const [, patchFn] = H.patchVideoMetadata.mock.calls[0] as [
			string,
			(m: Record<string, unknown>) => Record<string, unknown>,
		];
		expect(patchFn({ aiSummary: { overview: "kept" } })).toEqual({
			aiSummary: { overview: "kept" },
			isAudio: true,
		});

		expect(H.revalidatePath).toHaveBeenCalledWith(`/s/${VIDEO_ID}`);
	});

	it("5. SAFETY: verify failure after put means deleteObject is NEVER called", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		// Only the raw upload exists (result.mp4 absent) so extraction proceeds,
		// but the write to result.mp4 never actually lands (putSkipsWrite).
		H.existingObjects.set(RAW_MP4_KEY, 900_000);
		H.putSkipsWrite = true;
		H.extractAudioForDownload.mockResolvedValue(Buffer.alloc(500, 1));

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({ ok: false, reason: "verify_failed" });
		// The put was attempted...
		expect(H.putObjectCalls).toHaveLength(1);
		// ...but because verify never saw the object, nothing was ever deleted —
		// the raw upload (still the only real copy) survives.
		expect(H.deleteObjectCalls).toHaveLength(0);
		expect(H.patchVideoMetadata).not.toHaveBeenCalled();
	});

	it("6. extraction failure -> extract_failed, no put, no delete", async () => {
		H.getCurrentUser.mockResolvedValue({ id: OWNER_ID });
		H.existingObjects.set(RESULT_KEY, 1_000_000);
		H.extractAudioForDownload.mockRejectedValue(new Error("ffmpeg exploded"));

		const result = await replaceVideoWithAudio(VIDEO_ID);

		expect(result).toEqual({ ok: false, reason: "extract_failed" });
		expect(H.putObjectCalls).toHaveLength(0);
		expect(H.deleteObjectCalls).toHaveLength(0);
	});
});
