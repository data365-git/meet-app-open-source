/**
 * Export builders for the refined ("clean") transcript shown on the share
 * page's Refined tab. One module, two output formats:
 *
 *   - `buildRefinedTranscriptPlainText` — readable prose for the clipboard and
 *     the .txt download. Chapter titles become standalone lines, paragraphs
 *     stay paragraphs (blank line between blocks), inline `**bold**` markers
 *     are STRIPPED (they are markup, not content), and speaker labels that
 *     already live inside the paragraph text pass through untouched. No
 *     timestamps are added: the refined transcript is deliberately cleaned-up
 *     prose, and re-injecting speaker/time markers would undo that.
 *
 *   - `buildRefinedTranscriptDocxBlob` — a real Word document built with the
 *     `docx` package, entirely client-side. A title paragraph from the
 *     recording title, then chapter headings and body paragraphs. Deliberately
 *     plain: no colours, no fonts, no tables — only bold runs where the source
 *     text carries `**bold**`, so the document opens cleanly in Word and in
 *     mobile Word viewers without any layout to break.
 *
 * Mirrors `cuesToPlainText` / `downloadBlob` in TranscriptPanel.tsx (the raw
 * transcript tab) so both tabs export with the same shape and behave like one
 * product. They are not shared further only because TranscriptPanel must stay
 * untouched; new export surfaces should import from here instead.
 */

// TYPE-ONLY import: `docx` is 1.08 MB raw / ~220 KB gzipped (it bundles jszip
// and pako), and every share-page viewer loads this panel while only a few ever
// press DOCX. A value import here would put that weight in the first load for
// phone and Telegram viewers, so the module is pulled in with `await import`
// inside the two builders below instead. Measured on docx 9.7.1.
import type { Document, Paragraph } from "docx";

/** Structural subset of the AI summary's refined transcript — duck-typed so
 *  this lib never imports from the share-page component tree. */
export interface RefinedTranscriptLike {
	chapters: Array<{
		startSec: number;
		title: string;
		paragraphs: string[];
	}>;
}

/** Remove inline `**bold**` markers, keeping the text between them.
 *
 *  Only PAIRED markers are removed, using the same regex as
 *  `splitMarkdownBoldRuns` below. That matters: stripping every `**`
 *  unconditionally made the .txt export disagree with both the .docx export and
 *  the on-screen renderer for an unpaired marker ("a **b" became "a b" in .txt
 *  while the screen and the Word file kept it literal). One rule, three
 *  surfaces. */
export function stripMarkdownBold(text: string): string {
	return text.replace(/\*\*(.+?)\*\*/g, "$1");
}

export interface BoldRun {
	text: string;
	bold: boolean;
}

/**
 * Split text carrying inline `**bold**` markdown into runs. Uses the exact
 * split from `renderMarkdownBold` (markdownBold.tsx): everything between a
 * pair of `**` is emphasized, so odd split indices are bold. Unpaired `**`
 * stays literal, exactly as the on-screen renderer leaves it.
 */
export function splitMarkdownBoldRuns(text: string): BoldRun[] {
	return text
		.split(/\*\*(.+?)\*\*/g)
		.map((part, i) => ({ text: part, bold: i % 2 === 1 }))
		.filter((run) => run.text.length > 0);
}

/**
 * The refined transcript as readable plain text: chapter titles as lines,
 * paragraphs separated by blank lines, `**` markers stripped, empty
 * headings/paragraphs dropped. Returns "" when there is nothing to export, so
 * callers can keep a "never download an empty file" guarantee with one check.
 */
export function buildRefinedTranscriptPlainText(
	refined: RefinedTranscriptLike,
): string {
	const blocks: string[] = [];
	for (const chapter of refined.chapters) {
		const heading = chapter.title.trim();
		if (heading) blocks.push(heading);
		for (const paragraph of chapter.paragraphs) {
			const text = stripMarkdownBold(paragraph).trim();
			if (text) blocks.push(text);
		}
	}
	return blocks.join("\n\n");
}

/** Half-points: Word sizes are specified in half-points (32 = 16pt). */
const DOC_TITLE_SIZE_HALF_POINTS = 32;
/** Twips (20ths of a point): 240 = 12pt after the document title, 120 = 6pt
 *  after a chapter heading, 160 = 8pt after a body paragraph — the spacing
 *  that keeps mobile Word views readable without any custom styles. */
const SPACING_AFTER_TITLE = 240;
const SPACING_AFTER_HEADING = 120;
const SPACING_AFTER_PARAGRAPH = 160;

/**
 * Assemble the Word document (exported for tests). Plain by construction:
 * built-in Normal paragraph style, bold runs only where the source text is
 * `**bold**`, no colours, fonts, or tables.
 */
export async function buildRefinedTranscriptDocument(
	refined: RefinedTranscriptLike,
	documentTitle: string | null | undefined,
): Promise<Document> {
	const {
		Document: DocxDocument,
		Paragraph: DocxParagraph,
		TextRun,
	} = await import("docx");
	const children: Paragraph[] = [];

	const title = (documentTitle ?? "").trim();
	if (title) {
		children.push(
			new DocxParagraph({
				children: [
					new TextRun({
						text: title,
						bold: true,
						size: DOC_TITLE_SIZE_HALF_POINTS,
					}),
				],
				spacing: { after: SPACING_AFTER_TITLE },
			}),
		);
	}

	for (const chapter of refined.chapters) {
		const heading = chapter.title.trim();
		if (heading) {
			children.push(
				new DocxParagraph({
					children: [new TextRun({ text: heading, bold: true })],
					spacing: { after: SPACING_AFTER_HEADING },
				}),
			);
		}
		for (const paragraph of chapter.paragraphs) {
			if (stripMarkdownBold(paragraph).trim() === "") continue;
			const runs = splitMarkdownBoldRuns(paragraph);
			if (runs.length === 0) continue;
			children.push(
				new DocxParagraph({
					children: runs.map(
						(run) => new TextRun({ text: run.text, bold: run.bold }),
					),
					spacing: { after: SPACING_AFTER_PARAGRAPH },
				}),
			);
		}
	}

	return new DocxDocument({ sections: [{ children }] });
}

export const DOCX_MIME_TYPE =
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** Build the .docx as a Blob, ready to hand to `saveBlobToFile`. */
export async function buildRefinedTranscriptDocxBlob(
	refined: RefinedTranscriptLike,
	documentTitle: string | null | undefined,
): Promise<Blob> {
	const [{ Packer }, document] = await Promise.all([
		import("docx"),
		buildRefinedTranscriptDocument(refined, documentTitle),
	]);
	return Packer.toBlob(document);
}

/**
 * Trigger a browser download of `blob` as `filename`. Identical mechanics to
 * TranscriptPanel's private `downloadBlob` (object URL + synthetic anchor
 * click + revoke), extended to Blob inputs so the .docx bytes download the
 * same way the string-based exports do.
 */
export function saveBlobToFile(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}
