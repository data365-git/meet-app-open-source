import { describe, expect, it } from "vitest";
import type { VideoEditSpec } from "@cap/database/types";
import {
	remapChaptersByStart,
	remapChaptersByStartSec,
	remapTimePoints,
	remapVttCuesForEdit,
} from "@/lib/vtt-edit-remap";

// Source timeline: 100s total, trim keeps [0,30) and [60,100) — i.e. the
// middle 30s (30..60) was cut out. Output timeline is 70s long:
//   output [0,30)  <- source [0,30)
//   output [30,70) <- source [60,100)
const TRIM_MIDDLE: VideoEditSpec = {
	version: 1,
	sourceDuration: 100,
	keepRanges: [
		{ start: 0, end: 30 },
		{ start: 60, end: 100 },
	],
};

function cue(start: string, end: string, text: string) {
	return `${start} --> ${end}\n${text}`;
}

describe("remapVttCuesForEdit", () => {
	it("shifts a cue fully inside a kept range by the removed duration", () => {
		const vtt = `WEBVTT\n\n${cue("00:01:10.000", "00:01:15.000", "after the cut")}\n\n`;
		const result = remapVttCuesForEdit(vtt, TRIM_MIDDLE);

		expect(result.totalCues).toBe(1);
		expect(result.droppedCues).toBe(0);
		expect(result.clippedCues).toBe(0);
		// source 70s -> output 40s (70 - 30 removed before it)
		expect(result.vtt).toContain("00:00:40.000 --> 00:00:45.000");
		expect(result.vtt).toContain("after the cut");
	});

	it("drops a cue entirely inside a removed span", () => {
		const vtt = `WEBVTT\n\n${cue("00:00:35.000", "00:00:40.000", "gone")}\n\n`;
		const result = remapVttCuesForEdit(vtt, TRIM_MIDDLE);

		expect(result.totalCues).toBe(1);
		expect(result.droppedCues).toBe(1);
		expect(result.keptCues).toBe(0);
		expect(result.vtt).not.toContain("gone");
		expect(result.vtt.trim()).toBe("WEBVTT");
	});

	it("clips a cue that straddles a cut boundary (starts before, ends after)", () => {
		// Cue spans 25..35 — the cut removes 30..60, so only the [25,30) part survives.
		const vtt = `WEBVTT\n\n${cue("00:00:25.000", "00:00:35.000", "straddles")}\n\n`;
		const result = remapVttCuesForEdit(vtt, TRIM_MIDDLE);

		expect(result.droppedCues).toBe(0);
		expect(result.clippedCues).toBe(1);
		expect(result.keptCues).toBe(1);
		// clipped source [25,30) -> output [25,30) (nothing removed before it yet)
		expect(result.vtt).toContain("00:00:25.000 --> 00:00:30.000");
		expect(result.vtt).toContain("straddles");
	});

	it("clips a cue that straddles the other cut boundary (starts in removed span, ends after)", () => {
		// Cue spans 55..65 — only the [60,65) part survives.
		const vtt = `WEBVTT\n\n${cue("00:00:55.000", "00:01:05.000", "second half")}\n\n`;
		const result = remapVttCuesForEdit(vtt, TRIM_MIDDLE);

		expect(result.clippedCues).toBe(1);
		expect(result.keptCues).toBe(1);
		// clipped source [60,65) -> output [30,35) (30s removed before it)
		expect(result.vtt).toContain("00:00:30.000 --> 00:00:35.000");
	});

	it("handles multiple cues: kept, dropped, and clipped together", () => {
		const vtt = [
			"WEBVTT",
			"",
			cue("00:00:05.000", "00:00:10.000", "one"),
			"",
			cue("00:00:35.000", "00:00:40.000", "two (dropped)"),
			"",
			cue("00:00:25.000", "00:00:35.000", "three (clipped)"),
			"",
			cue("00:01:10.000", "00:01:15.000", "four"),
			"",
		].join("\n");

		const result = remapVttCuesForEdit(vtt, TRIM_MIDDLE);

		expect(result.totalCues).toBe(4);
		expect(result.droppedCues).toBe(1);
		expect(result.clippedCues).toBe(1);
		expect(result.keptCues).toBe(3);
		expect(result.vtt).toContain("one");
		expect(result.vtt).not.toContain("two (dropped)");
		expect(result.vtt).toContain("three (clipped)");
		expect(result.vtt).toContain("four");
	});

	it("preserves cue-settings text after the timing line", () => {
		const vtt = `WEBVTT\n\n00:00:05.000 --> 00:00:10.000 align:start position:0%\nhello\n\n`;
		const result = remapVttCuesForEdit(vtt, TRIM_MIDDLE);

		expect(result.vtt).toContain("align:start position:0%");
	});

	it("returns an empty-but-valid VTT when every cue is dropped", () => {
		const vtt = `WEBVTT\n\n${cue("00:00:31.000", "00:00:59.000", "all gone")}\n\n`;
		const result = remapVttCuesForEdit(vtt, TRIM_MIDDLE);

		expect(result.vtt).toBe("WEBVTT\n\n");
	});
});

describe("remapTimePoints", () => {
	it("maps every point that survives the trim", () => {
		const result = remapTimePoints([5, 90], TRIM_MIDDLE);
		expect(result.clean).toBe(true);
		expect(result.times).toEqual([5, 60]);
	});

	it("is unclean when any point falls inside a removed span", () => {
		const result = remapTimePoints([5, 45, 90], TRIM_MIDDLE);
		expect(result.clean).toBe(false);
		expect(result.times).toEqual([]);
	});

	it("is trivially clean for an empty list", () => {
		expect(remapTimePoints([], TRIM_MIDDLE)).toEqual({ times: [], clean: true });
	});
});

describe("remapChaptersByStartSec", () => {
	it("remaps chapters that all survive the trim", () => {
		const chapters = [
			{ startSec: 5, title: "Intro", body: "..." },
			{ startSec: 90, title: "Outro", body: "..." },
		];
		const result = remapChaptersByStartSec(chapters, TRIM_MIDDLE);
		expect(result.clean).toBe(true);
		expect(result.chapters?.map((c) => c.startSec)).toEqual([5, 60]);
		expect(result.chapters?.[0]?.title).toBe("Intro");
	});

	it("drops the whole set when one chapter's start was cut out", () => {
		const chapters = [
			{ startSec: 5, title: "Intro", body: "..." },
			{ startSec: 45, title: "Cut out", body: "..." },
		];
		const result = remapChaptersByStartSec(chapters, TRIM_MIDDLE);
		expect(result.clean).toBe(false);
		expect(result.chapters).toBeUndefined();
	});

	it("passes through undefined/empty unchanged", () => {
		expect(remapChaptersByStartSec(undefined, TRIM_MIDDLE)).toEqual({
			chapters: undefined,
			clean: true,
		});
		expect(remapChaptersByStartSec([], TRIM_MIDDLE)).toEqual({
			chapters: [],
			clean: true,
		});
	});
});

describe("remapChaptersByStart", () => {
	it("remaps the legacy {title,start} chapter shape", () => {
		const chapters = [{ title: "A", start: 90 }];
		const result = remapChaptersByStart(chapters, TRIM_MIDDLE);
		expect(result.clean).toBe(true);
		expect(result.chapters).toEqual([{ title: "A", start: 60 }]);
	});

	it("drops when the start falls in a removed span", () => {
		const chapters = [{ title: "A", start: 45 }];
		const result = remapChaptersByStart(chapters, TRIM_MIDDLE);
		expect(result.clean).toBe(false);
		expect(result.chapters).toBeUndefined();
	});
});
