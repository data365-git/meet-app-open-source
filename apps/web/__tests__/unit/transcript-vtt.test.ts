import { describe, expect, it } from "vitest";
import {
	normalizeWebVttVoiceText,
	normalizeTranscriptCueText,
	stripRenderedVttTags,
	updateVttEntryText,
} from "@/lib/transcript-vtt";

const vtt = `WEBVTT

1
00:00:00.000 --> 00:00:02.959
To bulk import Loom videos via CSV.

2
00:00:03.199 --> 00:00:05.359
So you can drag and drop the template
across multiple payload lines

3
00:00:05.359 --> 00:00:06.080
into,`;

describe("normalizeTranscriptCueText", () => {
	it("collapses whitespace inside edited caption text", () => {
		expect(normalizeTranscriptCueText("  hello\n\nthere\tfriend  ")).toBe(
			"hello there friend",
		);
	});
});

describe("normalizeWebVttVoiceText", () => {
	it("extracts a single speaker voice tag", () => {
		expect(normalizeWebVttVoiceText("<v Speaker 1>Salom.</v>")).toEqual({
			speaker: "Speaker 1",
			text: "Salom.",
		});
	});

	it("turns multiple inline speaker voice tags into readable text", () => {
		const normalized = normalizeWebVttVoiceText(
			"<v Speaker 1>Ha.</v> <v Speaker 2>Qarang",
		);

		expect(normalized.speaker).toBeNull();
		expect(normalized.text).toBe("Speaker 1: Ha. Speaker 2: Qarang");
		expect(normalized.text).not.toContain("</v>");
		expect(normalized.text).not.toContain("<v");
	});

	// Orphan `</v>` cases — an opening voice tag lost across a cue/chunk boundary
	// (or malformed Gemini output) leaves a lone closing tag that must never leak.
	it("strips a lone trailing </v> with no opening tag (the screenshot case)", () => {
		const normalized = normalizeWebVttVoiceText(
			"Konkret muammoga keladigan bo'lsak, tannarxda muammo bo'ldi.</v>",
		);

		expect(normalized.speaker).toBeNull();
		expect(normalized.text).toBe(
			"Konkret muammoga keladigan bo'lsak, tannarxda muammo bo'ldi.",
		);
		expect(normalized.text).not.toContain("</v>");
	});

	it("strips a lone mid-text </v> orphan", () => {
		const normalized = normalizeWebVttVoiceText("Salom </v> dunyo");

		expect(normalized.text).toBe("Salom dunyo");
		expect(normalized.text).not.toContain("</v>");
	});

	it("still extracts the speaker from an unclosed <v Name> tag", () => {
		const normalized = normalizeWebVttVoiceText("<v Bunyodbek>Assalomu alaykum.");

		expect(normalized.speaker).toBe("Bunyodbek");
		expect(normalized.text).toBe("Assalomu alaykum.");
		expect(normalized.text).not.toContain("<v");
	});

	it("still extracts the speaker from a well-formed <v Name>text</v> pair", () => {
		const normalized = normalizeWebVttVoiceText("<v Alisher>Salom.</v>");

		expect(normalized.speaker).toBe("Alisher");
		expect(normalized.text).toBe("Salom.");
		expect(normalized.text).not.toContain("</v>");
	});

	it("leaves a legit '<' comparison in the text intact", () => {
		const normalized = normalizeWebVttVoiceText("Agar 5 < 10 bo'lsa, rost.");

		expect(normalized.speaker).toBeNull();
		expect(normalized.text).toBe("Agar 5 < 10 bo'lsa, rost.");
	});
});

describe("stripRenderedVttTags", () => {
	it("removes a lone trailing </v> orphan at the render boundary", () => {
		expect(stripRenderedVttTags("...muammo bo'ldi.</v>")).toBe(
			"...muammo bo'ldi.",
		);
	});

	it("removes orphan closings for c/i/b/u/lang/ruby including spaced/attributed variants", () => {
		expect(stripRenderedVttTags("a</v >b")).toBe("ab");
		expect(stripRenderedVttTags("a</lang>b")).toBe("ab");
		expect(stripRenderedVttTags("a</ruby>b")).toBe("ab");
		expect(stripRenderedVttTags("a</c.yellow>b")).toBe("ab");
		expect(stripRenderedVttTags("a<c.loud>b</c>")).toBe("ab");
	});

	it("does NOT touch a legit '<' comparison", () => {
		expect(stripRenderedVttTags("5 < 10 and x <y")).toBe("5 < 10 and x <y");
	});
});

describe("updateVttEntryText", () => {
	it("updates only the requested cue text without changing timings", () => {
		const result = updateVttEntryText(vtt, 1, "Updated first caption");

		expect(result.updated).toBe(true);
		expect(result.content).toContain(
			"1\n00:00:00.000 --> 00:00:02.959\nUpdated first caption",
		);
		expect(result.content).toContain(
			"2\n00:00:03.199 --> 00:00:05.359\nSo you can drag and drop the template\nacross multiple payload lines",
		);
	});

	it("replaces an existing multi-line cue payload as one sanitized caption", () => {
		const result = updateVttEntryText(
			vtt,
			2,
			"Replacement\ncaption\nwith pasted spacing",
		);

		expect(result.updated).toBe(true);
		expect(result.content).toContain(
			"2\n00:00:03.199 --> 00:00:05.359\nReplacement caption with pasted spacing",
		);
		expect(result.content).not.toContain("across multiple payload lines");
	});

	it("leaves the file unchanged when the cue id does not exist", () => {
		const result = updateVttEntryText(vtt, 99, "Missing caption");

		expect(result.updated).toBe(false);
		expect(result.content).toBe(vtt);
	});
});
