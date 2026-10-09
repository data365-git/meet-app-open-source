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

	// Regression (owner's real 2:47 recording, 2026-07-29): Gemini looped THREE
	// sentences in rotation on sparse audio — no single line reached 12, so the
	// single-line rule stored the whole fabricated transcript, the summary was
	// built on it, and the inflated output made the tiny video cost 10× normal.
	it("cuts a CYCLING loop of several sentences none of which reaches 12", () => {
		const real = [
			"00:00:00.000 --> 00:00:04.500",
			"Xo'sh, demak, shrift bo'yicha gaplashayotgan edik.",
			"00:00:04.500 --> 00:00:08.500",
			"O'shandan beri mana shu interface'da turibmiz.",
		];
		const cycle: string[] = [];
		const a = "Xo'sh, demak, ko'rib gapirsak, mijoz ovozi yozilyapti deb umid qilamiz.";
		const b = "Shuning uchun ham hozir mana shu interface'da turibmiz.";
		const c = "Hozir mana bu yerda test-lar ketyapti.";
		for (let i = 0; i < 6; i++) {
			cycle.push("00:00:10.000 --> 00:00:14.000", a);
			cycle.push("00:00:14.000 --> 00:00:18.000", b);
			cycle.push("00:00:18.000 --> 00:00:22.000", c);
		}
		const out = stripRunawayRepetition([...real, ...cycle].join("\n"));
		expect(out.runaway).toBe(true);
		// the real opening survives
		expect(out.text).toContain("shrift bo'yicha gaplashayotgan edik");
		// the cycle is cut: each looped line survives at most twice
		for (const line of [a, b, c]) {
			const n = out.text.split("\n").filter((l) => l.trim() === line).length;
			expect(n).toBeLessThanOrEqual(2);
		}
	});

	it("keeps a real meeting where backchannel repeats are SPREAD OUT (measured clean shape)", () => {
		// Mirrors the three real meetings measured 2026-07-29: dup ratio 1-5%,
		// "Mhm."-style lines repeat 3× but the remainder is new content.
		const lines: string[] = [];
		for (let i = 0; i < 30; i++) {
			lines.push(`00:00:0${i % 10}.000 --> 00:00:0${(i % 10) + 1}.000`);
			lines.push(
				i % 10 === 0
					? "Mhm, tushunarli, davom etamiz."
					: `Bu yerda ${i}-mavzu haqida butunlay boshqa gap ketyapti.`,
			);
		}
		const out = stripRunawayRepetition(lines.join("\n"));
		expect(out.runaway).toBe(false);
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
