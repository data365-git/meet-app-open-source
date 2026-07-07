import { describe, expect, it } from "vitest";
import { getActiveRefinedChapterStartSec } from "@/app/s/[videoId]/_components/panels/RefinedTranscriptPanel";
import {
	getActiveTranscriptCueId,
	parseVTTCues,
} from "@/app/s/[videoId]/_components/panels/TranscriptPanel";

describe("transcript sync timestamps", () => {
	it("parses Gemini colon-ms cue times without drifting ahead of playback", () => {
		const cues = parseVTTCues(`WEBVTT

1
01:25:480 --> 01:28:180
Problem cue

2
00:07:540 --> 00:09:000
Opening cue
`);

		expect(cues[0]?.startSeconds).toBeCloseTo(85.48, 3);
		expect(cues[0]?.endSeconds).toBeCloseTo(88.18, 3);
		expect(cues[0]?.timestamp).toBe("01:25");
		expect(cues[1]?.startSeconds).toBeCloseTo(7.54, 3);
		expect(cues[1]?.endSeconds).toBeCloseTo(9, 3);
	});

	it("uses the latest active cue when cue ranges overlap", () => {
		const activeCueId = getActiveTranscriptCueId(
			[
				{ id: 1, startSeconds: 0, endSeconds: 600 },
				{ id: 2, startSeconds: 10, endSeconds: 12 },
			],
			11,
		);

		expect(activeCueId).toBe(2);
	});
});

describe("refined transcript sync timestamps", () => {
	it("compares normalized chapter times when choosing the active chapter", () => {
		const chapters = [
			{ startSec: 600 },
			{ startSec: 1200 },
			{ startSec: 1800 },
		];

		expect(getActiveRefinedChapterStartSec(chapters, 12, 120)).toBe(600);
		expect(getActiveRefinedChapterStartSec(chapters, 22, 120)).toBe(1200);
		expect(getActiveRefinedChapterStartSec(chapters, 35, 120)).toBe(1800);
	});
});
