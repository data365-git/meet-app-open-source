import { describe, expect, it } from "vitest";
import {
	buildTranscriptionPrompt,
	extractSpeakerLabels,
} from "../../lib/gemini-transcribe";

describe("extractSpeakerLabels", () => {
	it("collects unique real names from voice tags", () => {
		const vtt = [
			"WEBVTT",
			"",
			"1",
			"00:00:01.000 --> 00:00:04.000",
			"<v Alisher>Assalomu alaykum</v>",
			"",
			"2",
			"00:00:05.000 --> 00:00:08.000",
			"<v Dilnoza>Va alaykum assalom</v>",
			"",
			"3",
			"00:00:09.000 --> 00:00:12.000",
			"<v Alisher>Boshlaymizmi?</v>",
			"",
		].join("\n");
		expect(extractSpeakerLabels(vtt)).toEqual(["Alisher", "Dilnoza"]);
	});

	it("filters out generic numbered labels and 'Boshqa ovoz'", () => {
		const vtt = [
			"WEBVTT",
			"",
			"1",
			"00:00:01.000 --> 00:00:04.000",
			"<v Spiker 1>Salom</v>",
			"",
			"2",
			"00:00:05.000 --> 00:00:08.000",
			"<v Speaker 2>Hello</v>",
			"",
			"3",
			"00:00:09.000 --> 00:00:12.000",
			"<v Спикер 3>Привет</v>",
			"",
			"4",
			"00:00:13.000 --> 00:00:16.000",
			"<v Boshqa ovoz>...</v>",
			"",
			"5",
			"00:00:17.000 --> 00:00:20.000",
			"<v Alisher>Men keldim</v>",
			"",
		].join("\n");
		expect(extractSpeakerLabels(vtt)).toEqual(["Alisher"]);
	});

	it("returns [] for a VTT without voice tags", () => {
		expect(extractSpeakerLabels("WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nplain\n\n")).toEqual([]);
	});
});

describe("buildTranscriptionPrompt speaker rules", () => {
	it("actively asks for name identification and Spiker fallback", () => {
		const prompt = buildTranscriptionPrompt();
		expect(prompt).toContain("ACTIVELY listen for speaker NAMES");
		expect(prompt).toContain("Spiker 1");
	});

	it("includes the roster block only when knownSpeakers is provided", () => {
		const without = buildTranscriptionPrompt();
		expect(without).not.toContain("Known speakers identified earlier");
		const withRoster = buildTranscriptionPrompt({
			knownSpeakers: ["Alisher", "Dilnoza"],
		});
		expect(withRoster).toContain("Known speakers identified earlier");
		expect(withRoster).toContain("Alisher, Dilnoza");
	});
});
