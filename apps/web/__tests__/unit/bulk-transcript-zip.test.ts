/**
 * Bulk transcript ZIP (2026-10-07 spec): the pure helpers in
 * lib/bulk-transcript-zip.ts — file-name sanitizing (illegal chars, control
 * chars, whitespace collapse, 120-char ceiling, empty -> "nomsiz"), the
 * "a.txt / a (2).txt / a (3).txt" de-duplication, and the missing-transcript
 * note builder (missing vs. failed under separate headings, null when
 * nothing to report).
 */
import { describe, expect, it } from "vitest";

import {
	buildMissingNote,
	dedupeFileNames,
	sanitizeTranscriptFileName,
} from "@/lib/bulk-transcript-zip";

describe("sanitizeTranscriptFileName", () => {
	it("strips every character a Windows/macOS file name forbids", () => {
		expect(sanitizeTranscriptFileName('a/bc:d*e?f"g<h>i|j')).toBe("abcdefghij");
		expect(sanitizeTranscriptFileName("dars\\1")).toBe("dars1");
	});

	it("strips control characters", () => {
		expect(sanitizeTranscriptFileName("ab\u0000c\u001fd\u007fe")).toBe("abcde");
	});

	it("collapses whitespace runs to single spaces and trims", () => {
		expect(sanitizeTranscriptFileName("  a \t\n b   c  ")).toBe("a b c");
	});

	it("truncates to 120 characters", () => {
		expect(sanitizeTranscriptFileName("x".repeat(300))).toHaveLength(120);
	});

	it('falls back to "nomsiz" when nothing is left', () => {
		expect(sanitizeTranscriptFileName("??/***")).toBe("nomsiz");
		expect(sanitizeTranscriptFileName("   ")).toBe("nomsiz");
		expect(sanitizeTranscriptFileName("")).toBe("nomsiz");
	});

	it("keeps ordinary names (incl. dots and unicode) untouched", () => {
		expect(sanitizeTranscriptFileName("Yig'ilish 3 - Maslahat")).toBe(
			"Yig'ilish 3 - Maslahat",
		);
	});
});

describe("dedupeFileNames", () => {
	it("keeps unique names as-is", () => {
		expect(dedupeFileNames(["a.txt", "b.txt"])).toEqual(["a.txt", "b.txt"]);
	});

	it("numbers the 2nd, 3rd... occurrence before the extension", () => {
		expect(
			dedupeFileNames(["a.txt", "a.txt", "a.txt", "b.txt", "a.txt"]),
		).toEqual(["a.txt", "a (2).txt", "a (3).txt", "b.txt", "a (4).txt"]);
	});

	it("never collides with a name that legitimately ends in (2)", () => {
		expect(dedupeFileNames(["a.txt", "a.txt", "a (2).txt"])).toEqual([
			"a.txt",
			"a (2).txt",
			"a (3).txt",
		]);
	});

	it("handles names without an extension", () => {
		expect(dedupeFileNames(["a", "a"])).toEqual(["a", "a (2)"]);
	});

	it("returns an empty list for empty input", () => {
		expect(dedupeFileNames([])).toEqual([]);
	});
});

describe("buildMissingNote", () => {
	it("returns null when every transcript made it into the ZIP", () => {
		expect(buildMissingNote({ missing: [], failed: [] })).toBeNull();
	});

	it("lists each missing video on its own line under the yo'q heading", () => {
		const note = buildMissingNote({
			missing: ["Birinchi", "Ikkinchi"],
			failed: [],
		});
		expect(note).toContain("Birinchi");
		expect(note).toContain("Ikkinchi");
		expect(note).not.toContain("xato");
		expect(note).not.toContain("Xato");
		// one video per line, not one joined paragraph
		expect(note).toMatch(/Birinchi\n Ikkinchi|Birinchi\nIkkinchi/);
	});

	it("puts fetch failures under a separate xato heading", () => {
		const note = buildMissingNote({
			missing: ["Yo'q"],
			failed: ["Xato1"],
		});
		expect(note).toContain("Yo'q");
		expect(note).toMatch(/[Xx]ato/);
		expect(note).toContain("Xato1");
	});

	it("works with only failures", () => {
		const note = buildMissingNote({ missing: [], failed: ["A", "B"] });
		expect(note).toContain("A");
		expect(note).toContain("B");
		expect(note).toMatch(/[Xx]ato/);
	});
});
