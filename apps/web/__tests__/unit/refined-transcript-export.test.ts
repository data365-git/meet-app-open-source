import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
	buildRefinedTranscriptDocxBlob,
	buildRefinedTranscriptPlainText,
	DOCX_MIME_TYPE,
	splitMarkdownBoldRuns,
	stripMarkdownBold,
} from "@/lib/refined-transcript-export";

const chapters = () => [
	{
		startSec: 0,
		title: "Intro",
		paragraphs: [
			"Anvar: Assalomu alaykum, bugun **CRM rejasini** ko'rib chiqamiz.",
			"",
		],
	},
	{
		startSec: 90,
		title: "Next steps",
		paragraphs: [
			"Keyin **xarajatlar** va byudjet masalasi.",
			"Oddiy gap, urg'usiz.",
		],
	},
];

describe("stripMarkdownBold / splitMarkdownBoldRuns", () => {
	it("strips ** markers but keeps the text between them", () => {
		expect(stripMarkdownBold("a **b** c")).toBe("a b c");
		expect(stripMarkdownBold("no markers")).toBe("no markers");
	});

	it("splits into runs, marking only paired ** segments as bold", () => {
		expect(splitMarkdownBoldRuns("before **Key term** after")).toEqual([
			{ text: "before ", bold: false },
			{ text: "Key term", bold: true },
			{ text: " after", bold: false },
		]);
	});

	it("handles several bold spans in one paragraph", () => {
		expect(splitMarkdownBoldRuns("**a** mid **b**")).toEqual([
			{ text: "a", bold: true },
			{ text: " mid ", bold: false },
			{ text: "b", bold: true },
		]);
	});

	it("leaves an unpaired ** literal in BOTH exports, like the on-screen renderer", () => {
		// The reviewer caught this: the old stripMarkdownBold removed every `**`,
		// so .txt turned "a **b" into "a b" while .docx and the screen kept it
		// literal. One rule for all three surfaces.
		expect(stripMarkdownBold("a **b")).toBe("a **b");
		expect(splitMarkdownBoldRuns("a **b")).toEqual([
			{ text: "a **b", bold: false },
		]);
		expect(
			buildRefinedTranscriptPlainText({
				chapters: [{ startSec: 0, title: "C", paragraphs: ["a **b"] }],
			}),
		).toBe(["C", "", "a **b"].join("\n"));
	});

	it("leaves an unpaired * literal, exactly like the on-screen renderer", () => {
		expect(splitMarkdownBoldRuns("a * b")).toEqual([
			{ text: "a * b", bold: false },
		]);
	});
});

describe("buildRefinedTranscriptPlainText", () => {
	it("renders chapter titles as lines and paragraphs separated by blank lines", () => {
		expect(buildRefinedTranscriptPlainText({ chapters: chapters() })).toBe(
			[
				"Intro",
				"",
				"Anvar: Assalomu alaykum, bugun CRM rejasini ko'rib chiqamiz.",
				"",
				"Next steps",
				"",
				"Keyin xarajatlar va byudjet masalasi.",
				"",
				"Oddiy gap, urg'usiz.",
			].join("\n"),
		);
	});

	it("keeps speaker labels that already live in the paragraph text", () => {
		const text = buildRefinedTranscriptPlainText({
			chapters: [
				{ startSec: 0, title: "C", paragraphs: ["Dilnoza: kelishdik."] },
			],
		});
		expect(text).toContain("Dilnoza: kelishdik.");
	});

	it("adds no timestamps or time markers anywhere", () => {
		const text = buildRefinedTranscriptPlainText({
			chapters: [{ startSec: 3723, title: "C", paragraphs: ["body"] }],
		});
		expect(text).not.toMatch(/\d?\d:\d\d/);
		expect(text).not.toContain("3723");
	});

	it("drops empty paragraphs and empty chapter titles", () => {
		const text = buildRefinedTranscriptPlainText({
			chapters: [
				{ startSec: 0, title: "   ", paragraphs: ["", "   ", "kept"] },
			],
		});
		expect(text).toBe("kept");
	});

	it("returns an empty string when there is nothing exportable", () => {
		expect(buildRefinedTranscriptPlainText({ chapters: [] })).toBe("");
		expect(
			buildRefinedTranscriptPlainText({
				chapters: [{ startSec: 0, title: "", paragraphs: ["  "] }],
			}),
		).toBe("");
	});
});

// ---------------------------------------------------------------------------
// Minimal ZIP reader (central-directory walk + raw inflate), so the .docx
// tests assert the REAL word/document.xml bytes that get downloaded — using
// only node built-ins, no extra test dependency.
// ---------------------------------------------------------------------------
function extractZipEntry(zip: Buffer, name: string): Buffer {
	const SIG_CENTRAL = 0x02014b50;
	const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
	if (eocd === -1) throw new Error("ZIP: end-of-central-directory not found");
	const entryCount = zip.readUInt16LE(eocd + 10);
	let ptr = zip.readUInt32LE(eocd + 16);
	for (let i = 0; i < entryCount; i++) {
		if (zip.readUInt32LE(ptr) !== SIG_CENTRAL)
			throw new Error("ZIP: bad central directory entry");
		const method = zip.readUInt16LE(ptr + 10);
		const compressedSize = zip.readUInt32LE(ptr + 20);
		const nameLen = zip.readUInt16LE(ptr + 28);
		const extraLen = zip.readUInt16LE(ptr + 30);
		const commentLen = zip.readUInt16LE(ptr + 32);
		const localOffset = zip.readUInt32LE(ptr + 42);
		const entryName = zip
			.subarray(ptr + 46, ptr + 46 + nameLen)
			.toString("utf8");
		if (entryName === name) {
			const lhNameLen = zip.readUInt16LE(localOffset + 26);
			const lhExtraLen = zip.readUInt16LE(localOffset + 28);
			const dataStart = localOffset + 30 + lhNameLen + lhExtraLen;
			const data = zip.subarray(dataStart, dataStart + compressedSize);
			return method === 8 ? inflateRawSync(data) : Buffer.from(data);
		}
		ptr += 46 + nameLen + extraLen + commentLen;
	}
	throw new Error(`ZIP: entry ${name} not found`);
}

/** All <w:r>...</w:r> runs of the document body. */
function runsOf(xml: string): string[] {
	return xml.match(/<w:r>[\s\S]*?<\/w:r>/g) ?? [];
}

async function documentXmlOf(
	title: string | null,
	chs = chapters(),
): Promise<string> {
	const blob = await buildRefinedTranscriptDocxBlob({ chapters: chs }, title);
	const zip = Buffer.from(await blob.arrayBuffer());
	expect(zip.subarray(0, 2).toString("latin1")).toBe("PK"); // a real zip
	// docx escapes apostrophes as &apos; and quotes as &quot; (measured against
	// docx 9.7.1). Decode ONLY those two so text assertions can use the real
	// characters; &lt;/&gt;/&amp; are left alone so tag matching stays intact.
	const xml = extractZipEntry(zip, "word/document.xml").toString("utf8");
	return xml.replace(/&apos;/g, "'").replace(/&quot;/g, '"');
}

describe("buildRefinedTranscriptDocxBlob", () => {
	it("produces a Word-package blob with the docx MIME type", async () => {
		const blob = await buildRefinedTranscriptDocxBlob(
			{ chapters: chapters() },
			"Jahon School yigilishi",
		);
		expect(blob).toBeInstanceOf(Blob);
		expect(blob.type).toBe(DOCX_MIME_TYPE);
		expect(blob.size).toBeGreaterThan(0);
	});

	it("writes the recording title, chapter headings and body paragraphs", async () => {
		const xml = await documentXmlOf("Jahon School yigilishi");
		expect(xml).toContain("Jahon School yigilishi");
		expect(xml).toContain("Intro");
		expect(xml).toContain("Next steps");
		expect(xml).toContain("ko'rib chiqamiz.");
		expect(xml).toContain("Oddiy gap, urg'usiz.");
	});

	it("renders ** spans as bold runs and the rest as non-bold runs", async () => {
		const xml = await documentXmlOf("T");
		const runs = runsOf(xml);
		const boldRun = runs.find((r) => r.includes("CRM rejasini"));
		const plainRun = runs.find((r) => r.includes("Oddiy gap"));
		expect(boldRun).toBeDefined();
		expect(boldRun).toContain("<w:b/>");
		expect(plainRun).toBeDefined();
		expect(plainRun).not.toContain("<w:b/>");
		// The markers themselves must not survive into the document.
		expect(xml).not.toContain("**");
	});
});
