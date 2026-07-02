import { describe, expect, it, vi } from "vitest";

// Minimal mocks so workflows/transcribe.ts imports for its pure exports.
vi.mock("@cap/database", () => ({ db: vi.fn() }));
vi.mock("@cap/env", () => ({ serverEnv: () => ({}) }));
vi.mock("@cap/web-backend", () => ({ Storage: {} }));
vi.mock("@/lib/server", () => ({ runPromise: vi.fn() }));
vi.mock("workflow", () => ({ FatalError: class FatalError extends Error {} }));
vi.mock("server-only", () => ({}));

import {
	MIN_CHUNK_COVERAGE,
	transcribeAudioChunkWithRetry,
	webVttCoverageSec,
} from "@/workflows/transcribe";

function formatVttTime(sec: number): string {
	const whole = Math.floor(sec);
	const hh = String(Math.floor(whole / 3600)).padStart(2, "0");
	const mm = String(Math.floor((whole % 3600) / 60)).padStart(2, "0");
	const ss = String(whole % 60).padStart(2, "0");
	return `${hh}:${mm}:${ss}.000`;
}

// A VTT whose last cue STARTS at `start` seconds (coverage = latest start).
// By default cues are dense enough for the gap-aware retry check.
function vttCoveringTo(start: number, intervalSec = 60): string {
	const starts = new Set<number>([0, start]);
	for (let sec = intervalSec; sec < start; sec += intervalSec) {
		starts.add(sec);
	}
	const cues = [...starts]
		.sort((a, b) => a - b)
		.map(
			(sec, i) =>
				`${formatVttTime(sec)} --> ${formatVttTime(sec + 1)}\ncue ${i + 1}`,
		)
		.join("\n\n");
	return `WEBVTT\n\n${cues}\n`;
}

describe("webVttCoverageSec", () => {
	it("measures the LATEST cue start (immune to runaway ends)", () => {
		// A cue starting at 60 but ending at 4500 (runaway) → coverage is 60, not 4500.
		const vtt = "WEBVTT\n\n00:01:00.000 --> 01:15:00.000\nrunaway\n";
		expect(webVttCoverageSec(vtt)).toBe(60);
	});
	it("returns 0 for an empty transcript", () => {
		expect(webVttCoverageSec("WEBVTT\n\n")).toBe(0);
	});
});

const chunk = {
	url: "https://x/chunk.mp3",
	key: "k",
	startSec: 900,
	durationSec: 900,
} as never;
const context = { userId: "u", orgId: "o", videoId: "v" };

describe("transcribeAudioChunkWithRetry — coverage-aware", () => {
	it("retries a chunk whose cues stop early (start-based) and keeps the fuller one", async () => {
		// attempt 1: cues stop at 65s of a 900s chunk (the silent-gap bug,
		// even with a runaway end this would be caught); attempt 2: reaches 800s.
		const fn = vi
			.fn()
			.mockResolvedValueOnce(vttCoveringTo(65))
			.mockResolvedValueOnce(vttCoveringTo(800));
		const out = await transcribeAudioChunkWithRetry(
			{ chunk, ownerEncryptedGeminiKey: null, context },
			fn,
		);
		expect(fn).toHaveBeenCalledTimes(2);
		expect(webVttCoverageSec(out)).toBe(800); // kept the fuller one
	});

	it("returns immediately when the first result already covers the chunk", async () => {
		const fn = vi.fn().mockResolvedValue(vttCoveringTo(850));
		await transcribeAudioChunkWithRetry(
			{ chunk, ownerEncryptedGeminiKey: null, context },
			fn,
		);
		expect(fn).toHaveBeenCalledTimes(1);
	});

	it("keeps the best partial (never empty) when every attempt is short", async () => {
		const fn = vi
			.fn()
			.mockResolvedValueOnce(vttCoveringTo(40))
			.mockResolvedValueOnce(vttCoveringTo(120)) // best
			.mockResolvedValueOnce(vttCoveringTo(400, 400)) // farther but sparse
			.mockResolvedValueOnce(vttCoveringTo(50));
		const out = await transcribeAudioChunkWithRetry(
			{ chunk, ownerEncryptedGeminiKey: null, context },
			fn,
		);
		expect(fn).toHaveBeenCalledTimes(4); // exhausts attempts trying for coverage
		expect(webVttCoverageSec(out)).toBe(120); // best partial, not empty
	});

	it("MIN_CHUNK_COVERAGE is a sane fraction", () => {
		expect(MIN_CHUNK_COVERAGE).toBeGreaterThan(0);
		expect(MIN_CHUNK_COVERAGE).toBeLessThan(1);
	});
});
