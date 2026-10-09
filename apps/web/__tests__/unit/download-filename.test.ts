import { describe, expect, it } from "vitest";
import {
	downloadFilename,
	downloadFilenameBase,
} from "@/lib/download-filename";

// Why this file exists: every download in the product used to name its file
// independently. The video download hand-rolled an ASCII-only regex inline, and
// the transcript download did not try at all — it wrote the literal
// "transcript.txt" for every recording, so five meetings produced five identical
// filenames. These tests pin the ONE helper they now share.

describe("downloadFilenameBase", () => {
	it("keeps a normal Uzbek title readable", () => {
		// The real titles in this product are Uzbek. An ASCII-only sanitiser would
		// have mangled these, which is the bug this test exists to prevent.
		expect(downloadFilenameBase("Jahon School CRM Optimallashtirish")).toBe(
			"Jahon School CRM Optimallashtirish",
		);
		expect(downloadFilenameBase("Bunyod & Aman agency deal")).toBe(
			"Bunyod _ Aman agency deal",
		);
	});

	it("keeps non-Latin scripts instead of erasing them", () => {
		// \w is ASCII-only; a Cyrillic title under that rule becomes underscores.
		expect(downloadFilenameBase("Йиғилиш 2026")).toBe("Йиғилиш 2026");
	});

	it("cannot escape a filename position", () => {
		// The title is user-editable, so it is untrusted input.
		expect(downloadFilenameBase("../../etc/passwd")).not.toContain("/");
		expect(downloadFilenameBase("../../etc/passwd")).not.toMatch(/^\./);
		expect(downloadFilenameBase("C:\\Windows\\system32")).not.toContain("\\");
		expect(downloadFilenameBase("....")).toBe("recording");
	});

	it("falls back rather than producing an empty or dot-only name", () => {
		expect(downloadFilenameBase("")).toBe("recording");
		expect(downloadFilenameBase(null)).toBe("recording");
		expect(downloadFilenameBase(undefined)).toBe("recording");
		expect(downloadFilenameBase("///")).toBe("recording");
		// An emoji-only title sanitises to nothing; it must not yield ".mp3".
		expect(downloadFilenameBase("🎉🎉")).toBe("recording");
	});

	it("bounds the length and never ends on a separator", () => {
		const long = "a".repeat(500);
		const base = downloadFilenameBase(long);
		expect(base.length).toBeLessThanOrEqual(80);
		expect(base).not.toMatch(/[._\s]$/);
		// A title whose 80th character lands on a space must not keep it.
		expect(downloadFilenameBase(`${"b".repeat(79)} tail`)).not.toMatch(/\s$/);
	});

	it("collapses runs of replaced characters into one underscore", () => {
		expect(downloadFilenameBase("a???b")).toBe("a_b");
	});
});

describe("downloadFilename", () => {
	it("appends the extension it was given", () => {
		expect(downloadFilename("Meeting one", "mp3")).toBe("Meeting one.mp3");
		expect(downloadFilename("Meeting one", "txt")).toBe("Meeting one.txt");
		expect(downloadFilename("Meeting one", "srt")).toBe("Meeting one.srt");
	});

	it("gives two DIFFERENT recordings two different filenames", () => {
		// The whole point: transcripts used to collide on "transcript.txt".
		expect(downloadFilename("Meeting one", "txt")).not.toBe(
			downloadFilename("Meeting two", "txt"),
		);
	});
});
