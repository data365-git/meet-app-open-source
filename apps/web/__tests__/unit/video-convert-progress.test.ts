import { describe, expect, it } from "vitest";
import { computeFfmpegProgressPercent } from "@/lib/video-convert";

/**
 * 2026-08-18 wave 2, Change B — the silent optimize/save stage
 * (docs/plans/2026-08-18-upload-progress-SCOPE.md). ffmpeg's stderr is
 * already piped and accumulated for error reporting (video-convert.ts:113);
 * `computeFfmpegProgressPercent` parses the `time=HH:MM:SS.ms` tokens out of
 * that same accumulated buffer against a known duration.
 */

function ffmpegProgressLine(timeSec: number): string {
	const h = Math.floor(timeSec / 3600);
	const m = Math.floor((timeSec % 3600) / 60);
	const s = timeSec % 60;
	const hh = String(h).padStart(2, "0");
	const mm = String(m).padStart(2, "0");
	const ss = s.toFixed(2).padStart(5, "0");
	return `frame=  100 fps= 25 q=28.0 size=     256kB time=${hh}:${mm}:${ss} bitrate= 524.3kbits/s speed=1.2x\n`;
}

describe("computeFfmpegProgressPercent", () => {
	it("yields a monotonically non-decreasing sequence of at least 5 distinct integer percentages against a known duration", () => {
		const durationSec = 60;
		const timeSecs = [3, 12, 24, 36, 48, 59];
		let stderr = "";
		const percentages: number[] = [];

		for (const t of timeSecs) {
			// ffmpeg re-prints the WHOLE stderr line, and the caller keeps
			// accumulating it (video-convert.ts's own `stderr +=`) exactly like
			// this — so feeding the growing buffer is the real call shape.
			stderr += ffmpegProgressLine(t);
			const percent = computeFfmpegProgressPercent(stderr, durationSec);
			expect(percent).not.toBeNull();
			percentages.push(Math.round(percent as number));
		}

		for (let i = 1; i < percentages.length; i++) {
			expect(percentages[i]).toBeGreaterThanOrEqual(percentages[i - 1] as number);
		}
		expect(new Set(percentages).size).toBeGreaterThanOrEqual(5);
	});

	it("clamps to 0..99 even once the source has fully elapsed — 100 is reserved for the caller", () => {
		const percent = computeFfmpegProgressPercent(ffmpegProgressLine(60), 60);
		expect(percent).not.toBeNull();
		expect(percent as number).toBeLessThanOrEqual(99);
		expect(percent as number).toBeGreaterThanOrEqual(0);
	});

	it("reports null — never a guessed percentage — when the duration could not be probed", () => {
		const stderr = ffmpegProgressLine(30);
		expect(computeFfmpegProgressPercent(stderr, null)).toBeNull();
	});

	it("reports null before any time= token has appeared in the buffer", () => {
		const stderr = "ffmpeg version 6.0\nConfiguration: ...\n";
		expect(computeFfmpegProgressPercent(stderr, 60)).toBeNull();
	});
});
