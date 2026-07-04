import { describe, expect, it } from "vitest";
import { stripRunawayRepetition } from "@/lib/gemini-transcribe";

describe("stripRunawayRepetition", () => {
	it("leaves a normal transcript untouched", () => {
		const text = [
			"00:00:01.000 --> 00:00:03.000",
			"Salom, bugun darsni boshlaymiz.",
			"00:00:03.000 --> 00:00:06.000",
			"Birinchi mavzu — o'zgaruvchilar.",
		].join("\n");
		const out = stripRunawayRepetition(text);
		expect(out.runaway).toBe(false);
		expect(out.text).toBe(text);
	});

	it("does not flag a short phrase repeated a few (<=12) times", () => {
		const lines: string[] = [];
		for (let i = 0; i < 10; i++) lines.push("Rahmat, davom etamiz.");
		const text = lines.join("\n");
		const out = stripRunawayRepetition(text);
		expect(out.runaway).toBe(false);
		expect(out.text).toBe(text);
	});

	it("truncates a repetition-loop runaway, keeping the clean prefix", () => {
		const clean = [
			"Kirish qismi tugadi.",
			"Endi amaliy misolga o'tamiz.",
		];
		const garbage: string[] = [];
		for (let i = 0; i < 40; i++) garbage.push("va shuning uchun ham albatta");
		const text = [...clean, ...garbage].join("\n");
		const out = stripRunawayRepetition(text);
		expect(out.runaway).toBe(true);
		// clean prefix preserved
		expect(out.text).toContain("Endi amaliy misolga o'tamiz.");
		// garbage tail dropped: the repeated line survives at most twice (cut at 3rd)
		const repeats = out.text
			.split("\n")
			.filter((l) => l.trim() === "va shuning uchun ham albatta").length;
		expect(repeats).toBeLessThanOrEqual(2);
	});

	it("ignores repeated timestamp lines (only real text triggers the guard)", () => {
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) {
			lines.push("00:00:00.000 --> 00:00:02.000");
			lines.push(`Gap ${i}.`);
		}
		const out = stripRunawayRepetition(lines.join("\n"));
		expect(out.runaway).toBe(false);
	});
});
