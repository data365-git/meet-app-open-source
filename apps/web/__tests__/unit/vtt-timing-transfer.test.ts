import { describe, expect, it } from "vitest";
import {
	copyCueTimingsByIndex,
	type ScribeWord,
	transferVttTiming,
} from "@/lib/vtt-timing-transfer";

function ts(sec: number): string {
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	const s = sec % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

function vttFromCueWords(cues: string[][], starts?: number[]): string {
	let out = "WEBVTT\n\n";
	cues.forEach((cueWords, i) => {
		const start = starts?.[i] ?? i * 2;
		out += `${i + 1}\n${ts(start)} --> ${ts(start + 1.5)}\n${cueWords.join(" ")}\n\n`;
	});
	return out;
}

function cueStarts(vtt: string): number[] {
	return vtt
		.split(/\r?\n/)
		.filter((line) => line.includes("-->"))
		.map((line) => {
			const [start] = line.split("-->");
			return parseTs(start ?? "");
		});
}

function parseTs(value: string): number {
	const [h, m, s] = value.trim().split(":");
	return Number(h) * 3600 + Number(m) * 60 + Number.parseFloat(s ?? "0");
}

function words(count: number, offset = 0): string[] {
	return Array.from({ length: count }, (_, i) =>
		`w${String(i + offset).padStart(4, "0")}`,
	);
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

function scribeWordsForCues(
	cues: string[][],
	cueStart: (cueIdx: number) => number,
): ScribeWord[] {
	const out: ScribeWord[] = [];
	cues.forEach((cueWords, cueIdx) => {
		cueWords.forEach((word, wordIdx) => {
			const start = cueStart(cueIdx) + wordIdx * 0.4;
			out.push({ word, start, end: start + 0.25 });
		});
	});
	return out;
}

describe("transferVttTiming", () => {
	it("recovers synthetic drift from Scribe word times", () => {
		const cues = chunk(words(48), 4);
		const original = vttFromCueWords(cues, cues.map((_, i) => i * 2));
		const scribe = scribeWordsForCues(cues, (i) => 12 + i * 8);

		const corrected = transferVttTiming(original, scribe);
		const starts = cueStarts(corrected);

		expect(starts[0]).toBeCloseTo(12, 1);
		expect(starts[5]).toBeCloseTo(52, 1);
		expect(starts[10]).toBeCloseTo(92, 1);
	});

	it("rejects a dense outlier match that deviates from skeleton interpolation", () => {
		const geminiWords = [
			...words(12),
			"lef01",
			"rogue",
			"rig01",
			...words(12, 12),
		];
		const scribeSequence = [
			...words(12),
			"alt01",
			"rogue",
			"alt02",
			...words(12, 12),
		];
		const cues = geminiWords.map((word) => [word]);
		const original = vttFromCueWords(cues, cues.map((_, i) => i));
		const scribe = scribeSequence.map((word, i) => ({
			word,
			start: word === "rogue" ? 100 : i,
			end: word === "rogue" ? 100.2 : i + 0.2,
		}));

		const corrected = transferVttTiming(original, scribe);
		const starts = cueStarts(corrected);
		const rogueStart = starts[13] ?? 0;

		expect(Math.abs(rogueStart - 100)).toBeGreaterThan(20);
	});

	it("enforces monotonic cue starts even when matched word times move backward", () => {
		const cues = chunk(words(36), 3);
		const original = vttFromCueWords(cues);
		const startsByCue = [0, 5, 10, 8, 20, 25, 30, 35, 40, 45, 50, 55];
		const scribe = scribeWordsForCues(cues, (i) => startsByCue[i] ?? i * 5);

		const corrected = transferVttTiming(original, scribe);
		const starts = cueStarts(corrected);

		for (let i = 1; i < starts.length; i++) {
			expect(starts[i]).toBeGreaterThanOrEqual(starts[i - 1] ?? 0);
		}
	});

	it("interpolates timing for cues with no matched words", () => {
		const cues = chunk(words(48), 4);
		const original = vttFromCueWords(cues, cues.map(() => 0));
		const scribe = scribeWordsForCues(cues, (i) => 10 + i * 6).filter(
			(word) => !cues[5]?.includes(word.word),
		);

		const corrected = transferVttTiming(original, scribe);
		const starts = cueStarts(corrected);

		expect(starts[5]).toBeGreaterThan(starts[4] ?? 0);
		expect(starts[5]).toBeLessThan(starts[6] ?? Number.POSITIVE_INFINITY);
		expect(starts[5]).toBeCloseTo(37.4, 1);
	});

	it("returns the input unchanged when there are too few skeleton anchors", () => {
		const cues = chunk(words(9), 3);
		const original = vttFromCueWords(cues);
		const scribe = scribeWordsForCues(cues, (i) => 30 + i * 5);

		expect(transferVttTiming(original, scribe)).toBe(original);
	});
});

describe("copyCueTimingsByIndex", () => {
	it("copies only cue times and preserves translated text", () => {
		const corrected =
			"WEBVTT\n\n00:00:05.000 --> 00:00:07.000\nSalom\n\n00:00:09.000 --> 00:00:10.000\nDunyo\n";
		const translated =
			"WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello\n\n00:00:02.000 --> 00:00:04.000\nWorld\n";

		const result = copyCueTimingsByIndex(corrected, translated);

		expect(result).toContain("00:00:05.000 --> 00:00:07.000\nHello");
		expect(result).toContain("00:00:09.000 --> 00:00:10.000\nWorld");
	});

	it("refuses to rewrite when cue counts differ", () => {
		const corrected =
			"WEBVTT\n\n00:00:05.000 --> 00:00:07.000\nSalom\n";
		const translated =
			"WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nHello\n\n00:00:02.000 --> 00:00:04.000\nWorld\n";

		expect(copyCueTimingsByIndex(corrected, translated)).toBeNull();
	});
});
