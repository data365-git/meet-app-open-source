import { describe, expect, it } from "vitest";
import { restoreRussianScript } from "@/lib/restore-russian-script";

describe("restoreRussianScript", () => {
	it("converts romanized Russian words in a real-world mixed sentence", () => {
		const input =
			"Mobil dastur bo'ladimi, kompyuterda ishlaydimi, **vapshe** farqi yo'q, **lyuboy IT** tizimni qila olamiz.";
		const result = restoreRussianScript(input);
		expect(result).toContain("**вообще**");
		expect(result).toContain("**любой IT**");
		expect(result).not.toMatch(/\bvapshe\b/i);
		expect(result).not.toMatch(/\blyuboy\b/i);
	});

	it("converts a standalone bolded 'lyuboy' in a sentence", () => {
		const input = "tayyor, **lyuboy** IT kompaniya ishingizni bitira oladi.";
		const result = restoreRussianScript(input);
		expect(result).toContain("**любой**");
		expect(result).not.toMatch(/\blyuboy\b/i);
	});

	it("converts inside a voice tag line while leaving the tag intact", () => {
		const input = "<v Speaker 1>Xuddi **lyuboy** mebel olishga o'xshaydi.</v>";
		const result = restoreRussianScript(input);
		expect(result).toContain("<v Speaker 1>");
		expect(result).toContain("</v>");
		expect(result).toContain("**любой**");
		expect(result).not.toMatch(/\blyuboy\b/i);
	});

	it("converts 'srazu' while leaving surrounding Uzbek text untouched", () => {
		const result = restoreRussianScript("srazu boshlaymiz");
		expect(result).toBe("сразу boshlaymiz");
	});

	it("preserves title case", () => {
		expect(restoreRussianScript("Lyuboy odam")).toBe("Любой odam");
	});

	it("preserves all-caps", () => {
		expect(restoreRussianScript("LYUBOY")).toBe("ЛЮБОЙ");
	});

	it("does not touch the legitimate Uzbek word 'byudjet'", () => {
		expect(restoreRussianScript("byudjet")).toBe("byudjet");
	});

	it("does not produce a false hit on 'dengizga boramiz'", () => {
		expect(restoreRussianScript("dengizga boramiz")).toBe("dengizga boramiz");
	});

	it("does not touch accepted loanwords not in the dictionary (klient, dogovor)", () => {
		expect(restoreRussianScript("klient bilan dogovor")).toBe(
			"klient bilan dogovor",
		);
	});

	it("does not touch 'proyekt'", () => {
		expect(restoreRussianScript("proyekt")).toBe("proyekt");
	});

	it("leaves VTT structure byte-identical except for dictionary words", () => {
		const input = [
			"WEBVTT",
			"",
			"00:09:50.400 --> 00:09:55.200",
			"<v Speaker 1>Xuddi lyuboy mebel olishga o'xshaydi.</v>",
			"",
		].join("\n");
		const expected = [
			"WEBVTT",
			"",
			"00:09:50.400 --> 00:09:55.200",
			"<v Speaker 1>Xuddi любой mebel olishga o'xshaydi.</v>",
			"",
		].join("\n");
		expect(restoreRussianScript(input)).toBe(expected);
	});

	it("returns an empty string for an empty string", () => {
		expect(restoreRussianScript("")).toBe("");
	});
});
