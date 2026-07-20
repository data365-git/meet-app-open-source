import { describe, expect, it } from "vitest";
import { normalizeToWebVtt, rescaleChunkVtt } from "@/lib/gemini-transcribe";
import { computeSilenceAnchoredCuts } from "@/lib/audio-extract";

// Regression cover for the within-chunk transcript drift measured on production
// 2026-07-19 (scripts/measure-transcript-drift.mjs, real 42-min recording):
// cues ran up to 120s AHEAD of the audio inside a single 6-min chunk, resetting
// at each chunk boundary. Gemini's clock runs at a near-constant fraction of
// real time, so the error is linear and a linear stretch removes it.

const vtt = (rows: Array<[string, string, string]>) =>
	`WEBVTT\n\n${rows
		.map(([s, e, t], i) => `${i + 1}\n${s} --> ${e}\n${t}\n`)
		.join("\n")}`;

const startsOf = (out: string) =>
	[...out.matchAll(/(\d{2}:\d{2}:\d{2}\.\d{3}) -->/g)].map((m) => m[1]);

describe("rescaleChunkVtt", () => {
	it("stretches a compressed chunk so its last cue lands on the speech end", () => {
		// Gemini reported 0..240s for audio whose speech really runs to 360s
		// (factor 1.5) — the measured failure mode.
		const input = vtt([
			["00:00:00.000", "00:00:10.000", "one"],
			["00:02:00.000", "00:02:10.000", "two"],
			["00:04:00.000", "00:04:00.000", "three"],
		]);
		const r = rescaleChunkVtt(input, 360);
		expect(r.applied).toBe(true);
		expect(r.factor).toBeCloseTo(1.5, 3);
		// 120s (2:00) reported -> 180s (3:00) real.
		expect(startsOf(r.vtt)).toEqual([
			"00:00:00.000",
			"00:03:00.000",
			"00:06:00.000",
		]);
	});

	it("reproduces the measured production case: 120s of drift collapses to ~0", () => {
		// Sampled reality: chunk starts at 1800s, Gemini's clock ran at ~0.64x, so
		// a word truly at +350s was reported at +224s (a 126s error).
		// The anchor is where speech actually ENDS — here the last word ends at
		// +352s, which is exactly what silence-anchored cutting reports as
		// speechEndSec (the start of the silence the next boundary sits on).
		const span = 352;
		const clock = 0.64;
		const trueTimes = [0, 100, 200, 300, 350];
		const input = vtt(
			trueTimes.map((t) => {
				const reported = t * clock;
				const fmt = (x: number) =>
					`00:${String(Math.floor(x / 60)).padStart(2, "0")}:${String(Math.floor(x % 60)).padStart(2, "0")}.000`;
				return [fmt(reported), fmt(reported + 2), `w${t}`] as [
					string,
					string,
					string,
				];
			}),
		);
		const r = rescaleChunkVtt(input, span);
		expect(r.applied).toBe(true);
		const secs = startsOf(r.vtt).map((ts) => {
			const parts = (ts ?? "").split(":");
			return Number(parts[1] ?? 0) * 60 + Number((parts[2] ?? "0").split(".")[0]);
		});
		// Every cue now sits within a few seconds of its true position — versus
		// up to 126s off before.
		for (let i = 0; i < trueTimes.length; i++) {
			expect(Math.abs((secs[i] ?? 0) - (trueTimes[i] ?? 0))).toBeLessThan(8);
		}
	});

	it("degrades gracefully when the speech-end anchor is off: error stays bounded", () => {
		// If speechEndSec over-estimates where speech stops (e.g. a 30s silence was
		// missed), the stretch over-corrects — but the residual is a fraction of
		// the 120s it removed, so the fix is still strictly better than nothing.
		const clock = 0.64;
		const trueTimes = [0, 100, 200, 300, 350];
		const fmt = (x: number) =>
			`00:${String(Math.floor(x / 60)).padStart(2, "0")}:${String(Math.floor(x % 60)).padStart(2, "0")}.000`;
		const input = vtt(
			trueTimes.map(
				(t) =>
					[fmt(t * clock), fmt(t * clock + 2), `w${t}`] as [
						string,
						string,
						string,
					],
			),
		);
		const r = rescaleChunkVtt(input, 382); // 30s too generous
		expect(r.applied).toBe(true);
		const secs = startsOf(r.vtt).map((ts) => {
			const parts = (ts ?? "").split(":");
			return Number(parts[1] ?? 0) * 60 + Number((parts[2] ?? "0").split(".")[0]);
		});
		const worst = Math.max(
			...trueTimes.map((t, i) => Math.abs((secs[i] ?? 0) - t)),
		);
		expect(worst).toBeLessThan(35); // vs 126s of drift without the rescale
	});

	it("leaves a chunk alone when the clock was already honest", () => {
		const input = vtt([
			["00:00:00.000", "00:00:10.000", "a"],
			["00:02:00.000", "00:02:10.000", "b"],
			["00:05:50.000", "00:05:58.000", "c"],
		]);
		const r = rescaleChunkVtt(input, 360);
		expect(r.applied).toBe(false);
		expect(r.reason).toBe("factor-out-of-range");
		expect(r.vtt).toBe(input);
	});

	it("refuses to amplify a chunk that is mostly silence (factor too large)", () => {
		const input = vtt([
			["00:00:00.000", "00:00:02.000", "a"],
			["00:00:20.000", "00:00:22.000", "b"],
			["00:00:40.000", "00:00:42.000", "c"],
		]);
		const r = rescaleChunkVtt(input, 360); // factor ~8.5
		expect(r.applied).toBe(false);
		expect(r.reason).toBe("factor-out-of-range");
	});

	it("does not touch a chunk with too few cues", () => {
		const input = vtt([["00:00:00.000", "00:00:05.000", "only"]]);
		const r = rescaleChunkVtt(input, 360);
		expect(r.applied).toBe(false);
		expect(r.reason).toBe("too-few-cues");
	});

	it("never pushes a cue past the chunk's own speech span", () => {
		const input = vtt([
			["00:00:00.000", "00:00:10.000", "a"],
			["00:01:00.000", "00:01:10.000", "b"],
			["00:03:00.000", "00:03:30.000", "c"],
		]);
		const r = rescaleChunkVtt(input, 300);
		expect(r.applied).toBe(true);
		const ends = [...r.vtt.matchAll(/--> (\d{2}):(\d{2}):(\d{2})/g)].map(
			([, h, m, s]) => Number(h) * 3600 + Number(m) * 60 + Number(s),
		);
		for (const e of ends) expect(e).toBeLessThanOrEqual(300);
	});

	it("handles empty / cue-less input without throwing", () => {
		expect(rescaleChunkVtt("WEBVTT\n\n", 360).applied).toBe(false);
		expect(rescaleChunkVtt("", 360).applied).toBe(false);
		expect(rescaleChunkVtt("WEBVTT\n\n", 0).applied).toBe(false);
	});
});

describe("computeSilenceAnchoredCuts speechEndSec", () => {
	it("reports the silence START before each anchored boundary", () => {
		// Speech, then a silence 350..360, then speech again.
		const specs = computeSilenceAnchoredCuts(
			[
				{ start: 350, end: 360 },
				{ start: 700, end: 710 },
			],
			1000,
			360,
		);
		expect(specs.length).toBeGreaterThan(1);
		// First chunk runs 0..360 and its speech stops at 350.
		expect(specs[0]?.startSec).toBe(0);
		expect(specs[0]?.speechEndSec).toBe(350);
		expect(specs[1]?.startSec).toBe(360);
	});

	it("omits speechEndSec for a fallback cut (no usable silence near the target)", () => {
		const specs = computeSilenceAnchoredCuts([], 1000, 360);
		expect(specs[0]?.startSec).toBe(0);
		expect(specs[0]?.speechEndSec).toBeUndefined();
	});

	it("keeps the last chunk without a speech end (nothing anchors after it)", () => {
		const specs = computeSilenceAnchoredCuts(
			[{ start: 350, end: 360 }],
			700,
			360,
		);
		expect(specs[specs.length - 1]?.speechEndSec).toBeUndefined();
	});
});

// ── Gemini's dot-separated timestamps (measured on prod 2026-07-20) ──────────
//
// One chunk of a 53-minute meeting came back as
//   00:00.000 --> 00:00.07.500
//   00:00.07.500 --> 00:00.14.500
// Read as a sequence that is plainly 0s, 7.5s, 14.5s — but the old pattern
// matched only the `00:00.07` prefix, so every cue collapsed to ~0.07s. The
// damage was not cosmetic: the chunk then looked "under-covered", which RETRIED
// a paid transcription twice, and it left too few parsable cues for the drift
// rescale, so those minutes kept the very drift the rescale exists to remove
// (the two worst residual samples, -18.7s and -66.7s, sat in exactly that
// chunk).
describe("normalizeToWebVtt — Gemini dot-separated timestamps", () => {
	it("reads HH:MM.SS.mmm as real seconds instead of collapsing the chunk to ~0s", () => {
		const raw = [
			"WEBVTT",
			"",
			"00:00.000 --> 00:00.07.500",
			"<v Nazirjon>Birinchi gap.</v>",
			"",
			"00:00.07.500 --> 00:00.14.500",
			"<v Nazirjon>Ikkinchi gap.</v>",
			"",
			"00:00.14.500 --> 00:00.21.000",
			"<v Nazirjon>Uchinchi gap.</v>",
			"",
		].join("\n");

		const out = normalizeToWebVtt(raw, 300);
		const starts = startsOf(out);

		expect(starts).toEqual([
			"00:00:00.000",
			"00:00:07.500",
			"00:00:14.500",
		]);
		// And the chunk now spans real time, so the coverage check cannot mistake
		// it for an under-covered chunk and pay for a retry.
		expect(out).toContain("00:00:21.000");
	});

	it("still rescales a chunk written in that shape", () => {
		const raw = [
			"WEBVTT",
			"",
			"00:00.000 --> 00:01.00.000",
			"bir",
			"",
			"00:01.00.000 --> 00:02.00.000",
			"ikki",
			"",
			"00:02.00.000 --> 00:04.00.000",
			"uch",
			"",
		].join("\n");

		const normalized = normalizeToWebVtt(raw, 360);
		const result = rescaleChunkVtt(normalized, 360);

		expect(result.applied).toBe(true);
		expect(result.factor).toBeCloseTo(1.5, 1);
	});
});

// ── A stray trailing cue must not disable the rescale (prod, 2026-07-20) ─────
//
// max(end) is the anchor, so ONE late cue can report "already the right length"
// for a chunk that is actually compressed. Measured twice on the same 53-minute
// recording: once it skipped the chunk outright (-65.9s residual drift), once it
// merely inflated the anchor (-28.6s). The discriminator has to be RELATIVE to
// the chunk's own cue density — an absolute gap threshold cannot tell a stray
// from genuinely sparse speech, and an earlier attempt at one turned five of the
// tests above red. Calibrated against nine real chunks: final gaps of 2.5-6.0s
// against ~6s spacing, versus 16.5s on the chunk that misled the anchor.
describe("rescaleChunkVtt — stray trailing cue", () => {
	const dense = (): Array<[string, string, string]> => {
		const rows: Array<[string, string, string]> = [];
		for (let i = 0; i < 40; i++) {
			const s = i * 7;
			rows.push([
				`00:0${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}.000`,
				`00:0${Math.floor((s + 5) / 60)}:${String((s + 5) % 60).padStart(2, "0")}.000`,
				`cue ${i}`,
			]);
		}
		return rows;
	};

	it("anchors on the body when one cue sits far past the rest", () => {
		// Body ends at 278s; a lone cue then claims 338s of a 360s span. Anchored
		// on the stray, factor is 1.06 and the chunk stays compressed; anchored on
		// the body it is ~1.29 — the difference measured as -28.6s of drift.
		const withStray = vtt([
			...dense(),
			["00:05:36.000", "00:05:38.000", "stray"],
		]);

		const result = rescaleChunkVtt(withStray, 360);

		expect(result.applied).toBe(true);
		expect(result.factor).toBeGreaterThan(1.25);
	});

	it("keeps the last cue when speech simply runs to the end", () => {
		const continuous = vtt([
			...dense(),
			["00:04:45.000", "00:04:50.000", "davomi"],
		]);

		const result = rescaleChunkVtt(continuous, 360);

		expect(result.applied).toBe(true);
		expect(result.factor).toBeCloseTo(360 / 290, 2);
	});
});
