import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import type { ReadableStream as NodeWebReadableStream } from "node:stream/web";
import { pipeline } from "node:stream/promises";
import { getFfmpegPath } from "@/lib/audio-extract";

export interface VideoConversionResult {
	filePath: string;
	mimeType: string;
	cleanup: () => Promise<void>;
	metadata?: VideoProbeMetadata;
}

// Probing only reads headers (ffmpeg -i with no output), so it stays short
// regardless of file size.
const PROBE_TIMEOUT_MS = 5 * 60 * 1000;
// "copy" is a remux (no re-encode) — fast even for a large file, but a slow
// R2 fetch of a multi-hundred-MB recording still needs more than 5 min.
const DEFAULT_COPY_TIMEOUT_MS = 10 * 60 * 1000;
// "compress" re-encodes the whole file frame-by-frame on a shared 4-core VPS;
// a 40+ min recording can take a large fraction of its own runtime to encode.
const DEFAULT_COMPRESS_TIMEOUT_MS = 45 * 60 * 1000;
// The copy remux's cost is dominated by pulling the source down, so its
// budget scales with the source's own length instead of a flat default.
const COPY_TIMEOUT_MS_PER_SEC = 400;
const COPY_TIMEOUT_MAX_MS = 45 * 60 * 1000;
// A source this long that ALSO needs a re-encode (VP9/Opus, >1080p/2.5Mbps)
// is not worth the ~45 min compress budget — the raw upload is proven safe
// to serve as-is (app/api/playlist/route.ts falls back to it when result.mp4
// is absent), so compress is skipped entirely instead of run as a 45-minute
// consolation prize.
const COMPRESS_MAX_DURATION_SEC = 3600;
const HIGH_BITRATE_BPS = 2_500_000;
// 1080p is the quality floor we ship, so a 1920-edge source is NOT "too big" —
// only something larger than 1080p is downscaled by the compress pass.
const HIGH_RESOLUTION_MAX_EDGE = 1920;
const MP4_SAFE_VIDEO_CODECS = new Set(["avc1", "h264"]);
const MP4_SAFE_AUDIO_CODECS = new Set(["aac"]);

export interface VideoConversionOptions {
	/**
	 * Overrides the ffmpeg timeout (ms) applied to the encode step. When
	 * absent, a strategy-appropriate default is used (copy is a fast remux;
	 * compress re-encodes the whole file and needs much longer) — see
	 * DEFAULT_COPY_TIMEOUT_MS / DEFAULT_COMPRESS_TIMEOUT_MS above.
	 */
	timeoutMs?: number;
	/**
	 * Fired as ffmpeg's own `time=HH:MM:SS.ms` progress tokens are parsed out
	 * of the stderr stream already being accumulated for error reporting — no
	 * second ffmpeg process, no `-progress pipe:1`. `percent` is clamped to
	 * 0..99 (100 is reserved for the caller once the file is actually
	 * written). Called with `null` — never a guessed number — when the
	 * source duration could not be probed.
	 */
	onProgress?: (percent: number | null) => void;
}

export interface VideoProbeMetadata {
	durationSec: number | null;
	width: number | null;
	height: number | null;
	videoCodec: string | null;
	audioCodec: string | null;
	bitrateBps: number | null;
}

export type VideoOptimizationStrategy = "copy" | "compress";

/**
 * Distinguishes "ffmpeg hit its time budget" from a genuine encode failure.
 * A timeout on the fast copy remux tells us nothing about whether the codec
 * needs a re-encode — it means the budget was too small for THIS source, so
 * it must be rethrown, never treated as a signal to fall through to the much
 * more expensive compress pass (see convertRemoteVideoToMp4FileInternal).
 */
export class FfmpegTimeoutError extends Error {
	constructor(message = "Video conversion timed out") {
		super(message);
		this.name = "FfmpegTimeoutError";
	}
}

/**
 * ffmpeg reading an HTTP source treats a dropped connection as input EOF and
 * exits 0 — prod 2026-10-09 (video z89zsr2jz1q4eym): a 34:55 recording was
 * "successfully" encoded into a 151 s result.mp4. Thrown by
 * optimizeRemoteVideoToMp4 when the finished output is shorter than the
 * probed input beyond tolerance, so the caller's existing catch keeps the
 * raw upload playable instead of publishing the truncated file.
 */
export class TruncatedOutputError extends Error {
	constructor(inputDurationSec: number, outputDurationSec: number) {
		super(
			`Truncated output: input ${inputDurationSec}s but output only ${outputDurationSec}s`,
		);
		this.name = "TruncatedOutputError";
	}
}

/** How much shorter than `referenceSec` a probed duration may be before the
 * difference is treated as truncation: max(2 s, 1 % of the reference). */
function durationShortenToleranceSec(referenceSec: number): number {
	return Math.max(2, referenceSec * 0.01);
}

/**
 * True when `candidateSec` is shorter than `referenceSec` by more than
 * max(2 s, 1 %) — the optimize output guard's "this output is shorter than
 * its input" decision (transcribe.ts uses its own looser check). Unknown
 * (null) or non-positive values never count as shortened.
 */
export function isDurationShortenedBeyondTolerance(
	referenceSec: number | null,
	candidateSec: number | null,
): boolean {
	if (referenceSec == null || candidateSec == null) return false;
	if (referenceSec <= 0) return false;
	return candidateSec < referenceSec - durationShortenToleranceSec(referenceSec);
}

/**
 * A copy remux is a fast passthrough, so its budget scales with the source's
 * own duration instead of one flat default — a 2-hour recording needs far
 * more than the 10-minute default to even pull the source down, while a
 * short clip should not wait the full default either way (floor keeps it,
 * ceiling caps a runaway duration read).
 */
export function computeCopyTimeoutMs(durationSec: number | null): number {
	const scaled = (durationSec ?? 0) * COPY_TIMEOUT_MS_PER_SEC;
	return Math.min(Math.max(scaled, DEFAULT_COPY_TIMEOUT_MS), COPY_TIMEOUT_MAX_MS);
}

interface RunFfmpegProgress {
	durationSec: number | null;
	onProgress: (percent: number | null) => void;
}

/**
 * Extracts the LATEST `time=HH:MM:SS.ms` token ffmpeg has printed to stderr
 * so far — ffmpeg re-prints a fresh progress line periodically, and the
 * accumulated buffer (already kept for error reporting) can contain several;
 * only the most recent one reflects current progress.
 */
function parseLatestOutTimeSeconds(stderr: string): number | null {
	const matches = [...stderr.matchAll(/time=(\d+):(\d+):(\d+)\.(\d+)/g)];
	const last = matches[matches.length - 1];
	if (!last) return null;
	const [, h, m, s, cs] = last;
	return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${cs}`);
}

/**
 * Pure so the RED test can drive it with simulated stderr chunks without
 * spawning a real ffmpeg process. Clamped to 0..99 — 100 is reserved for the
 * caller once the output file is actually written. `durationSec` unknown =>
 * `null`, never an invented percentage.
 */
export function computeFfmpegProgressPercent(
	accumulatedStderr: string,
	durationSec: number | null,
): number | null {
	const outTimeSec = parseLatestOutTimeSeconds(accumulatedStderr);
	if (outTimeSec == null) return null;
	if (durationSec == null || durationSec <= 0) return null;
	return Math.min(99, Math.max(0, (outTimeSec / durationSec) * 100));
}

function runFfmpeg(
	args: string[],
	timeoutMs: number = DEFAULT_COMPRESS_TIMEOUT_MS,
	progress?: RunFfmpegProgress,
): Promise<void> {
	const ffmpeg = getFfmpegPath();

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
		let settled = false;

		let stderr = "";
		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGKILL");
			reject(new FfmpegTimeoutError());
		}, timeoutMs);

		const finish = (callback: () => void) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			callback();
		};

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
			if (progress) {
				// Unknown duration still reports `null` on every tick that carries a
				// time= token, rather than staying silent — the caller (workflow)
				// decides what an unknown-duration UI looks like.
				const outTimeSec = parseLatestOutTimeSeconds(stderr);
				if (outTimeSec != null) {
					progress.onProgress(
						computeFfmpegProgressPercent(stderr, progress.durationSec),
					);
				}
			}
		});

		proc.on("error", (err: Error) => {
			finish(() =>
				reject(new Error(`Video conversion failed: ${err.message}`)),
			);
		});

		proc.on("close", (code: number | null) => {
			if (code === 0) {
				finish(resolve);
				return;
			}

			finish(() =>
				reject(
					new Error(`Video conversion failed with code ${code}: ${stderr}`),
				),
			);
		});
	});
}

function runFfmpegForStderr(args: string[]): Promise<string> {
	const ffmpeg = getFfmpegPath();

	return new Promise((resolve, reject) => {
		const proc = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"] });
		let settled = false;
		let stderr = "";

		const timeout = setTimeout(() => {
			if (settled) return;
			settled = true;
			proc.kill("SIGKILL");
			reject(new Error("Video probe timed out"));
		}, PROBE_TIMEOUT_MS);

		proc.stderr?.on("data", (data: Buffer) => {
			stderr += data.toString();
		});

		proc.on("error", (err: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(new Error(`Video probe failed: ${err.message}`));
		});

		proc.on("close", () => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolve(stderr);
		});
	});
}

function parseDurationSeconds(stderr: string): number | null {
	const match = stderr.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
	if (!match) return null;
	const [, h, m, s, cs] = match;
	return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(`0.${cs}`);
}

function parseBitrateBps(stderr: string): number | null {
	const match = stderr.match(/bitrate:\s*(\d+)\s*kb\/s/i);
	if (!match?.[1]) return null;
	return Number(match[1]) * 1000;
}

function parseVideoStream(stderr: string) {
	const match = stderr.match(
		/Stream #\d+:\d+.*Video:\s*([^,\s]+).*?(\d{2,5})x(\d{2,5})/i,
	);
	return {
		videoCodec: match?.[1] ?? null,
		width: match?.[2] ? Number(match[2]) : null,
		height: match?.[3] ? Number(match[3]) : null,
	};
}

function parseAudioCodec(stderr: string): string | null {
	const match = stderr.match(/Stream #\d+:\d+.*Audio:\s*([^,\s]+)/i);
	return match?.[1] ?? null;
}

export function parseVideoProbeMetadata(stderr: string): VideoProbeMetadata {
	const video = parseVideoStream(stderr);
	return {
		durationSec: parseDurationSeconds(stderr),
		width: video.width,
		height: video.height,
		videoCodec: video.videoCodec,
		audioCodec: parseAudioCodec(stderr),
		bitrateBps: parseBitrateBps(stderr),
	};
}

function normalizeCodec(codec: string | null): string | null {
	return codec?.toLowerCase().split(/[.\s(]/)[0] ?? null;
}

function isBrowserSafeMp4Codec(metadata: VideoProbeMetadata): boolean {
	const videoCodec = normalizeCodec(metadata.videoCodec);
	const audioCodec = normalizeCodec(metadata.audioCodec);

	if (!videoCodec || !MP4_SAFE_VIDEO_CODECS.has(videoCodec)) {
		return false;
	}

	return audioCodec == null || MP4_SAFE_AUDIO_CODECS.has(audioCodec);
}

export function chooseVideoOptimizationStrategy(
	metadata: VideoProbeMetadata,
): VideoOptimizationStrategy {
	if (!isBrowserSafeMp4Codec(metadata)) {
		return "compress";
	}

	const maxEdge =
		metadata.width != null && metadata.height != null
			? Math.max(metadata.width, metadata.height)
			: null;

	if (maxEdge != null && maxEdge > HIGH_RESOLUTION_MAX_EDGE) {
		return "compress";
	}

	if (metadata.bitrateBps != null && metadata.bitrateBps > HIGH_BITRATE_BPS) {
		return "compress";
	}

	return "copy";
}

/**
 * Reads container/codec/duration metadata without transcoding — used both to
 * pick the copy-vs-compress strategy and, on a failed conversion, as a
 * best-effort fallback so a video's known duration is never lost even when
 * the encode itself fails (see processVideoWorkflow).
 */
export async function probeRemoteVideo(
	videoUrl: string,
): Promise<VideoProbeMetadata> {
	const stderr = await runFfmpegForStderr(["-hide_banner", "-i", videoUrl]);
	return parseVideoProbeMetadata(stderr);
}

function isHlsUrl(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".m3u8");
}

function isMpdUrl(url: string): boolean {
	return (url.split("?")[0] ?? "").toLowerCase().endsWith(".mpd");
}

function withQuery(url: string, query: string): string {
	if (!query || url.includes("?")) {
		return url;
	}

	return `${url}${query}`;
}

function resolveResourceUrl(
	resource: string,
	baseUrl: string,
	query: string,
): string {
	if (resource.startsWith("http://") || resource.startsWith("https://")) {
		return withQuery(resource, query);
	}

	return withQuery(new URL(resource, baseUrl).toString(), query);
}

function escapeXmlAttribute(value: string): string {
	return value.replace(/[&<>"']/g, (char) => {
		switch (char) {
			case "&":
				return "&amp;";
			case "<":
				return "&lt;";
			case ">":
				return "&gt;";
			case '"':
				return "&quot;";
			default:
				return "&apos;";
		}
	});
}

async function materializeHlsPlaylist(
	playlistUrl: string,
	dirPath: string,
	cache: Map<string, string>,
): Promise<string> {
	const cached = cache.get(playlistUrl);
	if (cached) {
		return cached;
	}

	const response = await fetch(playlistUrl);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch HLS playlist: ${response.status} ${response.statusText}`,
		);
	}

	const content = await response.text();
	const parsedUrl = new URL(playlistUrl);
	const baseUrl = new URL(".", parsedUrl).toString();
	const query = parsedUrl.search;
	const filePath = join(dirPath, `${randomUUID()}.m3u8`);

	cache.set(playlistUrl, filePath);

	const lines = await Promise.all(
		content.split("\n").map(async (line) => {
			const trimmed = line.trim();

			if (!trimmed) {
				return line;
			}

			if (!trimmed.startsWith("#")) {
				const resolved = resolveResourceUrl(trimmed, baseUrl, query);

				if (isHlsUrl(resolved)) {
					return await materializeHlsPlaylist(resolved, dirPath, cache);
				}

				return resolved;
			}

			if (!line.includes('URI="')) {
				return line;
			}

			const matches = [...line.matchAll(/URI="([^"]+)"/g)];
			let rewritten = line;

			for (const match of matches) {
				const original = match[1];
				if (!original) {
					continue;
				}

				const resolved = resolveResourceUrl(original, baseUrl, query);
				const replacement = isHlsUrl(resolved)
					? await materializeHlsPlaylist(resolved, dirPath, cache)
					: resolved;

				rewritten = rewritten.replace(
					`URI="${original}"`,
					`URI="${replacement}"`,
				);
			}

			return rewritten;
		}),
	);

	await fs.writeFile(filePath, lines.join("\n"));
	return filePath;
}

async function materializeMpdManifest(
	manifestUrl: string,
	dirPath: string,
): Promise<string> {
	const response = await fetch(manifestUrl);
	if (!response.ok) {
		throw new Error(
			`Failed to fetch DASH manifest: ${response.status} ${response.statusText}`,
		);
	}

	const content = await response.text();
	const parsedUrl = new URL(manifestUrl);
	const baseUrl = new URL(".", parsedUrl).toString();
	const query = parsedUrl.search;
	const filePath = join(dirPath, `${randomUUID()}.mpd`);

	const rewritten = content.replace(
		/(initialization|media)="([^"]+)"/g,
		(_, attribute: string, resource: string) => {
			const resolved = resolveResourceUrl(resource, baseUrl, query);
			return `${attribute}="${escapeXmlAttribute(resolved)}"`;
		},
	);

	await fs.writeFile(filePath, rewritten);
	return filePath;
}

async function materializeStreamingInput(
	videoUrl: string,
	dirPath: string,
): Promise<string> {
	if (isHlsUrl(videoUrl)) {
		return await materializeHlsPlaylist(videoUrl, dirPath, new Map());
	}

	if (isMpdUrl(videoUrl)) {
		return await materializeMpdManifest(videoUrl, dirPath);
	}

	return videoUrl;
}

/**
 * Streams a plain http(s) video URL to a temp file inside `dirPath` (so the
 * caller's existing recursive dir cleanup removes it on success AND failure),
 * verifying the byte count against Content-Length when present. Downloading
 * BEFORE any ffmpeg run is what keeps a transient network drop from ending
 * the encode early: ffmpeg reading HTTP directly treats a dropped connection
 * as input EOF and exits 0, producing a truncated result.mp4 that looks like
 * a success (prod 2026-10-09, 34:55 in -> 151 s out). A failure here throws
 * and the caller's catch keeps the raw upload playable.
 */
async function downloadRemoteInputToDir(
	videoUrl: string,
	dirPath: string,
): Promise<string> {
	const response = await fetch(videoUrl);
	if (!response.ok || !response.body) {
		throw new Error(
			`Failed to download the video input: ${response.status} ${response.statusText}`,
		);
	}

	const pathname = new URL(videoUrl).pathname;
	const extension = pathname.match(/\.[A-Za-z0-9]{1,5}$/)?.[0] ?? ".mp4";
	const filePath = join(dirPath, `input-${randomUUID()}${extension}`);

	const contentLengthHeader = response.headers.get("content-length");
	const expectedBytes =
		contentLengthHeader != null && Number.isFinite(Number(contentLengthHeader))
			? Number(contentLengthHeader)
			: null;

	let bytesWritten = 0;
	await pipeline(
		Readable.fromWeb(response.body as unknown as NodeWebReadableStream),
		new Transform({
			transform(chunk: Buffer, _encoding, callback) {
				bytesWritten += chunk.length;
				callback(null, chunk);
			},
		}),
		createWriteStream(filePath),
	);

	if (expectedBytes != null && bytesWritten !== expectedBytes) {
		throw new Error(
			`Incomplete video input download: got ${bytesWritten} of ${expectedBytes} bytes`,
		);
	}

	return filePath;
}

function logOptimizeOutcome(
	strategy: VideoOptimizationStrategy,
	durationSec: number | null,
	startedAt: number,
	outcome: "ok" | "timeout" | "failed",
): void {
	console.log(
		`[video-convert] optimize ${outcome}: strategy=${strategy} durationSec=${durationSec ?? "unknown"} elapsedMs=${Date.now() - startedAt}`,
	);
}

async function convertRemoteVideoToMp4FileInternal(
	videoUrl: string,
	outputPath: string,
	options: VideoConversionOptions = {},
	durationSec: number | null = null,
): Promise<void> {
	const startedAt = Date.now();
	const copyTimeoutMs = options.timeoutMs ?? computeCopyTimeoutMs(durationSec);
	const progress = options.onProgress
		? { durationSec, onProgress: options.onProgress }
		: undefined;

	try {
		await runFfmpeg(
			["-y", "-i", videoUrl, "-c", "copy", "-movflags", "+faststart", outputPath],
			copyTimeoutMs,
			progress,
		);
		logOptimizeOutcome("copy", durationSec, startedAt, "ok");
	} catch (error) {
		if (error instanceof FfmpegTimeoutError) {
			// A TIMEOUT tells us the budget was too small for this source, not
			// that the codec needs re-encoding — falling through here is what
			// turned a 10-minute copy timeout into a 45-minute compress timeout
			// on top of it (measured: 0 successes, 3 failures in prod).
			logOptimizeOutcome("copy", durationSec, startedAt, "timeout");
			throw error;
		}

		// A genuine (non-timeout) copy failure is the only thing that may buy a
		// re-encode. It still must not buy an UNBOUNDED one: without this gate a
		// long source whose copy fails for a real reason walks straight into the
		// 45-minute compress this whole change exists to remove.
		logOptimizeOutcome("copy", durationSec, startedAt, "failed");

		if (durationSec != null && durationSec > COMPRESS_MAX_DURATION_SEC) {
			console.log(
				`[video-convert] optimize skipped: strategy=compress durationSec=${durationSec} reason=copy failed and source exceeds the ${COMPRESS_MAX_DURATION_SEC}s compress limit, raw upload kept`,
			);
			throw error;
		}

		const compressStartedAt = Date.now();
		try {
			await runFfmpeg(
				[
					"-y",
					"-i",
					videoUrl,
					"-c:v",
					"libx264",
					"-preset",
					"veryfast",
					"-crf",
					"26",
					"-pix_fmt",
					"yuv420p",
					"-c:a",
					"aac",
					"-b:a",
					"128k",
					"-movflags",
					"+faststart",
					outputPath,
				],
				options.timeoutMs ?? DEFAULT_COMPRESS_TIMEOUT_MS,
				progress,
			);
			logOptimizeOutcome("compress", durationSec, compressStartedAt, "ok");
		} catch (compressError) {
			logOptimizeOutcome(
				"compress",
				durationSec,
				compressStartedAt,
				compressError instanceof FfmpegTimeoutError ? "timeout" : "failed",
			);
			throw compressError;
		}
	}
}

async function optimizeRemoteVideoToMp4FileInternal(
	videoUrl: string,
	outputPath: string,
	strategy: VideoOptimizationStrategy,
	durationSec: number | null,
	options: VideoConversionOptions = {},
): Promise<void> {
	if (strategy === "copy") {
		await convertRemoteVideoToMp4FileInternal(
			videoUrl,
			outputPath,
			options,
			durationSec,
		);
		return;
	}

	if (durationSec != null && durationSec > COMPRESS_MAX_DURATION_SEC) {
		console.log(
			`[video-convert] optimize skipped: strategy=compress durationSec=${durationSec} reason=exceeds ${COMPRESS_MAX_DURATION_SEC}s compress limit, raw upload kept`,
		);
		throw new Error(
			`Compress skipped: durationSec=${durationSec} exceeds the ${COMPRESS_MAX_DURATION_SEC}s compress limit`,
		);
	}

	const startedAt = Date.now();
	const progress = options.onProgress
		? { durationSec, onProgress: options.onProgress }
		: undefined;
	try {
		await runFfmpeg(
			[
				"-y",
				"-i",
				videoUrl,
				"-c:v",
				"libx264",
				"-preset",
				"veryfast",
				"-crf",
				"21",
				"-vf",
				"scale='if(gt(iw,ih),min(1920,iw),-2)':'if(gt(iw,ih),-2,min(1920,ih))'",
				"-pix_fmt",
				"yuv420p",
				"-c:a",
				"aac",
				"-b:a",
				"128k",
				"-ar",
				"48000",
				"-movflags",
				"+faststart",
				outputPath,
			],
			options.timeoutMs ?? DEFAULT_COMPRESS_TIMEOUT_MS,
			progress,
		);
		logOptimizeOutcome("compress", durationSec, startedAt, "ok");
	} catch (error) {
		logOptimizeOutcome(
			"compress",
			durationSec,
			startedAt,
			error instanceof FfmpegTimeoutError ? "timeout" : "failed",
		);
		throw error;
	}
}

export async function convertRemoteVideoToMp4(
	videoUrl: string,
	options: VideoConversionOptions = {},
): Promise<VideoConversionResult> {
	const dirPath = await fs.mkdtemp(join(tmpdir(), "cap-video-"));
	const filePath = join(dirPath, `video-${randomUUID()}.mp4`);

	try {
		const inputPath = await materializeStreamingInput(videoUrl, dirPath);
		await convertRemoteVideoToMp4FileInternal(inputPath, filePath, options);

		return {
			filePath,
			mimeType: "video/mp4",
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

export async function optimizeRemoteVideoToMp4(
	videoUrl: string,
	options: VideoConversionOptions = {},
): Promise<VideoConversionResult> {
	const dirPath = await fs.mkdtemp(join(tmpdir(), "cap-video-"));
	const filePath = join(dirPath, `video-${randomUUID()}.mp4`);

	try {
		const materializedPath = await materializeStreamingInput(videoUrl, dirPath);
		// Download-first for a plain http(s) input (HLS/MPD already materialize
		// to a local playlist above): ffmpeg reading the remote URL directly
		// treats a dropped connection as input EOF and exits 0, which is how a
		// fully-uploaded 34:55 recording became a 151 s result.mp4 (prod
		// 2026-10-09). With the bytes local, a network drop can only fail the
		// DOWNLOAD — loudly, before any slow encode is spent.
		const inputPath =
			materializedPath !== videoUrl
				? materializedPath
				: /^https?:/i.test(videoUrl)
					? await downloadRemoteInputToDir(videoUrl, dirPath)
					: videoUrl;
		const metadata = await probeRemoteVideo(inputPath);
		const strategy = chooseVideoOptimizationStrategy(metadata);
		await optimizeRemoteVideoToMp4FileInternal(
			inputPath,
			filePath,
			strategy,
			metadata.durationSec,
			options,
		);
		// The downloaded input is no longer needed: free its disk now instead of
		// holding input + output until the caller's cleanup after the upload.
		if (inputPath !== videoUrl && inputPath !== materializedPath) {
			await fs.rm(inputPath, { force: true }).catch(() => {});
		}

		// Output-duration guard (copy and compress paths both land here):
		// ffmpeg's exit 0 proves nothing about completeness — see
		// TruncatedOutputError. The trim path (trimRemoteVideoToMp4) is
		// deliberately NOT guarded: its output is legitimately shorter.
		const outputMetadata = await probeRemoteVideo(filePath);
		if (
			isDurationShortenedBeyondTolerance(
				metadata.durationSec,
				outputMetadata.durationSec,
			)
		) {
			console.log(
				`[video-convert] optimize truncated: in=${metadata.durationSec} out=${outputMetadata.durationSec}`,
			);
			throw new TruncatedOutputError(
				metadata.durationSec as number,
				outputMetadata.durationSec as number,
			);
		}

		return {
			filePath,
			mimeType: "video/mp4",
			metadata,
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

export interface VideoTrimRange {
	startSec: number;
	endSec: number;
}

async function trimRemoteVideoToMp4FileInternal(
	videoUrl: string,
	outputPath: string,
	range: VideoTrimRange,
	options: VideoConversionOptions = {},
): Promise<void> {
	const duration = Math.max(0, range.endSec - range.startSec);

	await runFfmpeg(
		[
			"-y",
			"-ss",
			String(range.startSec),
			"-i",
			videoUrl,
			"-t",
			String(duration),
			"-c:v",
			"libx264",
			"-preset",
			"veryfast",
			"-crf",
			"23",
			"-pix_fmt",
			"yuv420p",
			"-c:a",
			"aac",
			"-b:a",
			"128k",
			"-movflags",
			"+faststart",
			outputPath,
		],
		options.timeoutMs ?? DEFAULT_COMPRESS_TIMEOUT_MS,
	);
}

/**
 * Re-encodes a single [startSec,endSec) range of a remote video into a new
 * faststart MP4 — the server-side implementation of "Apply pending trim"
 * (workflows/edit-video.ts). `-ss` before `-i` combined with `-t` gives an
 * accurate, re-encoded cut regardless of keyframe placement (a `-c copy` trim
 * would snap to the nearest keyframe, which is not what the user selected).
 */
export async function trimRemoteVideoToMp4(
	videoUrl: string,
	range: VideoTrimRange,
	options: VideoConversionOptions = {},
): Promise<VideoConversionResult> {
	const dirPath = await fs.mkdtemp(join(tmpdir(), "cap-video-"));
	const filePath = join(dirPath, `video-${randomUUID()}.mp4`);

	try {
		const inputPath = await materializeStreamingInput(videoUrl, dirPath);
		await trimRemoteVideoToMp4FileInternal(inputPath, filePath, range, options);
		// Probe the ACTUAL output (not the math) so a slightly-off ffmpeg cut
		// never leaves videos.duration wrong.
		const metadata = await probeRemoteVideo(filePath);

		return {
			filePath,
			mimeType: "video/mp4",
			metadata,
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

export async function convertRemoteVideoToMp4Buffer(
	videoUrl: string,
	options: VideoConversionOptions = {},
): Promise<Buffer> {
	const result = await convertRemoteVideoToMp4(videoUrl, options);

	try {
		return await fs.readFile(result.filePath);
	} finally {
		await result.cleanup();
	}
}
