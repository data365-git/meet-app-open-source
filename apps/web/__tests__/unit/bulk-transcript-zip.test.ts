/**
 * Bulk transcript ZIP (2026-10-07 spec): the pure helpers in
 * lib/bulk-transcript-zip.ts — file-name sanitizing (illegal chars, control
 * chars, whitespace collapse, 120-char ceiling, empty -> "nomsiz"), the
 * "a.txt / a (2).txt / a (3).txt" de-duplication, and the missing-transcript
 * note builder (missing vs. failed under separate headings, null when
 * nothing to report).
 */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import {
	buildBulkTranscriptZip,
	buildMissingNote,
	dedupeFileNames,
	fetchBulkTranscripts,
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

/** A fetch Response stand-in with just the fields fetchBulkTranscripts reads. */
const makeResponse = (overrides: {
	status?: number;
	ok?: boolean;
	redirected?: boolean;
	contentType?: string | null;
	text?: string;
} = {}) => {
	const status = overrides.status ?? 200;
	return {
		status,
		ok: overrides.ok ?? (status >= 200 && status < 300),
		redirected: overrides.redirected ?? false,
		headers: new Headers({
			...(overrides.contentType !== null
				? { "content-type": overrides.contentType ?? "text/plain; charset=utf-8" }
				: {}),
		}),
		text: async () => overrides.text ?? "TRANSCRIPT",
	} as unknown as Response;
};

describe("fetchBulkTranscripts", () => {
	it("saves a plain 200 text/plain transcript and reports progress", async () => {
		const signals: (RequestInit["signal"] | undefined)[] = [];
		const results = await fetchBulkTranscripts(
			[{ id: "v1", name: "Dars 1" }],
			undefined,
			async (_input, init) => {
				signals.push(init?.signal);
				return makeResponse({ text: "SALOM" });
			},
		);
		expect(results.files).toEqual([{ name: "Dars 1", text: "SALOM" }]);
		expect(results.missing).toEqual([]);
		expect(results.failed).toEqual([]);
		// Per-request timeout signal is wired through (fix 2).
		expect(signals[0]).toBeInstanceOf(AbortSignal);
	});

	it("counts an aborted/timed-out fetch as failed, not as a crash", async () => {
		const results = await fetchBulkTranscripts(
			[{ id: "v1", name: "Sekin video" }],
			undefined,
			async () => {
				throw new DOMException("signal timed out", "TimeoutError");
			},
		);
		expect(results.failed).toEqual(["Sekin video"]);
		expect(results.files).toEqual([]);
	});

	it("counts a redirected 200 (e.g. a login page) as failed", async () => {
		const results = await fetchBulkTranscripts(
			[{ id: "v1", name: "Yo'naltirilgan" }],
			undefined,
			async () =>
				makeResponse({ redirected: true, contentType: "text/plain" }),
		);
		expect(results.failed).toEqual(["Yo'naltirilgan"]);
		expect(results.files).toEqual([]);
	});

	it("counts a 200 with a text/html body as failed", async () => {
		const results = await fetchBulkTranscripts(
			[{ id: "v1", name: "HTML qaytargan" }],
			undefined,
			async () =>
				makeResponse({ contentType: "text/html; charset=utf-8", text: "<html>" }),
		);
		expect(results.failed).toEqual(["HTML qaytargan"]);
		expect(results.files).toEqual([]);
	});

	it("keeps 404 as missing and other statuses as failed", async () => {
		const missing = await fetchBulkTranscripts(
			[{ id: "v1", name: "Yo'q" }],
			undefined,
			async () => makeResponse({ status: 404 }),
		);
		expect(missing.missing).toEqual(["Yo'q"]);

		const failed = await fetchBulkTranscripts(
			[{ id: "v1", name: "Xato" }],
			undefined,
			async () => makeResponse({ status: 500 }),
		);
		expect(failed.failed).toEqual(["Xato"]);
	});
});

describe("buildBulkTranscriptZip", () => {
	const readZip = async (blob: Blob) =>
		JSZip.loadAsync(await blob.arrayBuffer());

	it("renames a video literally called transkript-yoq when the note is written (fix 4)", async () => {
		const blob = await buildBulkTranscriptZip({
			files: [
				{ name: "transkript-yoq", text: "VIDEO TEXT" },
				{ name: "Ikkinchi", text: "B" },
			],
			missing: ["Yo'q video"],
			failed: [],
		});
		expect(blob).not.toBeNull();
		const zip = await readZip(blob as Blob);
		// The note keeps the plain name; the colliding video gets " (2)".
		expect(await zip.file("transkript-yoq.txt")?.async("string")).toContain(
			"Yo'q video",
		);
		expect(await zip.file("transkript-yoq (2).txt")?.async("string")).toBe(
			"VIDEO TEXT",
		);
		expect(await zip.file("Ikkinchi.txt")?.async("string")).toBe("B");
	});

	it("keeps the plain transkript-yoq.txt name when no note is written", async () => {
		const blob = await buildBulkTranscriptZip({
			files: [{ name: "transkript-yoq", text: "VIDEO TEXT" }],
			missing: [],
			failed: [],
		});
		expect(blob).not.toBeNull();
		const zip = await readZip(blob as Blob);
		expect(await zip.file("transkript-yoq.txt")?.async("string")).toBe(
			"VIDEO TEXT",
		);
		expect(zip.file("transkript-yoq (2).txt")).toBeNull();
	});
});
