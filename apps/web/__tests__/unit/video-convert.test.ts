import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("ffmpeg-static", () => ({
	default: "/usr/local/bin/ffmpeg",
}));

const mockReadFile = vi.fn(async (_path: string) => Buffer.from("video-data"));
const mockMkdtemp = vi.fn(async (_prefix: string) => "/tmp/cap-video-test");
const mockWriteFile = vi.fn(
	async (_path: string, _content: string) => undefined,
);
const mockRm = vi.fn(async (_path: string) => undefined);

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (path: string) => path === "/usr/local/bin/ffmpeg",
		promises: {
			...actual.promises,
			mkdtemp: (prefix: string) => mockMkdtemp(prefix),
			readFile: (path: string) => mockReadFile(path),
			rm: (path: string) => mockRm(path),
			writeFile: (path: string, content: string) =>
				mockWriteFile(path, content),
		},
	};
});

class MockChildProcess extends EventEmitter {
	stderr = new EventEmitter();
	killed = false;
	kill(_signal?: string) {
		this.killed = true;
	}
}

let spawnedProcesses: MockChildProcess[] = [];
let spawnArgs: { command: string; args: string[] }[] = [];

vi.mock("node:child_process", () => ({
	spawn: (command: string, args: string[]) => {
		const proc = new MockChildProcess();
		spawnedProcesses.push(proc);
		spawnArgs.push({ command, args });
		return proc;
	},
}));

describe("video-convert", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		spawnedProcesses = [];
		spawnArgs = [];
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = input.toString();

				if (url.includes("video.m3u8")) {
					return {
						ok: true,
						text: async () =>
							'#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1500000,AUDIO="audio"\nmedia-video.m3u8\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="audio",DEFAULT="YES",URI="media-audio.m3u8"',
					} as Response;
				}

				if (url.includes("media-video.m3u8")) {
					return {
						ok: true,
						text: async () => "#EXTM3U\n#EXTINF:1,\nsegment-video.ts",
					} as Response;
				}

				if (url.includes("media-audio.m3u8")) {
					return {
						ok: true,
						text: async () => "#EXTM3U\n#EXTINF:1,\nsegment-audio.aac",
					} as Response;
				}

				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.resetModules();
	});

	it("uses stream copy before transcoding", async () => {
		const { convertRemoteVideoToMp4Buffer } = await import(
			"@/lib/video-convert"
		);

		const resultPromise = convertRemoteVideoToMp4Buffer(
			"https://example.com/video.m3u8",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.emit("close", 0);
		}, 10);

		const result = await resultPromise;

		expect(result.toString()).toBe("video-data");
		expect(spawnArgs).toHaveLength(1);
		expect(spawnArgs[0]?.args).toContain("-c");
		expect(spawnArgs[0]?.args).toContain("copy");
		expect(mockWriteFile).toHaveBeenCalled();
	});

	it("falls back to transcoding when stream copy fails", async () => {
		const { convertRemoteVideoToMp4Buffer } = await import(
			"@/lib/video-convert"
		);

		const resultPromise = convertRemoteVideoToMp4Buffer(
			"https://example.com/video.m3u8",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from("copy failed"));
			spawnedProcesses[0]?.emit("close", 1);
			setTimeout(() => {
				spawnedProcesses[1]?.emit("close", 0);
			}, 10);
		}, 10);

		await resultPromise;

		expect(spawnArgs).toHaveLength(2);
		expect(spawnArgs[1]?.args).toContain("libx264");
		expect(spawnArgs[1]?.args).toContain("-crf");
		expect(spawnArgs[1]?.args).toContain("26");
		expect(spawnArgs[1]?.args).toContain("aac");
	});

	it("parses ffmpeg probe output and keeps already-small videos as copy", async () => {
		const { chooseVideoOptimizationStrategy, parseVideoProbeMetadata } =
			await import("@/lib/video-convert");

		const metadata = parseVideoProbeMetadata(`
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:42:03.45, start: 0.000000, bitrate: 1420 kb/s
  Stream #0:0: Video: h264 (High), yuv420p, 1280x720, 30 fps
  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo
`);

		expect(metadata).toMatchObject({
			durationSec: 2523.45,
			width: 1280,
			height: 720,
			videoCodec: "h264",
			audioCodec: "aac",
			bitrateBps: 1420000,
		});
		expect(chooseVideoOptimizationStrategy(metadata)).toBe("copy");
	});

	it("compresses videos with very high bitrate or resolution", async () => {
		const { chooseVideoOptimizationStrategy } = await import(
			"@/lib/video-convert"
		);

		// Larger than 1080p — downscaled by the compress pass.
		expect(
			chooseVideoOptimizationStrategy({
				durationSec: 300,
				width: 2560,
				height: 1440,
				videoCodec: "h264",
				audioCodec: "aac",
				bitrateBps: 1800000,
			}),
		).toBe("compress");

		// Exactly 1080p at a modest bitrate is kept as-is (no quality-destroying
		// re-encode) now that 1080p is the quality floor we ship.
		expect(
			chooseVideoOptimizationStrategy({
				durationSec: 300,
				width: 1920,
				height: 1080,
				videoCodec: "h264",
				audioCodec: "aac",
				bitrateBps: 1800000,
			}),
		).toBe("copy");

		expect(
			chooseVideoOptimizationStrategy({
				durationSec: 300,
				width: 1280,
				height: 720,
				videoCodec: "h264",
				audioCodec: "aac",
				bitrateBps: 4500000,
			}),
		).toBe("compress");
	});

	it("does not copy codecs that are risky in browser MP4 playback", async () => {
		const { chooseVideoOptimizationStrategy } = await import(
			"@/lib/video-convert"
		);

		expect(
			chooseVideoOptimizationStrategy({
				durationSec: 300,
				width: 1280,
				height: 720,
				videoCodec: "vp9",
				audioCodec: "opus",
				bitrateBps: 1200000,
			}),
		).toBe("compress");

		expect(
			chooseVideoOptimizationStrategy({
				durationSec: 300,
				width: 1280,
				height: 720,
				videoCodec: "hevc",
				audioCodec: "aac",
				bitrateBps: 1200000,
			}),
		).toBe("compress");

		expect(
			chooseVideoOptimizationStrategy({
				durationSec: 300,
				width: 1280,
				height: 720,
				videoCodec: "h264",
				audioCodec: null,
				bitrateBps: 1200000,
			}),
		).toBe("copy");
	});

	it("pins the compress-pass encoder args to the shipped 1080p quality floor", async () => {
		const { optimizeRemoteVideoToMp4 } = await import("@/lib/video-convert");

		// 4K/high-bitrate source → "compress" strategy → the single compress encode.
		const metadataStderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:02:00.00, start: 0.000000, bitrate: 9000 kb/s
  Stream #0:0: Video: h264 (High), yuv420p, 3840x2160, 30 fps
  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo
`;

		const resultPromise = optimizeRemoteVideoToMp4(
			"https://example.com/video.mp4",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from(metadataStderr));
			spawnedProcesses[0]?.emit("close", 0);
			setTimeout(() => {
				spawnedProcesses[1]?.emit("close", 0);
			}, 10);
		}, 5);

		await resultPromise;

		expect(spawnArgs).toHaveLength(2);
		const args = spawnArgs[1]?.args ?? [];

		// Video: h264 at CRF 21, capped at a 1920 long edge (1080p floor, no 720p
		// downscale), even-dimension safe via -2.
		expect(args[args.indexOf("-c:v") + 1]).toBe("libx264");
		expect(args[args.indexOf("-crf") + 1]).toBe("21");
		expect(args[args.indexOf("-vf") + 1]).toBe(
			"scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
		);
		expect(args[args.indexOf("-pix_fmt") + 1]).toBe("yuv420p");

		// Audio: AAC 128k at 48 kHz — no 96k / resample downgrade.
		expect(args[args.indexOf("-c:a") + 1]).toBe("aac");
		expect(args[args.indexOf("-b:a") + 1]).toBe("128k");
		expect(args[args.indexOf("-ar") + 1]).toBe("48000");

		// Still streamable.
		expect(args[args.indexOf("-movflags") + 1]).toBe("+faststart");

		// The old degraded values must not reappear.
		expect(args).not.toContain("28");
		expect(args).not.toContain("96k");
		expect(args.join(" ")).not.toContain("min(1280");
	});

	it("applies a custom timeoutMs override to the copy encode step and its compress fallback", async () => {
		const { optimizeRemoteVideoToMp4 } = await import("@/lib/video-convert");

		const metadataStderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:01:00.00, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0: Video: h264 (High), yuv420p, 640x360, 30 fps
  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo
`;

		const resultPromise = optimizeRemoteVideoToMp4(
			"https://example.com/video.mp4",
			{ timeoutMs: 20 },
		);

		// Probe step (process[0]) resolves immediately with metadata that selects
		// "copy" (h264/aac, small, low bitrate).
		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from(metadataStderr));
			spawnedProcesses[0]?.emit("close", 0);
		}, 5);

		await expect(resultPromise).rejects.toThrow("Video conversion timed out");

		// process[1] = copy attempt, process[2] = its compress fallback — both hang
		// and get killed by the 20ms override instead of the multi-minute default.
		expect(spawnedProcesses).toHaveLength(3);
		expect(spawnedProcesses[1]?.killed).toBe(true);
		expect(spawnedProcesses[2]?.killed).toBe(true);
	});

	it("applies a custom timeoutMs override to the compress encode step", async () => {
		const { optimizeRemoteVideoToMp4 } = await import("@/lib/video-convert");

		const metadataStderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:01:00.00, start: 0.000000, bitrate: 5000 kb/s
  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 30 fps
  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo
`;

		const resultPromise = optimizeRemoteVideoToMp4(
			"https://example.com/video.mp4",
			{ timeoutMs: 20 },
		);

		// High bitrate selects "compress" — a single encode attempt, no fallback.
		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from(metadataStderr));
			spawnedProcesses[0]?.emit("close", 0);
		}, 5);

		await expect(resultPromise).rejects.toThrow("Video conversion timed out");
		expect(spawnedProcesses).toHaveLength(2);
		expect(spawnedProcesses[1]?.killed).toBe(true);
	});
});
