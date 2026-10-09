import type { VideoEditSpec } from "@cap/database/types";
import {
	mapSourceTimeToOutputTime,
	normalizeKeepRanges,
} from "@/lib/video-edits";

/**
 * Pure, deterministic remap of transcript/chapter timestamps from the
 * SOURCE (pre-trim) timeline to the OUTPUT (post-trim) timeline described by
 * a VideoEditSpec's keepRanges — the same math the player's timeline already
 * uses (`mapSourceTimeToOutputTime`). Used by workflows/edit-video.ts's
 * "post-AI trim desync guard": a trim must never leave a cue, chapter, or
 * summary timestamp pointing at a moment that no longer exists in the output.
 */

const EPSILON = 1e-6;
const MIN_CUE_DURATION_SEC = 0.05;
const TIMESTAMP_RE = /(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})/;

function parseVttTimestamp(value: string): number | null {
	const match = value.match(TIMESTAMP_RE);
	if (!match) return null;
	const [, h, m, s, ms] = match;
	return (
		(h ? Number(h) : 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000
	);
}

function formatVttTimestamp(value: number): string {
	const t = Math.max(0, value);
	const h = Math.floor(t / 3600);
	const m = Math.floor((t % 3600) / 60);
	const s = t % 60;
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}

export interface VttCueRemapStats {
	totalCues: number;
	keptCues: number;
	droppedCues: number;
	clippedCues: number;
}

export interface VttCueRemapResult extends VttCueRemapStats {
	vtt: string;
}

/**
 * Remaps every cue's [start,end] onto the post-trim timeline.
 * - A cue entirely inside a removed span is DROPPED — its content no longer
 *   exists in the output.
 * - A cue straddling a cut boundary is CLIPPED to whichever kept range it
 *   overlaps, so the surviving part still lines up with the frames that
 *   actually remain (never left pointing at a cut moment).
 * - Cue text and any trailing cue-settings (e.g. "align:start position:0%")
 *   are preserved verbatim; only the timing line is rewritten.
 */
export function remapVttCuesForEdit(
	vtt: string,
	editSpec: VideoEditSpec,
): VttCueRemapResult {
	const keepRanges = normalizeKeepRanges(
		editSpec.keepRanges,
		editSpec.sourceDuration,
	).keepRanges;

	const blocks = vtt.split(/\r?\n\r?\n/);
	const keptBlocks: string[] = [];
	let totalCues = 0;
	let droppedCues = 0;
	let clippedCues = 0;

	for (const block of blocks) {
		const lines = block.split(/\r?\n/);
		const timingIndex = lines.findIndex((line) => line.includes("-->"));
		if (timingIndex === -1) continue; // WEBVTT header / NOTE / blank block

		totalCues++;

		const timingLine = lines[timingIndex] ?? "";
		const arrow = timingLine.indexOf("-->");
		const startRaw = timingLine.slice(0, arrow).trim();
		const afterArrow = timingLine.slice(arrow + 3).trim();
		const endToken = afterArrow.split(/\s+/)[0] ?? "";
		const rest = afterArrow.slice(endToken.length);

		const start = parseVttTimestamp(startRaw);
		const end = parseVttTimestamp(endToken);
		if (start == null || end == null || end <= start) {
			droppedCues++;
			continue;
		}

		const overlap = keepRanges.find(
			(range) => end > range.start + EPSILON && start < range.end - EPSILON,
		);
		if (!overlap) {
			droppedCues++;
			continue;
		}

		const clippedStart = Math.max(start, overlap.start);
		const clippedEnd = Math.min(end, overlap.end);
		if (clippedEnd - clippedStart < MIN_CUE_DURATION_SEC) {
			droppedCues++;
			continue;
		}

		const outStart = mapSourceTimeToOutputTime(clippedStart, editSpec);
		const outEnd = mapSourceTimeToOutputTime(clippedEnd, editSpec);
		if (outStart == null || outEnd == null || outEnd <= outStart) {
			droppedCues++;
			continue;
		}

		if (clippedStart !== start || clippedEnd !== end) clippedCues++;

		const newLines = [...lines];
		newLines[timingIndex] =
			`${formatVttTimestamp(outStart)} --> ${formatVttTimestamp(outEnd)}${rest}`;
		keptBlocks.push(newLines.join("\n"));
	}

	const keptCues = totalCues - droppedCues;
	const body = keptBlocks.join("\n\n");

	return {
		vtt: keptCues > 0 ? `WEBVTT\n\n${body}\n\n` : "WEBVTT\n\n",
		totalCues,
		keptCues,
		droppedCues,
		clippedCues,
	};
}

/**
 * Remaps a flat list of single-point-in-time markers (chapter starts). Unlike
 * cues, a chapter has no "clip" option — if the exact point it marks was cut
 * out, there is no honest place to put it. `clean: false` tells the caller to
 * drop the WHOLE set rather than show a chapter marker at the wrong time.
 */
export function remapTimePoints(
	times: number[],
	editSpec: VideoEditSpec,
): { times: number[]; clean: boolean } {
	if (times.length === 0) return { times: [], clean: true };

	const mapped = times.map((t) => mapSourceTimeToOutputTime(t, editSpec));
	const clean = mapped.every((t): t is number => t !== null);
	return { times: clean ? (mapped as number[]) : [], clean };
}

/** Chapter shape used by AiSummary.chapters / refinedTranscript.chapters. */
export function remapChaptersByStartSec<T extends { startSec: number }>(
	chapters: T[] | undefined,
	editSpec: VideoEditSpec,
): { chapters: T[] | undefined; clean: boolean } {
	if (!chapters || chapters.length === 0) return { chapters, clean: true };

	const { times, clean } = remapTimePoints(
		chapters.map((c) => c.startSec),
		editSpec,
	);
	if (!clean) return { chapters: undefined, clean: false };

	return {
		chapters: chapters.map((c, i) => ({ ...c, startSec: times[i] as number })),
		clean: true,
	};
}

/** Chapter shape used by the legacy top-level VideoMetadata.chapters. */
export function remapChaptersByStart<T extends { start: number }>(
	chapters: T[] | undefined,
	editSpec: VideoEditSpec,
): { chapters: T[] | undefined; clean: boolean } {
	if (!chapters || chapters.length === 0) return { chapters, clean: true };

	const { times, clean } = remapTimePoints(
		chapters.map((c) => c.start),
		editSpec,
	);
	if (!clean) return { chapters: undefined, clean: false };

	return {
		chapters: chapters.map((c, i) => ({ ...c, start: times[i] as number })),
		clean: true,
	};
}
