import { describe, expect, it } from "vitest";
import {
	computeSilenceAnchoredCuts,
	type SilenceInterval,
} from "@/lib/audio-extract";

describe("computeSilenceAnchoredCuts", () => {
	it("skips leading silence at 0 instead of starting the first chunk there", () => {
		const silences: SilenceInterval[] = [{ start: 0, end: 10 }];
		const specs = computeSilenceAnchoredCuts(silences, 1500, 600);

		expect(specs[0]?.startSec).toBeCloseTo(10, 3);
		expect(specs[0]?.startSec).not.toBe(0);
	});

	it("cuts land on the silence end nearest each target boundary", () => {
		// Target boundaries at 600 and 1200. Put a silence end right at 605 and 1190.
		const silences: SilenceInterval[] = [
			{ start: 598, end: 605 },
			{ start: 1185, end: 1190 },
		];
		const specs = computeSilenceAnchoredCuts(silences, 1800, 600);

		expect(specs[0]?.startSec).toBe(0);
		expect(specs[1]?.startSec).toBeCloseTo(605, 3);
		expect(specs[2]?.startSec).toBeCloseTo(1190, 3);
	});

	it("falls back to fixed evenly-spaced chunks when there are no silences", () => {
		const specs = computeSilenceAnchoredCuts([], 1500, 600);

		expect(specs).toEqual([
			{ startSec: 0, durationSec: 600 },
			{ startSec: 600, durationSec: 600 },
			{ startSec: 1200, durationSec: 300 },
		]);
	});

	it("returns a single fixed chunk when total duration is <= target chunk length", () => {
		const specs = computeSilenceAnchoredCuts([], 400, 600);

		expect(specs).toEqual([{ startSec: 0, durationSec: 400 }]);
	});

	it("hard-cuts exactly at the target when no silence is nearby", () => {
		// Only silence is far from any target boundary (600, 1200) — no candidate within window.
		const silences: SilenceInterval[] = [{ start: 300, end: 302 }];
		const specs = computeSilenceAnchoredCuts(silences, 1800, 600);

		expect(specs[1]?.startSec).toBe(600);
		expect(specs[2]?.startSec).toBe(1200);
	});

	it("guards against a tiny chunk when the nearest silence is too close to the previous boundary", () => {
		// targetChunkSec=90 -> WINDOW=36, so the search band around target=90 is
		// [54,126]. A silence ending at 55 falls inside that band but is only
		// 55s after pos=0 (< MIN_CHUNK=60) — the guard must reject it and hard-
		// cut at the full target (90) instead of the tiny 55s chunk.
		const silences: SilenceInterval[] = [{ start: 53, end: 55 }];
		const specs = computeSilenceAnchoredCuts(silences, 2000, 90);

		expect(specs[0]?.startSec).toBe(0);
		expect(specs[1]?.startSec).toBe(90);
	});

	it("produces strictly increasing starts and durations that sum to the total (within rounding), with no non-positive chunk", () => {
		const silences: SilenceInterval[] = [
			{ start: 0, end: 5 },
			{ start: 598, end: 604 },
			{ start: 1203, end: 1207 },
			{ start: 1799, end: 1805 },
		];
		const total = 2500;
		const specs = computeSilenceAnchoredCuts(silences, total, 600);

		let prevStart = -1;
		let sum = 0;
		for (const spec of specs) {
			expect(spec.startSec).toBeGreaterThan(prevStart);
			expect(spec.durationSec).toBeGreaterThan(0);
			prevStart = spec.startSec;
			sum += spec.durationSec;
		}
		expect(sum).toBeCloseTo(total - specs[0]!.startSec, 1);
	});
});
