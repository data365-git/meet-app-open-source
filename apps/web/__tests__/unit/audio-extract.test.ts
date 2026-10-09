import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ffmpeg-static", () => ({
	default: "/usr/local/bin/ffmpeg",
}));

const mockUnlink = vi.fn(() => Promise.resolve(undefined));
const mockMkdtemp = vi.fn(async () => "/tmp/audio-chunks-test");
const mockReaddir = vi.fn(async () => ["audio-001.mp3", "audio-000.mp3"]);
const mockRm = vi.fn(async () => undefined);
vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (path: string) => path === "/usr/local/bin/ffmpeg",
		promises: {
			...actual.promises,
			mkdtemp: () => mockMkdtemp(),
			readdir: () => mockReaddir(),
			rm: () => mockRm(),
			unlink: () => mockUnlink(),
		},
	};
});

class MockChildProcess extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
}

let mockProcess: MockChildProcess;
let spawnArgs: { command: string; args: string[] }[] = [];
let spawnedProcesses: MockChildProcess[] = [];

vi.mock("node:child_process", () => ({
	spawn: (command: string, args: string[]) => {
		spawnArgs.push({ command, args });
		mockProcess = new MockChildProcess();
		spawnedProcesses.push(mockProcess);
		return mockProcess;
	},
}));

describe("audio-extract", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		spawnArgs = [];
		spawnedProcesses = [];
	});

	afterEach(() => {
		vi.resetModules();
	});

	describe("checkHasAudioTrack", () => {
		it("returns true when video has audio stream", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			setTimeout(() => {
				mockProcess.stderr.emit(
					"data",
					Buffer.from(
						"Stream #0:0: Video: h264\n  Stream #0:1: Audio: aac, 44100 Hz",
					),
				);
				mockProcess.emit("close", 1);
			}, 10);

			const result = await resultPromise;
			// updated: checkHasAudioTrack now returns VideoProbeResult object, not bare boolean
			expect(result.hasAudio).toBe(true);
		});

		it("returns false when video has no audio stream", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			setTimeout(() => {
				mockProcess.stderr.emit(
					"data",
					Buffer.from("Stream #0:0: Video: h264, 1920x1080"),
				);
				mockProcess.emit("close", 1);
			}, 10);

			const result = await resultPromise;
			// updated: checkHasAudioTrack now returns VideoProbeResult object, not bare boolean
			expect(result.hasAudio).toBe(false);
		});

		it("returns false when ffmpeg errors", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			setTimeout(() => {
				mockProcess.emit("error", new Error("spawn failed"));
			}, 10);

			await expect(resultPromise).rejects.toThrow(
				"ffmpeg process error: spawn failed",
			);
		});

		it("uses correct ffmpeg arguments", async () => {
			const { checkHasAudioTrack } = await import("@/lib/audio-extract");

			const resultPromise = checkHasAudioTrack("https://example.com/video.mp4");

			setTimeout(() => {
				mockProcess.stderr.emit("data", Buffer.from(""));
				mockProcess.emit("close", 1);
			}, 10);

			await expect(resultPromise).rejects.toThrow(
				"ffmpeg could not read video file: no streams detected",
			);

			const args = spawnArgs[0]?.args ?? [];
			expect(args).toContain("-i");
			expect(args).toContain("-hide_banner");
			expect(args).toContain("https://example.com/video.mp4");
		});
	});

	describe("extractAudioFromUrl", () => {
		it("uses correct ffmpeg arguments", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.emit("close", 0);
			}, 10);

			await resultPromise;

			const args = spawnArgs[0]?.args ?? [];
			expect(args).toContain("-i");
			expect(args).toContain("https://example.com/video.mp4");
			expect(args).toContain("-vn");
			expect(args).toContain("-acodec");
			expect(args).toContain("libmp3lame");
			expect(args).toContain("-b:a");
			expect(args).toContain("64k");
		});

		it("returns audio/mpeg mime type", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.emit("close", 0);
			}, 10);

			const result = await resultPromise;
			expect(result.mimeType).toBe("audio/mpeg");
		});

		it("generates .mp3 file in temp directory", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.emit("close", 0);
			}, 10);

			const result = await resultPromise;
			expect(result.filePath).toContain("audio-");
			expect(result.filePath).toContain(".mp3");
		});

		it("provides cleanup function", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.emit("close", 0);
			}, 10);

			const result = await resultPromise;
			expect(typeof result.cleanup).toBe("function");
			await result.cleanup();
			expect(mockUnlink).toHaveBeenCalled();
		});

		it("rejects on ffmpeg error", async () => {
			const { extractAudioFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioFromUrl(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.stderr.emit("data", Buffer.from("Conversion failed"));
				mockProcess.emit("close", 1);
			}, 10);

			await expect(resultPromise).rejects.toThrow("Audio extraction failed");
		});
	});

	describe("extractAudioChunksFromUrl", () => {
		it("runs a silencedetect pass then extracts each chunk as a fast-seek span, falling back to fixed spacing when no silence is found", async () => {
			const { extractAudioChunksFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioChunksFromUrl(
				"https://example.com/video.mp4",
				{ chunkDurationSec: 900, totalDurationSec: 1900 },
			);

			// 1st spawn: silencedetect pass — no silence markers, closes cleanly.
			await vi.waitFor(() => expect(spawnedProcesses.length).toBe(1));
			spawnedProcesses[0]?.emit("close", 0);

			// 2nd spawn: fast-seek extraction of the first (fixed-fallback) span.
			await vi.waitFor(() => expect(spawnedProcesses.length).toBe(2));
			spawnedProcesses[1]?.emit("close", 0);

			// 3rd spawn: fast-seek extraction of the second span.
			await vi.waitFor(() => expect(spawnedProcesses.length).toBe(3));
			spawnedProcesses[2]?.emit("close", 0);

			const result = await resultPromise;

			expect(spawnArgs[0]?.args).toContain("silencedetect=noise=-30dB:d=0.35");
			expect(spawnArgs[1]?.args).toEqual(
				expect.arrayContaining(["-ss", "0", "-t", "900"]),
			);
			expect(spawnArgs[2]?.args).toEqual(
				expect.arrayContaining(["-ss", "900", "-t", "1000"]),
			);
			expect(result.chunks).toEqual([
				{
					filePath: expect.stringContaining("audio-000.mp3"),
					startSec: 0,
					durationSec: 900,
				},
				{
					filePath: expect.stringContaining("audio-001.mp3"),
					startSec: 900,
					durationSec: 1000,
				},
			]);
			await result.cleanup();
			expect(mockRm).toHaveBeenCalled();
		});

		it("falls back to the old fixed-interval segment approach when the silencedetect pass errors", async () => {
			const { extractAudioChunksFromUrl } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioChunksFromUrl(
				"https://example.com/video.mp4",
				{ chunkDurationSec: 900, totalDurationSec: 1900 },
			);

			// 1st spawn: silencedetect pass — errors, triggering the segment fallback.
			await vi.waitFor(() => expect(spawnedProcesses.length).toBe(1));
			spawnedProcesses[0]?.emit("error", new Error("silencedetect unsupported"));

			// 2nd spawn: old fixed-interval `-f segment` extraction.
			await vi.waitFor(() => expect(spawnedProcesses.length).toBe(2));
			spawnedProcesses[1]?.emit("close", 0);

			const result = await resultPromise;

			const segmentArgs = spawnArgs[1]?.args ?? [];
			expect(segmentArgs).toContain("-f");
			expect(segmentArgs).toContain("segment");
			expect(segmentArgs).toContain("-segment_time");
			expect(segmentArgs).toContain("900");
			expect(segmentArgs).toContain("-reset_timestamps");
			expect(result.chunks).toEqual([
				{
					filePath: expect.stringContaining("audio-000.mp3"),
					startSec: 0,
					durationSec: 900,
				},
				{
					filePath: expect.stringContaining("audio-001.mp3"),
					startSec: 900,
					durationSec: 900,
				},
			]);
			await result.cleanup();
			expect(mockRm).toHaveBeenCalled();
		});
	});

	describe("extractAudioToBuffer", () => {
		it("uses pipe output for streaming", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioToBuffer(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.stdout.emit("data", Buffer.from("audio-data"));
				mockProcess.emit("close", 0);
			}, 10);

			await resultPromise;

			const args = spawnArgs[0]?.args ?? [];
			// The output target takes NO leading dash. This assertion used to
			// read "-pipe:1", which locked the production bug in place: ffmpeg 8
			// rejected it ("Unrecognized option 'pipe:1'", exit 8) and
			// replace-with-audio failed for every video while this test stayed
			// green. The negative assertion is what stops the typo returning.
			expect(args).toContain("pipe:1");
			expect(args).not.toContain("-pipe:1");
		});

		it("returns Buffer instance", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioToBuffer(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.stdout.emit("data", Buffer.from("test-audio"));
				mockProcess.emit("close", 0);
			}, 10);

			const result = await resultPromise;
			expect(Buffer.isBuffer(result)).toBe(true);
		});

		it("concatenates multiple chunks", async () => {
			const { extractAudioToBuffer } = await import("@/lib/audio-extract");

			const resultPromise = extractAudioToBuffer(
				"https://example.com/video.mp4",
			);

			setTimeout(() => {
				mockProcess.stdout.emit("data", Buffer.from("chunk1"));
				mockProcess.stdout.emit("data", Buffer.from("chunk2"));
				mockProcess.emit("close", 0);
			}, 10);

			const result = await resultPromise;
			expect(result.toString()).toBe("chunk1chunk2");
		});
	});

	// convertWavToMp3 is a copy-paste twin of extractAudioToBuffer and carried
	// the SAME "-pipe:1" typo, which nothing covered. Pinned here so the twin
	// cannot drift back on its own.
	describe("convertWavToMp3", () => {
		it("writes to the pipe output target, with no leading dash", async () => {
			const { convertWavToMp3 } = await import("@/lib/audio-extract");

			const resultPromise = convertWavToMp3(Buffer.from("wav-bytes"));

			setTimeout(() => {
				mockProcess.stdout.emit("data", Buffer.from("mp3-data"));
				mockProcess.emit("close", 0);
			}, 10);

			await resultPromise;

			const args = spawnArgs[0]?.args ?? [];
			expect(args).toContain("pipe:1");
			expect(args).not.toContain("-pipe:1");
		});
	});
});
