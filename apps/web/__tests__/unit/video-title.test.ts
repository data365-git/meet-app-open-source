import { describe, expect, it } from "vitest";
import { titleFromFileName } from "@/lib/video-title";

// An uploaded recording used to be titled from a template ("data365 Upload -
// <date>"), discarding the name of the file the owner had just picked. These
// tests pin the replacement — including the two ways the sanitising line got
// silently mangled while it was being written.

describe("titleFromFileName", () => {
	it("uses the file's own name, without the extension", () => {
		expect(titleFromFileName("Bitrix24 meeting.mp4")).toBe("Bitrix24 meeting");
		expect(titleFromFileName("Jahon School CRM.mov")).toBe("Jahon School CRM");
	});

	it("KEEPS the spaces", () => {
		// Regression guard: one mangled edit of this helper collapsed the class to
		// a range that deleted spaces, which would have produced "Bitrix24meeting"
		// — plausible-looking output that nobody would have questioned.
		expect(titleFromFileName("two words.mp4")).toBe("two words");
		expect(titleFromFileName("a b c d.mp4")).toBe("a b c d");
	});

	it("strips any path, on both separators", () => {
		// A Windows browser can send a full path; a crafted one must not become
		// part of the title.
		expect(titleFromFileName("C:\\Users\\me\\meeting.mp4")).toBe("meeting");
		expect(titleFromFileName("/var/tmp/meeting.mp4")).toBe("meeting");
		expect(titleFromFileName("../../etc/passwd.mp4")).toBe("passwd");
		expect(titleFromFileName("C:\\Users\\me\\meeting.mp4")).not.toContain("\\");
	});

	it("keeps non-Latin titles intact", () => {
		expect(titleFromFileName("Йиғилиш 2026.mp4")).toBe("Йиғилиш 2026");
		expect(titleFromFileName("Uchrashuv — mijoz bilan.mp4")).toBe(
			"Uchrashuv — mijoz bilan",
		);
	});

	it("returns null when there is nothing usable, so the caller can fall back", () => {
		expect(titleFromFileName(undefined)).toBeNull();
		expect(titleFromFileName("")).toBeNull();
		expect(titleFromFileName("   ")).toBeNull();
		// A name that is only an extension leaves an empty stem.
		expect(titleFromFileName(".mp4")).toBeNull();
	});

	it("bounds the length", () => {
		const long = `${"x".repeat(500)}.mp4`;
		expect((titleFromFileName(long) ?? "").length).toBeLessThanOrEqual(120);
	});

	it("removes control characters but nothing else", () => {
		expect(titleFromFileName("meet\u0000ing.mp4")).toBe("meeting");
		expect(titleFromFileName("tab\ttitle.mp4")).toBe("tabtitle");
	});
});
