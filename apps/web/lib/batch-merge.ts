import type { VideoMetadata } from "@cap/database/types";
import { mergeChunkedWebVtt } from "@/lib/gemini-transcribe";

// Pure merge/idempotency helpers for the durable Batch collector cron. Kept in
// their own module (no db/storage/workflow imports) so they are cheap to unit
// test without pulling in the route's heavy dependency graph.

export type BatchJob = NonNullable<VideoMetadata["aiBatchJobs"]>[number];

/** Parse the absolute start (seconds) from a WebVTT timing line's left side. */
function parseVttStartSec(timingLine: string): number | null {
	const left = timingLine.split("-->")[0]?.trim() ?? "";
	const m = left.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})[.,](\d{3})$/);
	if (!m) return null;
	const h = m[1] ? Number(m[1]) : 0;
	return h * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Normalize cue text for duplicate detection: drop voice tags + markdown, lower. */
function normalizeCueText(text: string): string {
	return text
		.replace(/<\/?v[^>]*>/gi, "")
		.replace(/\*\*/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.toLowerCase();
}

type ParsedCueBlock = { block: string; start: number | null; text: string };

function parseVttBlocks(vtt: string): ParsedCueBlock[] {
	const out: ParsedCueBlock[] = [];
	for (const block of vtt.split(/\r?\n\r?\n/)) {
		const lines = block
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		if (lines.length === 0 || /^WEBVTT/i.test(lines[0] ?? "")) continue;
		const ti = lines.findIndex((l) => l.includes("-->"));
		if (ti === -1) continue;
		const start = parseVttStartSec(lines[ti] ?? "");
		const text = lines.slice(ti + 1).join(" ");
		out.push({ block, start, text });
	}
	return out;
}

/**
 * Idempotently merge a collected Batch chunk (chunk-relative VTT) into the
 * absolute partial at `startSec`. A Batch cue already present in the partial
 * with the same absolute timing (rounded to the second) and normalized text is
 * dropped, so re-collecting the same chunk (e.g. after a crash between merge and
 * job-removal) never duplicates cues (spec §5 C3).
 */
export function mergeBatchChunkIntoPartial(
	partialVtt: string,
	batchVtt: string,
	startSec: number,
): string {
	const present = new Set<string>();
	for (const cue of parseVttBlocks(partialVtt)) {
		if (cue.start === null) continue;
		present.add(`${Math.round(cue.start)}|${normalizeCueText(cue.text)}`);
	}
	const keptBlocks: string[] = [];
	for (const cue of parseVttBlocks(batchVtt)) {
		if (cue.start === null) {
			keptBlocks.push(cue.block);
			continue;
		}
		const sig = `${Math.round(cue.start + startSec)}|${normalizeCueText(cue.text)}`;
		if (!present.has(sig)) keptBlocks.push(cue.block);
	}
	const filteredBatchVtt =
		keptBlocks.length > 0 ? `WEBVTT\n\n${keptBlocks.join("\n\n")}` : "WEBVTT\n\n";
	return mergeChunkedWebVtt([
		{ vtt: partialVtt, offsetSec: 0 },
		{ vtt: filteredBatchVtt, offsetSec: startSec },
	]);
}

/** Remove one job (by batchName) from a jobs array. */
export function removeBatchJob(
	jobs: BatchJob[] | undefined,
	batchName: string,
): BatchJob[] {
	return (jobs ?? []).filter((j) => j.batchName !== batchName);
}
