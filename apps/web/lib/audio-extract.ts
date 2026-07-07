import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import ffmpegStaticPath from "ffmpeg-static";

let cachedFfmpegPath: string | null = null;

function getPathCandidates(): string[] {
	const binaryNames =
		process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"];

	return (process.env.PATH ?? "")
		.split(delimiter)
		.filter(Boolean)
		.flatMap((segment) => binaryNames.map((binary) => join(segment, binary)));
}

export function getFfmpegPath(): string {
	if (cachedFfmpegPath) {
		return cachedFfmpegPath;
	}

	const candidatePaths = [
		ffmpegStaticPath,
		resolve(process.cwd(), "node_modules/ffmpeg-static/ffmpeg"),
		resolve(
			process.cwd(),
			"node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg",
		),
		"/var/task/node_modules/ffmpeg-static/ffmpeg",
		"/var/task/node_modules/.pnpm/ffmpeg-static@5.3.0/node_modules/ffmpeg-static/ffmpeg",
		process.env.FFMPEG_PATH,
		"/opt/homebrew/bin/ffmpeg",
		"/usr/local/bin/ffmpeg",
		"/usr/bin/ffmpeg",
		...getPathCandidates(),
	].filter(Boolean) as string[];

	for (const path of candidatePaths) {
		if (existsSync(path)) {
			cachedFfmpegPath = path;
			return path;
		}
	}

	throw new Error(
		`FFmpeg binary not found. Tried paths: ${candidatePaths.join(", ")}`,
	);
}

export interface AudioExtractionResult {
	filePath: string;
	mimeType: string;
	cleanup: () => Promise<void>;
}

export interface AudioChunkExtractionResult {
	chunks: Array<{
		filePath: string;
		startSec: number;
		durationSec: number | null;
	}>;
	mimeType: string;
	cleanup: () => Promise<void>;
}

const DEFAULT_AUDIO_BITRATE = "64k";

export async function extractAudioFromUrl(
	videoUrl: string,
): Promise<AudioExtractionResult> {
	const ffmpeg = getFfmpegPath();
	const outputPath = join(tmpdir(), `audio-${randomUUID()}.mp3`);

	const ffmpegArgs = [
		"-i",
		videoUrl,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"24000",
		"-acodec",
		"libmp3lame",
		"-b:a",
		DEFAULT_AUDIO_BITRATE,
		"-f",
		"mp3",
		"-y",
		outputPath,
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			fs.unlink(outputPath).catch(() => {});
			reject(new Error(`Audio extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve({
					filePath: outputPath,
					mimeType: "audio/mpeg",
					cleanup: async () => {
						try {
							await fs.unlink(outputPath);
						} catch {}
					},
				});
			} else {
				fs.unlink(outputPath).catch(() => {});
				reject(
					new Error(`Audio extraction failed with code ${code}: ${stderr}`),
				);
			}
		});
	});
}

export interface SilenceInterval {
	start: number;
	end: number;
}

export interface ChunkSpec {
	startSec: number;
	durationSec: number;
}

function round3(value: number): number {
	return Math.round(value * 1000) / 1000;
}

/**
 * Turns detected silence intervals into chunk boundaries that land on speech
 * onsets (a silence's `end`) instead of a fixed nominal offset. Gemini ignores
 * leading silence within a chunk when estimating timestamps, so a chunk that
 * starts mid-silence makes the transcript run ahead of the audio — anchoring
 * cuts to real speech onsets keeps `startSec` truthful.
 *
 * Pure/no I/O. Falls back to fixed `targetChunkSec` boundaries (same shape as
 * the old nominal `index * targetChunkSec` behavior) when there's no useful
 * silence data near a boundary.
 */
export function computeSilenceAnchoredCuts(
	silences: SilenceInterval[],
	totalDurationSec: number,
	targetChunkSec: number,
): ChunkSpec[] {
	const sorted = silences
		.filter((s) => s.end > s.start)
		.sort((a, b) => a.start - b.start);

	const WINDOW = targetChunkSec * 0.4;
	const MIN_CHUNK = 60;

	const first = sorted[0];
	const firstOnset = first && first.start <= 1.0 ? first.end : 0;

	const boundaries: number[] = [firstOnset];
	let pos = firstOnset;

	while (totalDurationSec - pos > targetChunkSec + WINDOW) {
		const target = pos + targetChunkSec;

		let candidate: SilenceInterval | null = null;
		let candidateDist = Infinity;
		for (const s of sorted) {
			if (s.end < target - WINDOW || s.end > target + WINDOW) continue;
			const dist = Math.abs(s.end - target);
			if (dist < candidateDist) {
				candidateDist = dist;
				candidate = s;
			}
		}

		let cutAt = candidate ? candidate.end : target;
		if (cutAt - pos < MIN_CHUNK) {
			cutAt = pos + targetChunkSec;
		}

		boundaries.push(cutAt);
		pos = cutAt;
	}

	return boundaries.map((start, i) => {
		const next = boundaries[i + 1];
		const end = next !== undefined ? next : totalDurationSec;
		return { startSec: round3(start), durationSec: round3(end - start) };
	});
}

function parseSilenceIntervals(
	stderr: string,
	totalDurationSec: number,
): SilenceInterval[] {
	const starts = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map(
		(m) => Number(m[1]),
	);
	const ends = [...stderr.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map(
		(m) => Number(m[1]),
	);

	return starts.map((start, i) => ({
		start,
		end: ends[i] ?? totalDurationSec,
	}));
}

function runFfmpegCapture(
	ffmpeg: string,
	args: string[],
): Promise<{ code: number | null; stderr: string }> {
	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, args, { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			reject(err);
		});

		proc.on("close", (code: number | null) => {
			resolve({ code, stderr });
		});
	});
}

function extractSpanToFile(
	ffmpeg: string,
	videoUrl: string,
	startSec: number,
	durationSec: number,
	outputPath: string,
): Promise<void> {
	const ffmpegArgs = [
		"-ss",
		String(Math.max(0, startSec)),
		"-t",
		String(durationSec),
		"-i",
		videoUrl,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"24000",
		"-acodec",
		"libmp3lame",
		"-b:a",
		DEFAULT_AUDIO_BITRATE,
		"-f",
		"mp3",
		"-y",
		outputPath,
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });
		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			reject(new Error(`Audio chunk extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(
				new Error(`Audio chunk extraction failed with code ${code}: ${stderr}`),
			);
		});
	});
}

/** Old fixed-interval implementation, preserved as the fallback used when the
 * silencedetect pass fails/errors or the total duration can't be determined. */
async function extractFixedIntervalChunks(
	ffmpeg: string,
	videoUrl: string,
	chunkDurationSec: number,
	totalDurationSec: number | null,
): Promise<AudioChunkExtractionResult> {
	const dirPath = await fs.mkdtemp(join(tmpdir(), "audio-chunks-"));
	const outputPattern = join(dirPath, "audio-%03d.mp3");

	const ffmpegArgs = [
		"-i",
		videoUrl,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"24000",
		"-acodec",
		"libmp3lame",
		"-b:a",
		DEFAULT_AUDIO_BITRATE,
		"-f",
		"segment",
		"-segment_time",
		String(chunkDurationSec),
		"-reset_timestamps",
		"1",
		"-y",
		outputPattern,
	];

	try {
		await new Promise<void>((resolve, reject) => {
			const proc = spawn(ffmpeg, ffmpegArgs, {
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stderr = "";

			proc.stderr?.on("data", (data: Buffer) => {
				stderr += data.toString();
			});

			proc.on("error", (err: Error) => {
				reject(new Error(`Audio chunk extraction failed: ${err.message}`));
			});

			proc.on("close", (code: number | null) => {
				if (code === 0) {
					resolve();
					return;
				}
				reject(
					new Error(
						`Audio chunk extraction failed with code ${code}: ${stderr}`,
					),
				);
			});
		});

		const files = (await fs.readdir(dirPath))
			.filter((file) => /^audio-\d+\.mp3$/.test(file))
			.sort();

		if (files.length === 0) {
			throw new Error("Audio chunk extraction produced no files");
		}

		return {
			chunks: files.map((file, index) => {
				const startSec = index * chunkDurationSec;
				const remaining =
					totalDurationSec == null ? null : Math.max(0, totalDurationSec - startSec);
				return {
					filePath: join(dirPath, file),
					startSec,
					durationSec:
						remaining == null ? null : Math.min(chunkDurationSec, remaining),
				};
			}),
			mimeType: "audio/mpeg",
			cleanup: async () => {
				try {
					await fs.rm(dirPath, { force: true, recursive: true });
				} catch {}
			},
		};
	} catch (error) {
		await fs.rm(dirPath, { force: true, recursive: true }).catch(() => {});
		throw error;
	}
}

export async function extractAudioChunksFromUrl(
	videoUrl: string,
	{
		chunkDurationSec,
		totalDurationSec,
	}: {
		chunkDurationSec: number;
		totalDurationSec: number | null;
	},
): Promise<AudioChunkExtractionResult> {
	const ffmpeg = getFfmpegPath();

	let silenceResult: { code: number | null; stderr: string } | null = null;
	try {
		silenceResult = await runFfmpegCapture(ffmpeg, [
			"-i",
			videoUrl,
			"-vn",
			"-af",
			"silencedetect=noise=-30dB:d=0.35",
			"-f",
			"null",
			"-",
		]);
	} catch {
		// silencedetect pass itself failed to spawn — fall back below.
	}

	const resolvedDuration =
		totalDurationSec ??
		(silenceResult ? parseDurationFromStderr(silenceResult.stderr) : null);

	if (!silenceResult || silenceResult.code !== 0 || resolvedDuration == null) {
		return extractFixedIntervalChunks(
			ffmpeg,
			videoUrl,
			chunkDurationSec,
			totalDurationSec,
		);
	}

	const silences = parseSilenceIntervals(silenceResult.stderr, resolvedDuration);
	const specs = computeSilenceAnchoredCuts(
		silences,
		resolvedDuration,
		chunkDurationSec,
	);

	const dirPath = await fs.mkdtemp(join(tmpdir(), "audio-chunks-"));

	try {
		const chunks: AudioChunkExtractionResult["chunks"] = [];
		for (const [index, spec] of specs.entries()) {
			const filePath = join(
				dirPath,
				`audio-${String(index).padStart(3, "0")}.mp3`,
			);
			await extractSpanToFile(
				ffmpeg,
				videoUrl,
				spec.startSec,
				spec.durationSec,
				filePath,
			);
			chunks.push({
				filePath,
				startSec: spec.startSec,
				durationSec: spec.durationSec,
			});
		}

		return {
			chunks,
			mimeType: "audio/mpeg",
			cleanup: async () => {
				try {
					await fs.rm(dirPath, { force: true, recursive: true });
				} catch {}
			},
		};
	} catch (error) {
		await fs.rm(dirPath, { force: true, recursive: true }).catch(() => {});
		throw error;
	}
}

/**
 * Extract ONE audio span [startSec, startSec+durationSec) from a video URL as
 * mono mp3 — used by the transcript gap-fill pass to re-transcribe just the
 * missing stretch. `-ss` before `-i` = fast keyframe seek; the ± keyframe
 * imprecision is irrelevant for ASR.
 */
export async function extractAudioSpanFromUrl(
	videoUrl: string,
	startSec: number,
	durationSec: number,
): Promise<AudioExtractionResult> {
	const ffmpeg = getFfmpegPath();
	const outputPath = join(tmpdir(), `audio-span-${randomUUID()}.mp3`);

	const ffmpegArgs = [
		"-ss",
		String(Math.max(0, startSec)),
		"-t",
		String(durationSec),
		"-i",
		videoUrl,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"24000",
		"-acodec",
		"libmp3lame",
		"-b:a",
		DEFAULT_AUDIO_BITRATE,
		"-f",
		"mp3",
		"-y",
		outputPath,
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			fs.unlink(outputPath).catch(() => {});
			reject(new Error(`Audio span extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve({
					filePath: outputPath,
					mimeType: "audio/mpeg",
					cleanup: async () => {
						try {
							await fs.unlink(outputPath);
						} catch {}
					},
				});
			} else {
				fs.unlink(outputPath).catch(() => {});
				reject(
					new Error(`Audio span extraction failed with code ${code}: ${stderr}`),
				);
			}
		});
	});
}

export async function extractAudioToBuffer(videoUrl: string): Promise<Buffer> {
	const ffmpeg = getFfmpegPath();
	const ffmpegArgs = [
		"-i",
		videoUrl,
		"-vn",
		"-ac",
		"1",
		"-ar",
		"24000",
		"-acodec",
		"libmp3lame",
		"-b:a",
		DEFAULT_AUDIO_BITRATE,
		"-f",
		"mp3",
		"-pipe:1",
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

		const chunks: Buffer[] = [];
		let stderr = "";

		proc.stdout?.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			reject(new Error(`Audio extraction failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(
					new Error(`Audio extraction failed with code ${code}: ${stderr}`),
				);
			}
		});
	});
}

export async function convertWavToMp3(wavBuffer: Buffer): Promise<Buffer> {
	const ffmpeg = getFfmpegPath();
	const ffmpegArgs = [
		"-i",
		"pipe:0",
		"-ac",
		"1",
		"-ar",
		"24000",
		"-acodec",
		"libmp3lame",
		"-b:a",
		"64k",
		"-f",
		"mp3",
		"-pipe:1",
	];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, { stdio: ["pipe", "pipe", "pipe"] });

		const chunks: Buffer[] = [];
		let stderr = "";

		proc.stdout?.on("data", (chunk: Buffer) => {
			chunks.push(chunk);
		});

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			reject(new Error(`WAV to MP3 conversion failed: ${err.message}`));
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				resolve(Buffer.concat(chunks));
			} else {
				reject(
					new Error(
						`WAV to MP3 conversion failed with code ${code}: ${stderr}`,
					),
				);
			}
		});

		proc.stdin?.write(wavBuffer);
		proc.stdin?.end();
	});
}

export interface VideoProbeResult {
	hasAudio: boolean;
	durationSec: number | null;
}

export function parseDurationFromStderr(stderr: string): number | null {
	const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
	if (!match) return null;
	const [, h, m, s, cs] = match;
	return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${cs}`);
}

export async function checkHasAudioTrack(
	videoUrl: string,
): Promise<VideoProbeResult> {
	let ffmpeg: string;
	try {
		ffmpeg = getFfmpegPath();
	} catch (err) {
		console.error(
			`[checkHasAudioTrack] ffmpeg binary not found, cannot check audio track:`,
			err,
		);
		throw new Error("ffmpeg binary not available — cannot check audio track");
	}
	const ffmpegArgs = ["-i", videoUrl, "-hide_banner"];

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, ffmpegArgs, {
			stdio: ["pipe", "pipe", "pipe"],
		});

		let stderr = "";

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err) => {
			console.error(`[checkHasAudioTrack] ffmpeg process error:`, err);
			reject(new Error(`ffmpeg process error: ${err.message}`));
		});

		proc.on("close", () => {
			const hasVideo = /Stream #\d+:\d+.*Video:/.test(stderr);
			const hasAudio = /Stream #\d+:\d+.*Audio:/.test(stderr);

			// Audio-only files are VALID input (audio import): an OGG/WAV has no
			// video stream at all, and mp3/m4a only "had" one via attached cover
			// art. Reject only when ffmpeg found no streams of either kind.
			if (!hasVideo && !hasAudio) {
				console.error(
					`[checkHasAudioTrack] No streams found — ffmpeg may not be able to read the file. stderr: ${stderr.substring(0, 500)}`,
				);
				reject(
					new Error(`ffmpeg could not read video file: no streams detected`),
				);
				return;
			}

			const durationSec = parseDurationFromStderr(stderr);

			console.log(
				`[checkHasAudioTrack] Result: hasVideo=${hasVideo}, hasAudio=${hasAudio}, durationSec=${durationSec}`,
			);
			resolve({ hasAudio, durationSec });
		});
	});
}
