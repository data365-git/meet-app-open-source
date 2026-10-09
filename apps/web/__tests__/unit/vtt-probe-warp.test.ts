import { describe, expect, it } from "vitest";
import {
	acceptAnchors,
	parseVttCues,
	selectProbeCandidates,
	warpVtt,
} from "@/lib/vtt-probe-warp";

// Ladder step ④ (Gemini-only maximum): known-text localization warp.
// Every test below pins one reviewer-named failure mode from
// docs/plans/2026-07-29-timestamp-ladder-v2.md — the guards exist because a
// wrong anchor CORRUPTS timestamps it was meant to fix.

const vttOf = (cues: Array<[string, string, string]>) =>
	`WEBVTT\n\n${cues
		.map(([s, e, t], i) => `${i + 1}\n${s} --> ${e}\n${t}`)
		.join("\n\n")}\n`;

describe("parseVttCues", () => {
	it("parses absolute cues and strips nothing from text", () => {
		const cues = parseVttCues(
			vttOf([
				["00:00:10.000", "00:00:14.000", "<v Spiker 1>Birinchi jumla shu yerda.</v>"],
				["00:15:00.500", "00:15:04.000", "Ikkinchi jumla boshqa joyda."],
			]),
		);
		expect(cues).toHaveLength(2);
		expect(cues[0]?.start).toBeCloseTo(10);
		expect(cues[1]?.start).toBeCloseTo(900.5);
	});
});

describe("selectProbeCandidates — anchor hygiene", () => {
	it("rejects repeated text (either occurrence could match the probe)", () => {
		const dup = "Bu takrorlanadigan uzun jumla misol uchun yozildi";
		const cues = parseVttCues(
			vttOf([
				["00:00:10.000", "00:00:14.000", dup],
				["00:05:00.000", "00:05:04.000", "Bu yagona boshqa mazmunli uzun jumla bo'ladi shu yerda"],
				["00:10:00.000", "00:10:04.000", dup],
			]),
		);
		const picks = selectProbeCandidates(cues, 10);
		expect(picks).toHaveLength(1);
		expect(picks[0]?.probeText).toContain("yagona boshqa mazmunli");
	});

	it("rejects backchannel-heavy and too-short cues", () => {
		const cues = parseVttCues(
			vttOf([
				["00:00:10.000", "00:00:11.000", "Xo'p, mayli, yaxshi, rahmat, davom."],
				["00:04:00.000", "00:04:02.000", "Ha."],
				["00:08:00.000", "00:08:04.000", "Loyihaning asosiy maqsadi mijozlar bazasini kengaytirish edi"],
			]),
		);
		const picks = selectProbeCandidates(cues, 10);
		expect(picks).toHaveLength(1);
		expect(picks[0]?.probeText).toContain("asosiy maqsadi");
	});

	it("spreads candidates: at most one per minGapSec", () => {
		const mk = (i: number): [string, string, string] => [
			`00:00:${String(10 + i).padStart(2, "0")}.000`,
			`00:00:${String(14 + i).padStart(2, "0")}.000`,
			`Jumla raqami ${i} butunlay boshqacha mazmun tashiydi albatta`,
		];
		const cues = parseVttCues(vttOf([mk(0), mk(1), mk(2), mk(3)]));
		const picks = selectProbeCandidates(cues, 10, 120);
		expect(picks).toHaveLength(1); // all within 4s of each other
	});
});

describe("acceptAnchors — outliers and monotonicity", () => {
	const A = (claimed: number, actual: number) => ({
		claimedSec: claimed,
		actualSec: actual,
	});

	it("drops a shift beyond the bound instead of trusting it", () => {
		const out = acceptAnchors(
			[A(100, 104), A(400, 350), A(700, 706), A(1000, 1009)],
			{ maxShiftSec: 45 },
		);
		expect(out.map((a) => a.claimedSec)).toEqual([100, 700, 1000]);
	});

	it("drops out-of-order anchors greedily rather than clamping them", () => {
		const out = acceptAnchors([A(100, 110), A(200, 105), A(300, 315), A(500, 508)]);
		// 200→105 goes BACKWARDS in actual time vs the first anchor — dropped.
		expect(out.map((a) => a.claimedSec)).toEqual([100, 300, 500]);
	});

	it("returns EMPTY below the minimum anchor count (warp must no-op)", () => {
		expect(acceptAnchors([A(100, 104), A(700, 707)])).toHaveLength(0);
	});
});

describe("warpVtt", () => {
	const vtt = vttOf([
		["00:00:10.000", "00:00:14.000", "Boshi."],
		["00:05:00.000", "00:05:04.000", "O'rtasi."],
		["00:10:00.000", "00:10:04.000", "Oxiri."],
		["00:20:00.000", "00:20:04.000", "Eng oxiri."],
	]);

	it("no anchors -> the INPUT STRING is returned unchanged (===)", () => {
		const out = warpVtt(vtt, []);
		expect(out.applied).toBe(false);
		expect(out.vtt).toBe(vtt);
	});

	it("interpolates between anchors and holds a CONSTANT offset outside them", () => {
		const anchors = [
			{ claimedSec: 300, actualSec: 310 }, // +10
			{ claimedSec: 600, actualSec: 620 }, // +20
			{ claimedSec: 1200, actualSec: 1200 }, // 0
		];
		const out = warpVtt(vtt, anchors, 1300);
		expect(out.applied).toBe(true);
		// Cue at 10s sits BEFORE the first anchor: constant +10, NOT slope-extrapolated.
		expect(out.vtt).toContain("00:00:20.000 --> 00:00:24.000");
		// Cue at 300s hits the first anchor exactly: 310.
		expect(out.vtt).toContain("00:05:10.000");
		// Cue at 600s hits the second anchor exactly: 620.
		expect(out.vtt).toContain("00:10:20.000");
		// Cue at 1200s (last anchor, shift 0) stays put.
		expect(out.vtt).toContain("00:20:00.000 --> 00:20:04.000");
	});

	it("keeps cue order and minimum duration even when anchors squeeze times together", () => {
		const squeeze = [
			{ claimedSec: 300, actualSec: 596 },
			{ claimedSec: 600, actualSec: 600 },
			{ claimedSec: 1200, actualSec: 1210 },
		];
		const out = warpVtt(vtt, squeeze, 1300);
		const starts = [...out.vtt.matchAll(/(\d{2}):(\d{2}):(\d{2})\.(\d{3}) -->/g)].map(
			(m) =>
				Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000,
		);
		for (let i = 1; i < starts.length; i++) {
			expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1] as number);
		}
		// every cue keeps >= 0.2s duration
		const pairs = [...out.vtt.matchAll(
			/(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})/g,
		)];
		for (const m of pairs) {
			const s =
				Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
			const e =
				Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
			expect(e - s).toBeGreaterThanOrEqual(0.2 - 1e-9);
		}
	});
});
