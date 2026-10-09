import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
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
const mockWriteStreamBytes: number[] = [];

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		existsSync: (path: string) => path === "/usr/local/bin/ffmpeg",
		// The download-first path streams the remote input to a temp file via
		// createWriteStream — a no-op sink keeps the pipeline testable.
		createWriteStream: () =>
			new Writable({
				write(_chunk, _encoding, callback) {
					mockWriteStreamBytes.push(_chunk.length);
					callback();
				},
			}),
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
		mockWriteStreamBytes.length = 0;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = input.toString();

				// Download-first: a plain http(s) input is fetched to a temp file
				// before any ffmpeg run. Serve the declared byte count exactly so
				// the Content-Length verification passes.
				if (/\.(mp4|webm)(\?|$)/i.test(url)) {
					const body = Buffer.from("downloaded-input-bytes");
					return new Response(new Blob([body]).stream(), {
						status: 200,
						headers: { "content-length": String(body.length) },
					});
				}

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
				setTimeout(() => {
					// Output-duration guard probe — no Duration line means unknown,
					// which passes the guard.
					spawnedProcesses[2]?.emit("close", 0);
				}, 10);
			}, 10);
		}, 5);

		await resultPromise;

		expect(spawnArgs).toHaveLength(3);
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

	it("a copy timeout does not fall through to compress (test 1)", async () => {
		const { optimizeRemoteVideoToMp4, FfmpegTimeoutError } = await import(
			"@/lib/video-convert"
		);

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

		await expect(resultPromise).rejects.toThrow(FfmpegTimeoutError);

		// process[1] = copy attempt, which hangs and gets killed by the 20ms
		// override — a SECOND runFfmpeg call for compress must NEVER happen.
		expect(spawnedProcesses).toHaveLength(2);
		expect(spawnedProcesses[1]?.killed).toBe(true);
	});

	it("a genuine (non-timeout) copy failure still falls through to compress (test 2)", async () => {
		const { optimizeRemoteVideoToMp4 } = await import("@/lib/video-convert");

		const metadataStderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:01:00.00, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0: Video: h264 (High), yuv420p, 640x360, 30 fps
  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo
`;

		const resultPromise = optimizeRemoteVideoToMp4(
			"https://example.com/video.mp4",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from(metadataStderr));
			spawnedProcesses[0]?.emit("close", 0);
			setTimeout(() => {
				// A real ffmpeg failure, not a timeout.
				spawnedProcesses[1]?.stderr.emit("data", Buffer.from("copy failed"));
				spawnedProcesses[1]?.emit("close", 1);
				setTimeout(() => {
					spawnedProcesses[2]?.emit("close", 0);
					setTimeout(() => {
						spawnedProcesses[3]?.emit("close", 0);
					}, 10);
				}, 10);
			}, 5);
		}, 5);

		await resultPromise;

		expect(spawnedProcesses).toHaveLength(4);
		expect(spawnArgs[2]?.args).toContain("libx264");
	});

	it("a copy failure on a LONG source must not buy an unbounded compress (test 7)", async () => {
		const { optimizeRemoteVideoToMp4 } = await import("@/lib/video-convert");

		// Two hours — past COMPRESS_MAX_DURATION_SEC (3600). Codec/bitrate still
		// select the "copy" strategy, so this reaches the copy-failure fallback,
		// which is the one path that had no duration gate and no outcome log.
		const metadataStderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 02:00:00.00, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0: Video: h264 (High), yuv420p, 640x360, 30 fps
  Stream #0:1: Audio: aac (LC), 48000 Hz, stereo
`;

		const resultPromise = optimizeRemoteVideoToMp4(
			"https://example.com/video.mp4",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from(metadataStderr));
			spawnedProcesses[0]?.emit("close", 0);
			setTimeout(() => {
				// A real ffmpeg failure, not a timeout.
				spawnedProcesses[1]?.stderr.emit("data", Buffer.from("copy failed"));
				spawnedProcesses[1]?.emit("close", 1);
			}, 5);
		}, 5);

		await expect(resultPromise).rejects.toThrow();

		// probe + copy only. A compress spawn here is the 45-minute hole.
		expect(spawnedProcesses).toHaveLength(2);
		expect(spawnArgs.some((s) => s?.args?.includes("libx264"))).toBe(false);
	});

	it("copyTimeoutMs scales with duration and clamps at both ends (test 3)", async () => {
		const { computeCopyTimeoutMs } = await import("@/lib/video-convert");

		// No/zero duration -> floor (DEFAULT_COPY_TIMEOUT_MS = 10 min).
		expect(computeCopyTimeoutMs(null)).toBe(10 * 60 * 1000);
		expect(computeCopyTimeoutMs(0)).toBe(10 * 60 * 1000);

		// Short duration -> scaled value is below the floor, clamps up to it.
		expect(computeCopyTimeoutMs(100)).toBe(10 * 60 * 1000);

		// Mid-range duration -> scales linearly (durationSec * 400ms), no clamp.
		expect(computeCopyTimeoutMs(3000)).toBe(3000 * 400);

		// Very long duration -> clamps down to the 45 min ceiling.
		expect(computeCopyTimeoutMs(10000)).toBe(45 * 60 * 1000);
	});

	it("skips compress for sources over the duration limit, keeps raw, logs one line (test 4)", async () => {
		const { optimizeRemoteVideoToMp4 } = await import("@/lib/video-convert");
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		// VP9/Opus webm -> "compress" strategy, but duration exceeds the 3600s
		// (60 min) limit, so compress must be skipped entirely.
		const metadataStderr = `
Input #0, matroska,webm, from 'video.webm':
  Duration: 01:10:00.00, start: 0.000000, bitrate: 1200 kb/s
  Stream #0:0: Video: vp9, yuv420p, 1280x720, 30 fps
  Stream #0:1: Audio: opus, 48000 Hz, stereo
`;

		const resultPromise = optimizeRemoteVideoToMp4(
			"https://example.com/video.webm",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from(metadataStderr));
			spawnedProcesses[0]?.emit("close", 0);
		}, 5);

		await expect(resultPromise).rejects.toThrow();

		// Only the probe ran — no compress (or copy) encode attempt at all.
		expect(spawnedProcesses).toHaveLength(1);

		const skipLines = logSpy.mock.calls.filter((call) =>
			String(call[0]).toLowerCase().includes("skip"),
		);
		expect(skipLines.length).toBe(1);

		logSpy.mockRestore();
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

	// 2026-10-09 prod incident (video z89zsr2jz1q4eym): ffmpeg read the R2
	// signed URL directly, a transient network drop ended the input at 151 s
	// with exit 0, and the 34:55 recording was published as a 151 s result.mp4.
	it("downloads a plain http(s) input to a local file before probing/encoding (download-first)", async () => {
		const { optimizeRemoteVideoToMp4 } = await import("@/lib/video-convert");

		const metadataStderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:01:00.00, start: 0.000000, bitrate: 1000 kb/s
  Stream #0:0, Video: h264 (High), yuv420p, 640x360, 30 fps
  Stream #0:1, Audio: aac (LC), 48000 Hz, stereo
`;

		const resultPromise = optimizeRemoteVideoToMp4(
			"https://example.com/video.mp4",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from(metadataStderr));
			spawnedProcesses[0]?.emit("close", 0);
			setTimeout(() => {
				spawnedProcesses[1]?.emit("close", 0);
				setTimeout(() => {
					spawnedProcesses[2]?.emit("close", 0);
				}, 10);
			}, 10);
		}, 5);

		const result = await resultPromise;
		await result.cleanup();

		// ffmpeg never saw the http URL: every "-i" argument is a local temp
		// file inside the job dir.
		for (const spawn of spawnArgs) {
			const args = spawn.args;
			const input = args[args.indexOf("-i") + 1];
			expect(input).toBeTruthy();
			const normalized = String(input).replaceAll("\\", "/");
			expect(normalized).not.toContain("http");
			expect(normalized).toContain("/tmp/cap-video-test");
		}
		// The download itself verified its Content-Length.
		expect(mockWriteStreamBytes.reduce((a, b) => a + b, 0)).toBe(
			"downloaded-input-bytes".length,
		);
	});

	it("a download failure (bad status) throws before any ffmpeg run", async () => {
		const { optimizeRemoteVideoToMp4 } = await import("@/lib/video-convert");

		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response(null, { status: 403 })),
		);

		await expect(
			optimizeRemoteVideoToMp4("https://example.com/video.mp4"),
		).rejects.toThrow(/download/i);

		expect(spawnedProcesses).toHaveLength(0);
	});

	it("throws TruncatedOutputError when the finished output is far shorter than the input (151 s of 2095.68 s)", async () => {
		const { optimizeRemoteVideoToMp4, TruncatedOutputError } = await import(
			"@/lib/video-convert"
		);
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

		// 34:55.68 = 2095.68 s — the real recording's length.
		const inputStderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:34:55.68, start: 0.000000, bitrate: 6000 kb/s
  Stream #0:0, Video: h264 (High), yuv420p, 1920x1080, 60 fps
  Stream #0:1, Audio: aac (LC), 48000 Hz, stereo
`;

		const resultPromise = optimizeRemoteVideoToMp4(
			"https://example.com/video.mp4",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from(inputStderr));
			spawnedProcesses[0]?.emit("close", 0);
			setTimeout(() => {
				// ffmpeg exits 0 — a dropped HTTP input is EOF, not an error.
				spawnedProcesses[1]?.emit("close", 0);
				setTimeout(() => {
					// The guard's probe of the OUTPUT file: 2:31.03 = 151.03 s.
					spawnedProcesses[2]?.stderr.emit(
						"data",
						Buffer.from("  Duration: 00:02:31.03, start: 0.000000"),
					);
					spawnedProcesses[2]?.emit("close", 0);
				}, 10);
			}, 10);
		}, 5);

		await expect(resultPromise).rejects.toBeInstanceOf(TruncatedOutputError);

		const truncatedLine = logSpy.mock.calls.find((call) =>
			String(call[0]).includes("optimize truncated"),
		);
		expect(String(truncatedLine?.[0])).toContain("in=2095.68");
		expect(String(truncatedLine?.[0])).toContain("out=151.03");

		logSpy.mockRestore();
	});

	it("accepts an output only marginally shorter than the input (2094 s of 2095.68 s)", async () => {
		const { optimizeRemoteVideoToMp4 } = await import("@/lib/video-convert");

		const inputStderr = `
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'video.mp4':
  Duration: 00:34:55.68, start: 0.000000, bitrate: 6000 kb/s
  Stream #0:0, Video: h264 (High), yuv420p, 1920x1080, 60 fps
  Stream #0:1, Audio: aac (LC), 48000 Hz, stereo
`;

		const resultPromise = optimizeRemoteVideoToMp4(
			"https://example.com/video.mp4",
		);

		setTimeout(() => {
			spawnedProcesses[0]?.stderr.emit("data", Buffer.from(inputStderr));
			spawnedProcesses[0]?.emit("close", 0);
			setTimeout(() => {
				spawnedProcesses[1]?.emit("close", 0);
				setTimeout(() => {
					spawnedProcesses[2]?.stderr.emit(
						"data",
						Buffer.from("  Duration: 00:34:54.00, start: 0.000000"),
					);
					spawnedProcesses[2]?.emit("close", 0);
				}, 10);
			}, 10);
		}, 5);

		const result = await resultPromise;
		await result.cleanup();
	});

	it("isDurationShortenedBeyondTolerance — max(2 s, 1 %) decision, null never counts", async () => {
		const { isDurationShortenedBeyondTolerance } = await import(
			"@/lib/video-convert"
		);

		expect(isDurationShortenedBeyondTolerance(2095.68, 151.03)).toBe(true);
		// Within the 1 % tolerance (~20.96 s of 2095.68 s).
		expect(isDurationShortenedBeyondTolerance(2095.68, 2094)).toBe(false);
		expect(isDurationShortenedBeyondTolerance(2095.68, 2075)).toBe(false);
		expect(isDurationShortenedBeyondTolerance(2095.68, 2074)).toBe(true);
		// The 2 s floor for short references (1 % of 10 s would be 0.1 s).
		expect(isDurationShortenedBeyondTolerance(10, 8.5)).toBe(false);
		expect(isDurationShortenedBeyondTolerance(10, 7.9)).toBe(true);
		// Unknown values never count as shortened.
		expect(isDurationShortenedBeyondTolerance(null, 100)).toBe(false);
		expect(isDurationShortenedBeyondTolerance(2095.68, null)).toBe(false);
		expect(isDurationShortenedBeyondTolerance(0, 100)).toBe(false);
	});
});
