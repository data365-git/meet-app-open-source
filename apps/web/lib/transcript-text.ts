import type { videos } from "@cap/database/schema";
import { Effect, Option } from "effect";
import { runPromise } from "@/lib/server";
import { normalizeWebVttVoiceText } from "@/lib/transcript-vtt";
import { getStorageAccessForVideo } from "@/lib/video-storage";

/**
 * Plain-text transcript extraction, shared by the per-video transcript
 * download (GET /api/videos/[videoId]/transcript) and the Hermes meeting
 * queue (GET /api/hermes/meetings/queue). Extracted verbatim from the
 * download route (2026-10-08) so both serve byte-identical text — the ADR's
 * rule is "same text as the existing per-video download".
 */

function vttTimeToSeconds(raw: string): number | null {
	const match = raw.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
	if (!match) return null;
	const hours = match[1] ? Number(match[1]) : 0;
	const minutes = Number(match[2]);
	const seconds = Number(match[3]);
	return hours * 3600 + minutes * 60 + seconds;
}

function formatMmSs(totalSeconds: number): string {
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.floor(totalSeconds % 60);
	return `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
}

/** Standard WEBVTT (cue blocks separated by a blank line) to readable lines:
 * "[mm:ss] Speaker: text" when a speaker tag is present, else "[mm:ss] text". */
export function vttToReadableText(vtt: string): string {
	const blocks = vtt.replace(/\r\n/g, "\n").split(/\n\n+/);
	const lines: string[] = [];

	for (const block of blocks) {
		const blockLines = block.split("\n").filter((l) => l.trim() !== "");
		if (blockLines.length === 0) continue;
		if (/^WEBVTT/i.test(blockLines[0] ?? "")) continue;

		// Skip an optional leading cue-identifier line.
		let idx = 0;
		if (blockLines[0] && !blockLines[0].includes("-->")) idx = 1;

		const timingLine = blockLines[idx];
		if (!timingLine || !timingLine.includes("-->")) continue;

		const startRaw = timingLine.split("-->")[0]?.trim() ?? "";
		const startSeconds = vttTimeToSeconds(startRaw);
		const text = blockLines
			.slice(idx + 1)
			.join(" ")
			.trim();
		if (!text) continue;

		const { speaker, text: spoken } = normalizeWebVttVoiceText(text);
		const timestamp =
			startSeconds !== null ? `[${formatMmSs(startSeconds)}] ` : "";
		lines.push(
			speaker ? `${timestamp}${speaker}: ${spoken}` : `${timestamp}${spoken}`,
		);
	}

	return lines.join("\n");
}

/**
 * Read the video's transcription.vtt from storage and return the readable
 * text. Null when the object is missing or empty (the caller decides whether
 * that is a 404). Storage failures throw, exactly like the download route's
 * inline version did.
 */
export async function fetchVideoTranscriptText(
	video: typeof videos.$inferSelect,
): Promise<string | null> {
	const vttContent = await Effect.gen(function* () {
		const [bucket] = yield* getStorageAccessForVideo(video);
		return yield* bucket.getObject(
			`${video.ownerId}/${video.id}/transcription.vtt`,
		);
	}).pipe(runPromise);

	if (Option.isNone(vttContent) || !vttContent.value.trim()) {
		return null;
	}

	return vttToReadableText(vttContent.value);
}
