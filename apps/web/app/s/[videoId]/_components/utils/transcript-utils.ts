// Utility functions for transcript formatting
import { normalizeWebVttVoiceText } from "@/lib/transcript-vtt";

export interface TranscriptEntry {
	id: number;
	timestamp: string | number; // Allow both string and number types
	text: string;
	startTime: number;
}

export const formatTime = (seconds: number): string => {
	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);
	const milliseconds = Math.floor((seconds % 1) * 1000);

	return `${hours.toString().padStart(2, "0")}:${minutes
		.toString()
		.padStart(2, "0")}:${secs.toString().padStart(2, "0")}.${milliseconds
		.toString()
		.padStart(3, "0")}`;
};

export const formatTimeMinutes = (time: number) => {
	if (time >= 3600) {
		const hours = Math.floor(time / 3600);
		const minutes = Math.floor((time % 3600) / 60);
		const seconds = Math.floor(time % 60);
		return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds
			.toString()
			.padStart(2, "0")}`;
	}
	const minutes = Math.floor(time / 60);
	const seconds = Math.floor(time % 60);
	return `${minutes.toString().padStart(2, "0")}:${seconds
		.toString()
		.padStart(2, "0")}`;
};

// Collapse runs of >= THRESHOLD consecutive cues whose normalized text is
// identical (ASR repetition-loop guard). Keeps the FIRST cue of each such run,
// drops the rest. Non-consecutive repeats are untouched.
export function collapseRepeatedCues<T>(cues: T[], getText: (c: T) => string): T[] {
	const THRESHOLD = 4;
	const norm = (s: string) =>
		s.replace(/\*\*/g, "").trim().toLowerCase().replace(/[.!?…]+$/u, "");
	const out: T[] = [];
	let i = 0;
	while (i < cues.length) {
		let j = i + 1;
		const key = norm(getText(cues[i]!));
		while (j < cues.length && norm(getText(cues[j]!)) === key && key.length > 0) j++;
		const runLen = j - i;
		if (runLen >= THRESHOLD) {
			out.push(cues[i]!); // keep only the first of a degenerate run
		} else {
			for (let k = i; k < j; k++) out.push(cues[k]!);
		}
		i = j;
	}
	return out;
}

// Auto-follow decision for the transcript panel's active-row scrolling
// (see plan: TranscriptPanel must never yank the page, only its own scroll
// container, and must stop following once the user manually scrolls away).
// Pure math on offsets — no DOM — so it's unit-testable in isolation.

/**
 * Target scrollTop that centers/aligns the active row's TOP with the
 * container's TOP-most comfortable position, matching `block: "nearest"`-like
 * behavior but scoped to a single container instead of every scrollable
 * ancestor. Clamped into [0, scrollHeight - clientHeight].
 */
export function computeFollowScrollTop(params: {
	rowOffsetTop: number;
	rowHeight: number;
	containerScrollTop: number;
	containerClientHeight: number;
	containerScrollHeight: number;
}): number {
	const {
		rowOffsetTop,
		rowHeight,
		containerScrollTop,
		containerClientHeight,
		containerScrollHeight,
	} = params;
	const rowBottom = rowOffsetTop + rowHeight;
	const viewTop = containerScrollTop;
	const viewBottom = containerScrollTop + containerClientHeight;

	let target = containerScrollTop;
	if (rowOffsetTop < viewTop) {
		// Row is above the visible area: scroll up so its top is flush with the view.
		target = rowOffsetTop;
	} else if (rowBottom > viewBottom) {
		// Row is below the visible area: scroll down so its bottom is flush with the view.
		target = rowBottom - containerClientHeight;
	}

	const maxScrollTop = Math.max(0, containerScrollHeight - containerClientHeight);
	return Math.min(Math.max(target, 0), maxScrollTop);
}

/**
 * Whether the transcript panel should (re)enable auto-follow given the
 * user's current scroll position relative to the active row. Used both to
 * decide whether a user scroll should suppress follow, and whether a
 * subsequent scroll back near the active row should resume it.
 *
 * "Near" = within `thresholdRowHeights` row-heights of the active row's
 * position, measured as the offset between the row's vertical center and
 * the container's current viewport center.
 */
export function isNearActiveRow(params: {
	rowOffsetTop: number;
	rowHeight: number;
	containerScrollTop: number;
	containerClientHeight: number;
	thresholdRowHeights?: number;
}): boolean {
	const {
		rowOffsetTop,
		rowHeight,
		containerScrollTop,
		containerClientHeight,
		thresholdRowHeights = 1.5,
	} = params;
	const rowCenter = rowOffsetTop + rowHeight / 2;
	const viewCenter = containerScrollTop + containerClientHeight / 2;
	const distance = Math.abs(rowCenter - viewCenter);
	return distance <= rowHeight * thresholdRowHeights;
}

// Defensive display-time clamp mirroring the backend sanitizeStartSec.
// Existing videos may have a chapter startSec stored in the wrong unit
// (~x60 inflated). Recover the common x60 case, otherwise clamp into
// [0, duration] so the UI never shows a time beyond the video length.
export const clampStartSec = (startSec: number, durationSec?: number): number => {
	if (!Number.isFinite(startSec) || startSec < 0) return 0;
	if (!durationSec || durationSec <= 0) return startSec;
	if (startSec <= durationSec) return startSec;
	if (startSec / 60 <= durationSec) return startSec / 60;
	return durationSec;
};

/**
 * Formats transcript entries as VTT format for subtitles
 */
export const formatTranscriptAsVTT = (entries: TranscriptEntry[]): string => {
	const vttHeader = "WEBVTT\n\n";

	const vttEntries = entries.map((entry, index) => {
		const startSeconds = entry.startTime;
		const nextEntry = entries[index + 1];
		const endSeconds = nextEntry ? nextEntry.startTime : startSeconds + 3;

		return `${entry.id}\n${formatTime(startSeconds)} --> ${formatTime(
			endSeconds,
		)}\n${entry.text}\n`;
	});

	return vttHeader + vttEntries.join("\n");
};

export function formatChaptersAsVTT(
	chapters: { title: string; start: number }[],
): string {
	if (!chapters || chapters.length === 0) {
		return "WEBVTT\n\n";
	}

	// Sort chapters by start time
	const sortedChapters = [...chapters].sort((a, b) => a.start - b.start);

	// Generate VTT content
	let vttContent = "WEBVTT\n\n";
	sortedChapters.forEach((chapter, index) => {
		const startTime = formatTime(chapter.start);
		// Check for next chapter explicitly
		const nextChapter =
			index < sortedChapters.length - 1 ? sortedChapters[index + 1] : null;
		const endTime = nextChapter
			? formatTime(nextChapter.start)
			: formatTime(chapter.start + 60);

		vttContent += `${index + 1}\n${startTime} --> ${endTime}\n${
			chapter.title
		}\n\n`;
	});

	return vttContent;
}

export const parseVTT = (vttContent: string): TranscriptEntry[] => {
	const lines = vttContent.split("\n");
	const entries: TranscriptEntry[] = [];
	let currentEntry: Partial<TranscriptEntry & { startTime: number }> = {};
	let currentId = 0;

	// Parse a single timestamp string into total seconds.
	// Accepted forms (C = colon-ms disambiguation: exactly 3 final digits = ms):
	//   HH:MM:SS           e.g. 01:02:03  -> 3723 s
	//   HH:MM:SS.mmm       e.g. 00:00:07.540 -> 7.54 s
	//   HH:MM:SS,mmm       (comma separator)
	//   MM:SS:mmm          e.g. 00:07:540 -> 7.54 s  (Gemini malformed form)
	//   MM:SS              e.g. 00:07     -> 7 s
	//   MM:SS.mmm          e.g. 00:07.540 -> 7.54 s
	const timeToSeconds = (timeStr: string): number | null => {
		// Strip optional dot/comma-based milliseconds suffix first
		let msValue = 0;
		let core = timeStr.trim();
		const dotMs = core.match(/^(.*)[.,](\d{1,3})$/);
		if (dotMs) {
			core = dotMs[1] ?? "";
			msValue = parseInt((dotMs[2] ?? "").padEnd(3, "0"), 10) / 1000;
		}

		const parts = core.split(":");
		if (parts.length === 2) {
			// MM:SS
			const [mm, ss] = parts;
			const minutes = parseInt(mm ?? "", 10);
			const seconds = parseInt(ss ?? "", 10);
			if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
			return minutes * 60 + seconds + msValue;
		}
		if (parts.length === 3) {
			const [a, b, c] = parts;
			// Disambiguate: if the last part has exactly 3 digits, treat as ms
			// (Gemini colon-ms form: MM:SS:mmm). Seconds are at most 2 digits,
			// so a 3-digit final group cannot be seconds.
			if ((c ?? "").length === 3 && /^\d{3}$/.test(c ?? "")) {
				// MM:SS:mmm form — a=MM, b=SS, c=mmm
				const minutes = parseInt(a ?? "", 10);
				const seconds = parseInt(b ?? "", 10);
				const ms = parseInt(c ?? "", 10) / 1000;
				if (Number.isNaN(minutes) || Number.isNaN(seconds)) return null;
				return minutes * 60 + seconds + ms + msValue;
			}
			// Standard HH:MM:SS form
			const hours = parseInt(a ?? "", 10);
			const minutes = parseInt(b ?? "", 10);
			const seconds = parseInt(c ?? "", 10);
			if (Number.isNaN(hours) || Number.isNaN(minutes) || Number.isNaN(seconds))
				return null;
			return hours * 3600 + minutes * 60 + seconds + msValue;
		}
		return null;
	};

	const parseTimestamp = (
		timestamp: string,
	): { mm_ss: string; totalSeconds: number } | null => {
		const totalSeconds = timeToSeconds(timestamp.trim());
		if (totalSeconds === null) return null;

		// Build the mm:ss display label from the resolved seconds value
		const totalSecInt = Math.floor(totalSeconds);
		const displayMinutes = Math.floor(totalSecInt / 60);
		const displaySeconds = totalSecInt % 60;
		const mm_ss = `${String(displayMinutes).padStart(2, "0")}:${String(displaySeconds).padStart(2, "0")}`;

		return { mm_ss, totalSeconds };
	};

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (!line?.trim()) continue;

		const trimmedLine = line.trim();

		if (trimmedLine === "WEBVTT") continue;

		if (/^\d+$/.test(trimmedLine)) {
			currentId = parseInt(trimmedLine, 10);
			continue;
		}

		if (trimmedLine.includes("-->")) {
			const [startTimeStr, endTimeStr] = trimmedLine.split(" --> ");
			if (!startTimeStr || !endTimeStr) continue;

			const startTimestamp = parseTimestamp(startTimeStr);
			if (startTimestamp) {
				currentEntry = {
					id: currentId,
					timestamp: startTimestamp.mm_ss,
					startTime: startTimestamp.totalSeconds,
				};
			}
			continue;
		}

		// Guard: never treat metadata/timing lines as transcript text.
		// Skip the WEBVTT header or a line that is a standalone timestamp
		// (including the Gemini colon-ms form MM:SS:mmm). Cue timing lines that
		// contain "-->" are already handled + `continue`d above, so no need to
		// re-check for "-->" here.
		if (/^WEBVTT/i.test(trimmedLine)) continue;
		// Matches: HH:MM:SS, HH:MM:SS.mmm, MM:SS, MM:SS.mmm, MM:SS:mmm
		if (/^\d{1,2}:\d{1,2}(?::\d{1,3}|[.,]\d{1,3})?$/.test(trimmedLine)) continue;

		if (currentEntry.timestamp && !currentEntry.text) {
			const textContent =
				trimmedLine.startsWith('"') && trimmedLine.endsWith('"')
					? trimmedLine.slice(1, -1)
					: trimmedLine;
			const normalized = normalizeWebVttVoiceText(textContent);

			currentEntry.text = normalized.speaker
				? `${normalized.speaker}: ${normalized.text}`
				: normalized.text;
			if (
				currentEntry.id !== undefined &&
				currentEntry.timestamp &&
				currentEntry.text &&
				currentEntry.startTime !== undefined
			) {
				entries.push(currentEntry as TranscriptEntry);
			}
			currentEntry = {};
		}
	}

	const sortedEntries = entries.sort((a, b) => a.startTime - b.startTime);
	return collapseRepeatedCues(sortedEntries, (e) => e.text);
};

/**
 * Formats transcript entries for clipboard copying
 */
export const formatTranscriptForClipboard = (
	entries: TranscriptEntry[],
): string => {
	return entries
		.map((entry) => `[${entry.timestamp}] ${entry.text}`)
		.join("\n\n");
};
