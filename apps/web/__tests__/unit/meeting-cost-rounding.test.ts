import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatUzs } from "@/lib/format-uzs";

/**
 * Owner-reported 2026-08-16, from a screenshot of the share page's cost panel:
 * the two non-zero cards read 903 so'm and 903 so'm while the headline total
 * read 1 935 so'm. The parts summed to LESS than the whole, which reads as a
 * broken price — his words: "quyidagi 2 narxni qo'shsang yuqoridagi narxdan
 * kichik-ku".
 *
 * The numbers below are the REAL micros for that video (kc45xjnar36v9gg), read
 * from ai_usage_events in production — not invented for the test. The old code
 * rounded each operation to a whole cent inside get-monthly-spend, and one cent
 * is ~129 so'm at the display rate, so both cards rounded DOWN (7.36c and 7.16c
 * → 7c) while the independently-rounded total rounded UP (14.52c → 15c).
 *
 * The invariant this pins is the one the owner can see: the cards must add up
 * to the headline. Rounding therefore happens exactly once, in formatUzs.
 */
const TRANSCRIPTION_MICROS = 73_643;
const SUMMARY_MICROS = 71_592;
const TOTAL_MICROS = TRANSCRIPTION_MICROS + SUMMARY_MICROS; // 145_235

/** What get-monthly-spend now returns: fractional cents, unrounded. */
const toCents = (micros: number) => micros / 10_000;

/** The so'm number a reader actually sees on a card. */
const somOf = (label: string) => Number(label.replace(/[^\d]/g, ""));

describe("meeting cost panel — the parts must add up to the whole", () => {
	it("card values sum to the headline total (the owner's exact case)", () => {
		const transcription = somOf(formatUzs(toCents(TRANSCRIPTION_MICROS)));
		const summary = somOf(formatUzs(toCents(SUMMARY_MICROS)));
		const total = somOf(formatUzs(toCents(TOTAL_MICROS)));

		expect(transcription + summary).toBe(total);
	});

	it("REGRESSION: pre-rounding each operation to a whole cent breaks the sum", () => {
		// This is the OLD behaviour, kept as an executable description of the bug:
		// it must NOT hold any more, and it reproduces his 903 / 903 / 1935 exactly.
		const oldCard = (micros: number) => somOf(formatUzs(Math.round(micros / 10_000)));
		const oldTotal = somOf(formatUzs(Math.round(TOTAL_MICROS / 10_000)));

		expect(oldCard(TRANSCRIPTION_MICROS)).toBe(903);
		expect(oldCard(SUMMARY_MICROS)).toBe(903);
		expect(oldTotal).toBe(1935);
		expect(oldCard(TRANSCRIPTION_MICROS) + oldCard(SUMMARY_MICROS)).not.toBe(
			oldTotal,
		);
	});

	// The two tests above pin the ARITHMETIC, but their inputs are authored here
	// at the test boundary — which is exactly the shape of pin that let earlier
	// defects through in this repo. This one pins the actual source: the fix is
	// "do not round inside get-monthly-spend", so the guard is that the rounding
	// does not come back. formatUzs stays the single rounding point.
	it("get-monthly-spend does not pre-round micros into whole cents", () => {
		const src = readFileSync(
			join(process.cwd(), "actions/billing/get-monthly-spend.ts"),
			"utf8",
		);
		const offenders = src
			.split("\n")
			.map((line, i) => ({ line: line.trim(), n: i + 1 }))
			.filter(
				({ line }) =>
					!line.startsWith("//") &&
					!line.startsWith("*") &&
					/Math\.round\s*\([^)]*10_000/.test(line),
			);
		expect(
			offenders,
			`rounding to whole cents reappeared — one cent is ~129 so'm, so this makes the cost cards stop adding up to the total (see the header of this file). Offending line(s): ${offenders
				.map((o) => `${o.n}: ${o.line}`)
				.join(" | ")}`,
		).toEqual([]);
	});

	it("holds for a spread of amounts, not just the reported one", () => {
		const cases: Array<number[]> = [
			[1, 1, 1],
			[9_999, 10_001],
			[73_643, 71_592, 4_612, 87],
			[500_000, 250_000, 125_000],
			[3, 0, 0, 0],
		];
		for (const parts of cases) {
			const sumOfCards = parts.reduce(
				(acc, micros) => acc + somOf(formatUzs(toCents(micros))),
				0,
			);
			const whole = somOf(
				formatUzs(toCents(parts.reduce((a, b) => a + b, 0))),
			);
			// Each card is rounded to a whole so'm, so N cards can drift by at most
			// N/2 so'm from the whole. What must never happen again is a gap of a
			// whole CENT (~129 so'm), which is what pre-rounding produced.
			expect(Math.abs(sumOfCards - whole)).toBeLessThanOrEqual(parts.length);
		}
	});
});
