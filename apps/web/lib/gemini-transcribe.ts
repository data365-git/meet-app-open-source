export interface GeminiTranscribeResult {
	transcriptVtt: string;
	inputTokens: number;
	outputTokens: number;
	audioInTokens: number;
	words?: Array<{
		word: string;
		start: number;
		end: number;
		language?: string;
	}>;
}

interface GeminiFileResponse {
	file: {
		name: string;
		uri: string;
		state: string;
	};
}

function detectMimeType(audioUrl: string): string {
	const url = audioUrl.split("?")[0] ?? audioUrl;
	if (url.endsWith(".mp4") || url.endsWith(".m4a")) return "audio/mp4";
	if (url.endsWith(".wav")) return "audio/wav";
	if (url.endsWith(".ogg")) return "audio/ogg";
	if (url.endsWith(".webm")) return "audio/webm";
	return "audio/mpeg";
}

function formatVttTimestamp(seconds: number): string {
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = Math.floor(seconds % 60);
	const ms = Math.round((seconds % 1) * 1000);
	return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(ms).padStart(3, "0")}`;
}

function plainTextToWebVTT(text: string, durationSec: number): string {
	const sentences = text
		.split(/(?<=[.?!])\s+|\n+/)
		.map((s) => s.trim())
		.filter(Boolean);

	if (sentences.length === 0) return "WEBVTT\n\n";

	const totalChars = sentences.reduce((sum, s) => sum + s.length, 0);
	let vtt = "WEBVTT\n\n";
	let elapsed = 0;
	let index = 1;

	for (const sentence of sentences) {
		const fraction =
			totalChars > 0 ? sentence.length / totalChars : 1 / sentences.length;
		const cueDuration = durationSec * fraction;
		const start = formatVttTimestamp(elapsed);
		const end = formatVttTimestamp(elapsed + cueDuration);
		vtt += `${index}\n${start} --> ${end}\n${cleanCueText(sentence)}\n\n`;
		elapsed += cueDuration;
		index++;
	}

	return vtt;
}

interface ParsedCue {
	start: number;
	end: number | null;
	text: string;
}

function parseTimestampToSeconds(raw: string): number | null {
	// Accept HH:MM:SS(.mmm), MM:SS(.mmm), and the Gemini colon-ms forms
	// MM:SS:mmm and HH:MM:SS:mmm where a trailing colon-separated group of
	// EXACTLY 3 digits is treated as milliseconds (not a fourth time unit).
	// Disambiguation: seconds are at most 2 digits; a 3-digit final group = ms.
	//
	// Examples:
	//   00:07:540        -> 7.540 s  (MM:SS:mmm)
	//   00:00:07.540     -> 7.540 s  (HH:MM:SS.mmm — standard)
	//   00:00:07:540     -> 7.540 s  (HH:MM:SS:mmm)
	//   01:02:03         -> 3723 s   (HH:MM:SS)
	//   01:30            -> 90 s     (MM:SS)
	const trimmed = raw.trim();

	// Try colon-ms form first: trailing :ddd (exactly 3 digits)
	const colonMs = trimmed.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2}):(\d{3})$/);
	if (colonMs) {
		const h = colonMs[1] ? parseInt(colonMs[1], 10) : 0;
		const min = parseInt(colonMs[2] ?? "0", 10);
		const s = parseInt(colonMs[3] ?? "0", 10);
		const ms = parseInt(colonMs[4] ?? "0", 10);
		return h * 3600 + min * 60 + s + ms / 1000;
	}

	// DOT-SEPARATED form `HH:MM.SS.mmm` — Gemini emits this occasionally, e.g.
	// `00:00.000 --> 00:00.07.500` followed by `00:00.14.500`. Read as a
	// sequence it is unambiguous: 7.5s then 14.5s, i.e. hours:minutes.seconds.ms
	// with dots where the last two colons belong. It matters more than it looks:
	// without this branch the TS pattern matched only the `00:00.07` prefix, so
	// every cue in the chunk collapsed to ~0s. That made the chunk look
	// "under-covered", which triggered a full RETRY of a paid transcription
	// (twice, measured on prod 2026-07-20), and it left the chunk with too few
	// parsable cues for the drift rescale — so those minutes kept the old
	// cue drift while every other chunk was corrected.
	const dotted = trimmed.match(/^(\d{1,2}):(\d{1,2})\.(\d{1,2})\.(\d{1,3})$/);
	if (dotted) {
		const h = parseInt(dotted[1] ?? "0", 10);
		const min = parseInt(dotted[2] ?? "0", 10);
		const s = parseInt(dotted[3] ?? "0", 10);
		const ms = parseInt((dotted[4] ?? "0").padEnd(3, "0"), 10);
		return h * 3600 + min * 60 + s + ms / 1000;
	}

	// Standard form: optional HH: then MM:SS with optional dot/comma ms
	const m = trimmed.match(/^(?:(\d{1,2}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
	if (!m) return null;
	const h = m[1] ? parseInt(m[1], 10) : 0;
	const min = parseInt(m[2] ?? "0", 10);
	const s = parseInt(m[3] ?? "0", 10);
	const ms = m[4] ? parseInt(m[4].padEnd(3, "0"), 10) : 0;
	return h * 3600 + min * 60 + s + ms / 1000;
}

function cleanCueText(raw: string): string {
	return raw
		.replace(/^[\s\-–—>]+/, "")
		.trim();
}

// WebVTT cue settings (align:, line:, position:, size:, vertical:, region:) can
// appear after the end timestamp on a standard cue line. They are NOT transcript
// text, so strip them — otherwise a standard cue's settings get mistaken for the
// cue body and the real next-line text is dropped.
const CUE_SETTING_TOKEN = /^(?:align|line|position|size|vertical|region):\S+$/i;
function stripCueSettings(text: string): string {
	return text
		.split(/\s+/)
		.filter((tok) => tok && !CUE_SETTING_TOKEN.test(tok))
		.join(" ")
		.trim();
}

// Matches any timestamp form we accept, including the Gemini colon-ms form
// where a trailing group of exactly 3 digits (after a colon) is milliseconds:
//   HH:MM:SS.mmm  MM:SS.mmm  HH:MM:SS  MM:SS  MM:SS:mmm  HH:MM:SS:mmm
// The colon-ms alternative (`:\d{3}\b`) MUST be tried before the `:\d{1,2}`
// seconds group; otherwise the 2-digit-seconds group greedily eats the first
// two digits of a 3-digit ms group (e.g. `00:07:540` -> matches only `00:07:54`,
// leaving a stray `0` that breaks the `--> ` detection and drops the cue text).
// The dot-separated `HH:MM.SS.mmm` alternative must come FIRST for the same
// greedy reason as the colon-ms one: otherwise `\\d{1,2}:\\d{1,2}` plus the
// `[.,]\\d{1,3}` tail matches only `00:00.07` of `00:00.07.500` and the cue is
// mis-timed to 0.07s instead of 7.5s.
const TS =
	"\\d{1,2}:\\d{1,2}\\.\\d{1,2}\\.\\d{1,3}\\b|\\d{1,2}:\\d{1,2}(?::\\d{3}\\b|:\\d{1,2})?(?:[.,]\\d{1,3})?";

// Tolerance (seconds) for cue starts that legitimately sit at/just past the
// reported audio duration. Cues starting beyond duration + this are treated as
// hallucinations and dropped.
const DURATION_TOLERANCE_SEC = 5;

/**
 * Normalize Gemini's transcript output into STANDARD WebVTT, regardless of the
 * exact shape Gemini returns. Handles: inline cues `**[start --> end]** text`,
 * standard two-line cues (timestamp line then text line(s)), and single-timestamp
 * cues `**[HH:MM:SS]** text`. Falls back to plainTextToWebVTT if no cues are found.
 */
export function normalizeToWebVtt(raw: string, audioDurationSec: number): string {
	const lines = raw.split(/\r?\n/);
	const cues: ParsedCue[] = [];

	// Inline range cue: optional **/[ then start --> end ] optional, then text on same line.
	const inlineRange = new RegExp(
		`^[\\s*\\[-]*?(${TS})\\s*-->\\s*(${TS})\\s*\\]?\\*?\\*?\\s*(.*)$`,
	);
	// Range on its own line (standard) — text (if any) follows.
	const rangeLine = new RegExp(`(${TS})\\s*-->\\s*(${TS})`);
	// Single timestamp cue: **[HH:MM:SS]** text  (no end time).
	const singleStamp = new RegExp(`^[\\s*\\[-]*?(${TS})\\s*\\]?\\*?\\*?\\s*(.*)$`);

	let pendingStart: number | null = null;
	let pendingEnd: number | null = null;
	let pendingText: string[] = [];

	const flushPending = () => {
		if (pendingStart !== null) {
			const text = cleanCueText(pendingText.join(" "));
			if (text) cues.push({ start: pendingStart, end: pendingEnd, text });
		}
		pendingStart = null;
		pendingEnd = null;
		pendingText = [];
	};

	for (let i = 0; i < lines.length; i++) {
		const line = (lines[i] ?? "").trim();
		if (!line) {
			flushPending();
			continue;
		}
		if (/^WEBVTT/i.test(line)) continue;
		// Only skip a bare numeric line as a cue index when the next non-empty
		// line is a timestamp line; otherwise treat it as cue text.
		if (/^\d+$/.test(line)) {
			let nextNonEmpty = "";
			for (let j = i + 1; j < lines.length; j++) {
				const peek = (lines[j] ?? "").trim();
				if (peek) { nextNonEmpty = peek; break; }
			}
			if (nextNonEmpty.includes("-->")) continue; // it IS a cue index
			// else fall through — treat this number as cue text below
		}

		if (line.includes("-->")) {
			flushPending();
			// Try inline (timestamp + same-line text) first.
			const im = line.match(inlineRange);
			if (im) {
				const start = parseTimestampToSeconds(im[1] ?? "");
				const end = parseTimestampToSeconds(im[2] ?? "");
				// Drop any cue-settings tokens; only real transcript text counts as
				// same-line text. Settings-only => treat as a standard two-line cue.
				const text = stripCueSettings(cleanCueText(im[3] ?? ""));
				if (start !== null) {
					if (text) {
						cues.push({ start, end, text });
					} else {
						// Standard two-line cue: text comes on following line(s).
						pendingStart = start;
						pendingEnd = end;
					}
					continue;
				}
			}
			const rm = line.match(rangeLine);
			if (rm) {
				const start = parseTimestampToSeconds(rm[1] ?? "");
				if (start !== null) {
					pendingStart = start;
					pendingEnd = parseTimestampToSeconds(rm[2] ?? "");
				}
			}
			continue;
		}

		// Single-timestamp cue (no -->): "**[HH:MM:SS]** text"
		const sm = line.match(singleStamp);
		if (sm && parseTimestampToSeconds(sm[1] ?? "") !== null && (sm[2] ?? "").trim()) {
			flushPending();
			const start = parseTimestampToSeconds(sm[1] ?? "");
			if (start !== null) {
				cues.push({ start, end: null, text: cleanCueText(sm[2] ?? "") });
				continue;
			}
		}

		// Plain text line — accumulate as body of the pending cue.
		if (pendingStart !== null) {
			pendingText.push(line);
		}
	}
	flushPending();

	// Gemini sometimes hallucinates trailing cues whose timestamps run far past
	// the real audio (e.g. a 55s video gets a cue at 01:02:20). Drop any cue that
	// starts beyond the known duration (plus a small tolerance for legitimate end
	// cues) so bogus cues never get persisted. Only applies when duration is known.
	if (audioDurationSec > 0) {
		const maxStart = audioDurationSec + DURATION_TOLERANCE_SEC;
		for (let i = cues.length - 1; i >= 0; i--) {
			if ((cues[i]?.start ?? 0) > maxStart) cues.splice(i, 1);
		}
	}

	if (cues.length === 0) {
		return plainTextToWebVTT(raw, audioDurationSec);
	}

	// Fill missing end times: next cue's start, or start + default for the last cue.
	const DEFAULT_TAIL = 4;
	let vtt = "WEBVTT\n\n";
	for (let i = 0; i < cues.length; i++) {
		const cue = cues[i];
		if (!cue) continue;
		let end = cue.end;
		if (end === null || end <= cue.start) {
			const next = cues[i + 1];
			if (next && next.start > cue.start) {
				end = next.start;
			} else {
				end = Math.min(cue.start + DEFAULT_TAIL, audioDurationSec || cue.start + DEFAULT_TAIL);
				if (end <= cue.start) end = cue.start + DEFAULT_TAIL;
			}
		}
		vtt += `${i + 1}\n${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(end)}\n${cue.text}\n\n`;
	}

	return collapseRepeatedVttCues(vtt);
}

// Collapse runs of >= REPEAT_RUN_THRESHOLD consecutive cue blocks whose
// normalized text is identical. Guards against ASR repetition loops where the
// model emits hundreds of duplicate cues (e.g. "Zo'r." x80, "Xo'sh." x495) at a
// non-speech tail. Keeps the FIRST block of each degenerate run, re-indexes
// sequentially. Speaker tags and markdown bold are ignored when comparing, so
// the same word alternating between Speaker 1/2 still collapses. Non-consecutive
// repeats (a real verbal tic spread through the call) are untouched.
const REPEAT_RUN_THRESHOLD = 4;
export function collapseRepeatedVttCues(vtt: string): string {
	const norm = (s: string) =>
		s
			.replace(/<\/?v[^>]*>/gi, "")
			.replace(/\*\*/g, "")
			.trim()
			.toLowerCase()
			.replace(/[.!?…]+$/u, "");

	const blocks = vtt.split(/\r?\n\r?\n/);
	const cues: Array<{ timing: string; text: string; key: string }> = [];
	for (const block of blocks) {
		const lines = block
			.split(/\r?\n/)
			.map((l) => l.trim())
			.filter(Boolean);
		if (lines.length === 0 || /^WEBVTT/i.test(lines[0] ?? "")) continue;
		const ti = lines.findIndex((l) => l.includes("-->"));
		if (ti === -1) continue;
		const text = lines.slice(ti + 1).join("\n");
		if (!text) continue;
		cues.push({ timing: lines[ti] ?? "", text, key: norm(text) });
	}

	const kept: Array<{ timing: string; text: string }> = [];
	let i = 0;
	while (i < cues.length) {
		let j = i + 1;
		const key = cues[i]?.key ?? "";
		while (j < cues.length && cues[j]?.key === key && key.length > 0) j++;
		if (j - i >= REPEAT_RUN_THRESHOLD) {
			kept.push(cues[i]!);
		} else {
			for (let k = i; k < j; k++) kept.push(cues[k]!);
		}
		i = j;
	}

	let out = "WEBVTT\n\n";
	kept.forEach((c, idx) => {
		out += `${idx + 1}\n${c.timing}\n${c.text}\n\n`;
	});
	return out;
}

// ── Within-chunk clock rescale ──────────────────────────────────────────────
//
// MEASURED on production (2026-07-19, `scripts/measure-transcript-drift.mjs`
// against a real 42-min recording, 13 dense samples inside one chunk):
//
//   true 1800s -> cue 1808s   (+8s, chunk boundary: no drift)
//   true 1900s -> cue 1866s   (-34s)
//   true 2000s -> cue 1921s   (-79s)
//   true 2100s -> cue 1986s   (-114s)
//   true 2150s -> cue 2030s   (-120s)
//   true 2200s -> cue 2194s   (-6s, NEXT chunk: drift reset to ~0)
//
// So Gemini's within-chunk clock runs at a roughly CONSTANT fraction of real
// time (~0.64 here) and re-anchors at every chunk start. That makes the error
// almost perfectly linear inside a chunk — and therefore removable by a linear
// rescale, without any second STT service (the owner ruled ElevenLabs out of the
// pipeline). Shrinking the chunk size only caps the error; this removes it.
//
// The anchor MUST be where speech actually stops, not the chunk's nominal end:
// chunk boundaries are anchored to speech ONSETS, so a chunk usually ends with a
// silence, and stretching cues to the nominal end would push them late.
// `speechEndSec` (from computeSilenceAnchoredCuts) carries that truth.
const RESCALE_MIN_CUES = 3;
// Below this the correction is noise; above it the chunk is mostly silence or
// the model gave up early, and stretching would amplify garbage.
/** Set by the transcribe workflow so the anchor's inputs reach the server log
 * without this module importing a logger. Diagnostic only — see the call site. */
export type RescaleAnchorProbe = (stats: {
	cueCount: number;
	lastEnd: number;
	secondLast: number;
	p90: number;
	speechSpanSec: number;
	gapBeforeLast: number;
}) => void;

let rescaleAnchorProbe: RescaleAnchorProbe | undefined;

export function setRescaleAnchorProbe(probe: RescaleAnchorProbe | undefined) {
	rescaleAnchorProbe = probe;
}

const RESCALE_MIN_FACTOR = 1.05;
const RESCALE_MAX_FACTOR = 2.5;

export interface ChunkRescaleResult {
	vtt: string;
	factor: number;
	applied: boolean;
	reason?: string;
}

/**
 * Linearly stretch one chunk's cue times so the last cue ends where the speech
 * in that chunk actually ends. Times are chunk-RELATIVE on both sides (the
 * absolute offset is applied later by mergeChunkedWebVtt).
 *
 * Pure. `speechSpanSec` = (speechEndSec - chunk.startSec) when a silence-anchored
 * boundary is known, else the chunk duration.
 */
export function rescaleChunkVtt(
	vtt: string,
	speechSpanSec: number,
): ChunkRescaleResult {
	if (!(speechSpanSec > 0)) {
		return { vtt, factor: 1, applied: false, reason: "no-span" };
	}

	const timingLine = new RegExp(`(${TS})\\s*-->\\s*(${TS})`);
	const blocks = vtt.split(/\r?\n\r?\n/);

	const ends: number[] = [];
	for (const block of blocks) {
		const line = block.split(/\r?\n/).find((l) => l.includes("-->"));
		const m = line?.match(timingLine);
		if (!m) continue;
		const end = parseTimestampToSeconds(m[2] ?? "");
		if (end == null) continue;
		ends.push(end);
	}
	const cueCount = ends.length;
	const lastEnd = ends.length > 0 ? Math.max(...ends) : 0;

	if (cueCount < RESCALE_MIN_CUES) {
		return { vtt, factor: 1, applied: false, reason: "too-few-cues" };
	}
	if (lastEnd <= 0) {
		return { vtt, factor: 1, applied: false, reason: "no-end" };
	}

	// DIAGNOSTIC ONLY — this anchors on max(end), and on 2026-07-20 that let ONE
	// stray trailing cue report "already the right length" for a chunk whose real
	// cues stopped 51s short, so the rescale skipped the worst-drifting chunk in a
	// 53-minute recording (see docs/STATE.md). The obvious repair — ignore a lone
	// final cue after a long gap — turned 5 existing tests red, because sparse but
	// GENUINE speech looks identical. So the behaviour is deliberately unchanged
	// until there is data from more than one chunk: this records what a
	// distribution-based anchor would have seen, so the next transcription of any
	// real meeting produces that evidence for free.
	const sortedEnds = [...ends].sort((a, b) => a - b);
	const p90 = sortedEnds[Math.max(0, Math.ceil(sortedEnds.length * 0.9) - 1)] ?? 0;
	const secondLast = sortedEnds[sortedEnds.length - 2] ?? 0;
	rescaleAnchorProbe?.({
		cueCount,
		lastEnd,
		secondLast,
		p90,
		speechSpanSec,
		gapBeforeLast: lastEnd - secondLast,
	});

	const factor = speechSpanSec / lastEnd;
	if (factor < RESCALE_MIN_FACTOR || factor > RESCALE_MAX_FACTOR) {
		return { vtt, factor, applied: false, reason: "factor-out-of-range" };
	}

	const rescaled = blocks
		.map((block) =>
			block
				.split(/\r?\n/)
				.map((line) => {
					const m = line.match(timingLine);
					if (!m) return line;
					const start = parseTimestampToSeconds(m[1] ?? "");
					const end = parseTimestampToSeconds(m[2] ?? "");
					if (start == null || end == null) return line;
					// Clamp to the span so a stretched end can never run past the
					// chunk's own audio.
					const ns = Math.min(start * factor, speechSpanSec);
					const ne = Math.min(end * factor, speechSpanSec);
					return line.replace(
						m[0],
						`${formatVttTimestamp(ns)} --> ${formatVttTimestamp(Math.max(ne, ns))}`,
					);
				})
				.join("\n"),
		)
		.join("\n\n");

	return { vtt: rescaled, factor, applied: true };
}

// A cue may never span longer than this. Gemini sometimes emits a runaway END
// timestamp (e.g. a cue at 15:59 ending at 75:00) — left as-is that cue stays
// "active" for the whole span, freezing the on-screen caption on one line and
// masking a real transcript gap. We pull every end back to the next cue's start
// (or start + MAX) so captions advance and gaps read as blank, not frozen.
const MAX_MERGED_CUE_SEC = 30;

export function mergeChunkedWebVtt(
	chunks: Array<{ vtt: string; offsetSec: number }>,
): string {
	const timingLine = new RegExp(`(${TS})\\s*-->\\s*(${TS})`);
	const cues: Array<{ start: number; end: number; text: string }> = [];

	for (const chunk of chunks) {
		const blocks = chunk.vtt.split(/\r?\n\r?\n/);

		for (const block of blocks) {
			const lines = block
				.split(/\r?\n/)
				.map((line) => line.trim())
				.filter(Boolean);

			if (lines.length === 0 || /^WEBVTT/i.test(lines[0] ?? "")) {
				continue;
			}

			const timingIndex = lines.findIndex((line) => line.includes("-->"));
			if (timingIndex === -1) {
				continue;
			}

			const match = lines[timingIndex]?.match(timingLine);
			if (!match) {
				continue;
			}

			const start = parseTimestampToSeconds(match[1] ?? "");
			const end = parseTimestampToSeconds(match[2] ?? "");
			if (start == null || end == null || end <= start) {
				continue;
			}

			const textLines = lines.slice(timingIndex + 1);
			if (textLines.length === 0) {
				continue;
			}

			cues.push({
				start: start + chunk.offsetSec,
				end: end + chunk.offsetSec,
				text: textLines.join("\n"),
			});
		}
	}

	cues.sort((a, b) => a.start - b.start);

	// Clamp runaway ends: end ≤ next cue's start, and ≤ start + MAX_MERGED_CUE_SEC.
	let output = "WEBVTT\n\n";
	let cueIndex = 1;
	for (let i = 0; i < cues.length; i++) {
		const cue = cues[i];
		if (!cue) continue;
		const next = cues[i + 1];
		let end = Math.min(cue.end, cue.start + MAX_MERGED_CUE_SEC);
		if (next && next.start > cue.start) {
			end = Math.min(end, next.start);
		}
		if (end <= cue.start) {
			end = cue.start + 0.1;
		}
		output += `${cueIndex}\n${formatVttTimestamp(cue.start)} --> ${formatVttTimestamp(end)}\n${cue.text}\n\n`;
		cueIndex++;
	}

	return collapseRepeatedVttCues(output);
}

// Generic numbered fallback labels and the background-voice marker carry no
// cross-chunk identity — only REAL names go into the roster.
const GENERIC_SPEAKER_LABEL = /^(?:speaker|spiker|спикер)\s*\d+$/i;

/** Harvest real speaker names (<v Name> voice tags) from a chunk's VTT so
 * later chunks of the same recording can reuse the exact same labels. */
export function extractSpeakerLabels(vtt: string): string[] {
	const labels = new Set<string>();
	const re = /<v\s+([^>]+)>/gi;
	let m: RegExpExecArray | null;
	while ((m = re.exec(vtt)) !== null) {
		const label = (m[1] ?? "").trim();
		if (!label) continue;
		if (GENERIC_SPEAKER_LABEL.test(label)) continue;
		if (/^boshqa ovoz$/i.test(label)) continue;
		labels.add(label);
		if (labels.size >= 6) break;
	}
	return [...labels];
}

import { isTransientGeminiError, withGeminiRetry } from "@/lib/gemini-retry";

// NOTE: gemini-2.0-flash was RETIRED by Google (HTTP 404 "no longer available",
// verified 2026-07-02) — the overload fallback now uses the Google-managed
// "gemini-flash-latest" alias, which always points at a live flash model.
// PRIMARY switched to gemini-3-flash-preview 2026-07-04 (owner decision — fixes
// the Cyrillic/romanization problem for free, verified in A/B testing on real
// uz+ru audio; same audio price as 2.5-flash). gemini-2.5-flash kept as the
// first overload fallback, gemini-flash-latest as the last resort.
const GEMINI_TRANSCRIBE_MODELS = [
	"gemini-3-flash-preview",
	"gemini-2.5-flash",
	"gemini-flash-latest",
] as const;

// Runaway cost guard. A 15-min transcription chunk cannot legitimately exceed
// ~16k output tokens; the model's 65k max let a repetition-loop runaway burn the
// whole cap (measured: one 2.5-flash chunk hit 65537 out-tokens and cost $0.19 of
// garbage on a video that should have cost ~$0.07). 24k keeps generous headroom
// for a dense chunk while cutting a runaway's blast radius ~2.7x.
export const TRANSCRIBE_MAX_OUTPUT_TOKENS = 24000;

// Detect a repetition-loop runaway (the model repeating one line over and over)
// and truncate the garbage tail, keeping the clean prefix. Legit transcripts
// essentially never repeat the same >8-char, non-timestamp line >12 times, so
// the false-positive risk is negligible. Exported for unit testing.
export function stripRunawayRepetition(text: string): {
	text: string;
	runaway: boolean;
} {
	const lines = text.split("\n");
	const counts = new Map<string, number>();
	for (const line of lines) {
		const t = line.trim();
		if (t.length > 8 && !t.includes("-->")) {
			counts.set(t, (counts.get(t) ?? 0) + 1);
		}
	}
	let worst: string | null = null;
	let worstN = 0;
	for (const [t, n] of counts) {
		if (n > worstN) {
			worstN = n;
			worst = t;
		}
	}
	if (!worst || worstN <= 12) return { text, runaway: false };
	// Cut at the 3rd occurrence of the runaway line: keep a little context, drop
	// the loop. Downstream coverage/gap-fill handles the resulting short chunk.
	let seen = 0;
	let cutIdx = lines.length;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i]?.trim() === worst) {
			seen++;
			if (seen === 3) {
				cutIdx = i;
				break;
			}
		}
	}
	return { text: lines.slice(0, cutIdx).join("\n"), runaway: true };
}

/** Sleep `ms`, waking immediately (and rejecting) if `signal` aborts — so a
 * bounded free probe never blocks in a file-activation poll past its deadline. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("aborted"));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener?.("abort", onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		signal?.addEventListener?.("abort", onAbort, { once: true });
	});
}

async function pollUntilActive(
	fileName: string,
	apiKey: string,
	signal?: AbortSignal,
): Promise<void> {
	const maxAttempts = 30;
	for (let i = 0; i < maxAttempts; i++) {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
			{ signal },
		);
		if (!res.ok) {
			throw new Error(`Gemini file poll failed: ${res.status}`);
		}
		const data = (await res.json()) as { state: string };
		if (data.state === "ACTIVE") return;
		if (data.state === "FAILED") {
			throw new Error("Gemini file processing failed");
		}
		await abortableSleep(2000, signal);
	}
	throw new Error("Gemini file never reached ACTIVE state");
}

export function buildTranscriptionPrompt(
	opts: { knownSpeakers?: string[] } = {},
): string {
	const rosterBlock =
		opts.knownSpeakers && opts.knownSpeakers.length > 0
			? `\n\nKnown speakers identified earlier in this same recording: ${opts.knownSpeakers.join(", ")}.\nThis audio is a LATER segment of that same recording. When a voice clearly belongs to one of these people (they are named, addressed, or obvious from context), use exactly that label with the same spelling. Otherwise use the numbered fallback labels.`
			: "";
	return `You are a professional transcription editor for meeting, instruction video, and voice-note recordings.

Detect the dominant spoken language from the audio (Uzbek, Russian, or English) and transcribe the attached audio/video fully and accurately in that same language, exactly as spoken. Do not translate the recording into another language just because the app UI or these instructions are in English. A Russian recording must produce a Russian transcript, an English recording an English transcript, and an Uzbek recording an Uzbek transcript.

Rules:

1. Transcribe the entire file from beginning to end. Do not summarize, skip, shorten, or stop halfway.

2. Write each word in the language it is actually spoken. When the dominant language is Uzbek, write Uzbek words only in Uzbek Latin (not Cyrillic). Keep words spoken in another language in that language (see rule 8).

3. Detect the content type from the recording:
- If it is a multi-speaker online/offline meeting, identify speakers by voice, context, and conversation flow.
- Do NOT decide who is speaking from voice/tone alone. Voice is a hint, not proof. Confirm every speaker change against the CONTENT and CONVERSATION FLOW:
  - A question is normally followed by an answer from a DIFFERENT speaker. If cue N ends with a question ("...to'g'rimi?", "как думаешь?", "right?") and cue N+1 answers it, that answer is very likely the OTHER speaker, even if the voice sounds similar.
  - A short reply, agreement, or backchannel ("ha", "yo'q", "да", "хорошо", "ok", "mm-hmm", "tushunarli") interrupting or following someone else's longer turn is almost always the OTHER speaker's turn, not a continuation of the same speaker.
  - If the SAME speaker keeps talking without being addressed, interrupted, or asked something, do NOT split their speech into a new speaker label just because their tone, pitch, or energy changed (louder, faster, excited, calmer). Tone shifts inside one uninterrupted turn are the SAME speaker.
  - When two voices sound similar (e.g. two men or two women with close pitch), rely MORE on who is being addressed, whose question is being answered, and role patterns (e.g. one person asks most questions = interviewer/teacher, the other mostly answers = interviewee/student) to keep them separate and consistent — do not merge them into one label just because they sound alike.
  - Before assigning a label, check: does this content make sense as a continuation of what the same speaker was just saying, or does it read as a response/reaction to it? Continuations stay the same label; responses/reactions get the other speaker's label.
- ACTIVELY listen for speaker NAMES throughout the whole recording: self-introductions ("Men Alisherman", "Меня зовут Дмитрий", "This is John"), people addressing each other ("Alisher aka, siz nima deysiz?", "Спасибо, Дмитрий", "Thanks, Sarah"), and names used in conversation. When you can confidently attach a name to a voice, use that NAME as the voice label for EVERY cue of that voice, e.g. <v Alisher>.
- If a voice's name is never revealed, use a numbered label in the dominant language — Uzbek: Spiker 1, Spiker 2; Russian: Спикер 1, Спикер 2; English: Speaker 1, Speaker 2 — and keep the SAME label for the same voice throughout.
- Never use both a name and a number for the same voice; once the name is known, use only the name. Keep each speaker's label CONSISTENT across the whole recording by tracking their conversational role (who asks, who answers, who was introduced first), not just by re-recognizing their voice moment to moment.
- If two people talk over each other and both cannot be clearly separated, write [ustma-ust gaplashildi].
- If it is a one-speaker instruction, YouTube-style video, or voice note, do not invent speaker labels.
- If another person clearly speaks in the background and their words are important, use Boshqa ovoz.

4. Add real, accurate timestamps from the audio. Do not use sample, fake, guessed, estimated, or template timestamps.

Cue granularity — match how Loom / YouTube / Whisper subtitle a recording:
- Aim for short, readable cues. Most cues should be 3–10 seconds long and 1–2 sentences of text. Never let a single cue span more than ~15 seconds of audio.
- Start a NEW cue at every sentence boundary, at every natural pause longer than ~0.5s, when the speaker changes, and whenever the topic shifts. Do not pack multiple sentences from different moments into one cue.
- Cue ranges must NEVER overlap. Each cue's start must be ≥ the previous cue's end. Cues should also be roughly continuous (small gaps for silence are fine).
- Cover the recording end-to-end: the first cue should begin near 00:00, and the last cue's end should be at or near the actual audio duration. Do not leave large unexplained gaps at the beginning or middle.

5. Clean the transcript professionally:
- remove filler sounds like "umm", "aa", "eee", "э"
- remove repeated stutters
- remove meaningless false starts
- keep the original meaning and natural speaking style

6. If the recording contains direct instructions or tasks, transcribe them exactly as spoken. Do not convert them into a task list.

7. If a word is unclear, correct it based on surrounding context. If it is impossible to identify, write [noaniq] (or the equivalent "unclear" marker in the dominant language).

8. Keep words spoken in a language other than the dominant one exactly as spoken:
- Russian words stay in Cyrillic and bold, for example **сразу**, **любой**, **дефицит**
- English words stay in English/Latin and bold, for example **deadline**, **CRM**, **dashboard**
- Technical terms, product names, brand names, code identifiers, and acronyms must stay exactly as spoken.
- Do not translate words from one language into another.
- Do not transliterate Russian words into Latin.
- Do not convert English/technical words into the dominant language's spelling.
- These are HARD requirements: writing a Russian word in Latin letters (любой → lyuboy) is an ERROR; writing an English word in local spelling (deadline → dedlayn) is an ERROR. Never transliterate between scripts in either direction.
- Bold every word or phrase spoken in a language other than the dominant one.

Mixed-language examples (here the dominant language is Uzbek):
- Wrong: dedlayn. Correct: **deadline**.
- Wrong: boshqaruv paneli. Correct: **dashboard**.
- Wrong: srazu. Correct: **сразу**.
- Correct mixed sentence: Bugun **dashboard** **deadline** bor, **сразу** qilamiz.

9. Output only the transcript. No intro, no explanation, no table, no numbering.

IMPORTANT OUTPUT FORMAT:
- Output STANDARD WebVTT only.
- Start your response with a WEBVTT header line, then a blank line.
- For each cue, put the timestamp on its own line as HH:MM:SS.mmm --> HH:MM:SS.mmm.
- Put cue text on the next line(s), then a blank line before the next cue.
- Do NOT put timestamp and text on the same line.
- Do NOT wrap timestamps in markdown brackets like **[HH:MM:SS]**.
- For multi-speaker cues, use standard WebVTT voice tags with the speaker's name when identified, else the numbered label: <v Alisher>spoken text</v> or <v Spiker 1>spoken text</v>.
- For one-speaker recordings, write only the spoken text without a speaker label.
- The bold foreign-word rules still apply inside cue text.${rosterBlock}`;
}

export async function transcribeWithGemini(
	audioUrl: string,
	options: {
		apiKey: string;
		audioDurationSec?: number;
		knownSpeakers?: string[];
		/** Override the model list (e.g. a single free-tier model). Defaults to
		 * GEMINI_TRANSCRIBE_MODELS. */
		models?: readonly string[];
		/** Abort signal for the Tez free probe deadline. Threaded into every
		 * fetch so an abort actually cancels in-flight work (spec §4). Cleanup
		 * still runs best-effort with a fresh request even when aborted. */
		signal?: AbortSignal;
		/** Retry-attempt override. Tez free probe passes 1 (single attempt, no
		 * backoff); the paid path keeps the default 5. */
		maxAttempts?: number;
	},
): Promise<GeminiTranscribeResult> {
	const { apiKey, audioDurationSec = 300, knownSpeakers, signal } = options;
	const maxAttempts = options.maxAttempts ?? 5;
	const transcribeModels = options.models ?? GEMINI_TRANSCRIBE_MODELS;

	const audioResponse = await fetch(audioUrl, { signal });
	if (!audioResponse.ok) {
		throw new Error(
			`Audio URL not accessible: ${audioResponse.status} ${audioResponse.statusText}`,
		);
	}

	const audioBuffer = await audioResponse.arrayBuffer();
	const audioBytes = new Uint8Array(audioBuffer);
	const mimeType = detectMimeType(audioUrl);
	const displayName = `cap-audio-${Date.now()}`;

	const uploadUrl = await withGeminiRetry(
		async () => {
			const initRes = await fetch(
				`https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`,
				{
					method: "POST",
					headers: {
						"X-Goog-Upload-Protocol": "resumable",
						"X-Goog-Upload-Command": "start",
						"X-Goog-Upload-Header-Content-Length": String(audioBytes.byteLength),
						"X-Goog-Upload-Header-Content-Type": mimeType,
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ file: { display_name: displayName } }),
					signal,
				},
			);

			if (!initRes.ok) {
				throw new Error(`Gemini upload init failed (HTTP ${initRes.status})`);
			}

			const url = initRes.headers.get("x-goog-upload-url");
			if (!url) {
				throw new Error("No upload URL from Gemini Files API");
			}
			return url;
		},
		maxAttempts,
		signal,
	);

	const fileData = await withGeminiRetry(
		async () => {
			const uploadRes = await fetch(uploadUrl, {
				method: "PUT",
				headers: {
					"X-Goog-Upload-Offset": "0",
					"X-Goog-Upload-Command": "upload, finalize",
					"Content-Length": String(audioBytes.byteLength),
				},
				body: audioBytes,
				signal,
			});

			if (!uploadRes.ok) {
				throw new Error(`Gemini audio upload failed (HTTP ${uploadRes.status})`);
			}

			return (await uploadRes.json()) as GeminiFileResponse;
		},
		maxAttempts,
		signal,
	);
	const { name: fileName, uri: fileUri, state } = fileData.file;

	if (!fileUri || !fileName) {
		throw new Error(
			`Gemini upload response missing file info: ${JSON.stringify(fileData)}`,
		);
	}

	if (state !== "ACTIVE") {
		await withGeminiRetry(
			() => pollUntilActive(fileName, apiKey, signal),
			maxAttempts,
			signal,
		);
	}

	type GenData = {
		candidates?: Array<{
			content: { parts: Array<{ text?: string }> };
		}>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
			promptTokensDetails?: Array<{ modality?: string; tokenCount?: number }>;
		};
		error?: { message: string };
	};

	// Best-effort cleanup of the uploaded Files API object. Runs on the normal
	// return AND on any throw/abort mid-generation via the finally below, always
	// with a fresh request (spec §4).
	const cleanupUploadedFile = () => {
		fetch(
			`https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${apiKey}`,
			{ method: "DELETE" },
		).catch(() => {});
	};

	try {
		let genRes!: Response;
		let genData!: GenData;
		for (let mi = 0; mi < transcribeModels.length; mi++) {
			const model = transcribeModels[mi];
			try {
				({ genRes, genData } = await withGeminiRetry(async () => {
					const res = await fetch(
						`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
						{
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								contents: [
									{
										parts: [
											{
												fileData: {
													mimeType,
													fileUri,
												},
											},
											{ text: buildTranscriptionPrompt({ knownSpeakers }) },
										],
									},
								],
								generationConfig: {
									temperature: 0.1,
									maxOutputTokens: TRANSCRIBE_MAX_OUTPUT_TOKENS,
									thinkingConfig: { thinkingBudget: 0 },
								},
							}),
							signal,
						},
					);

					const data = (await res.json()) as GenData;

					if (!res.ok) {
						const errMsg = `Gemini generateContent failed (HTTP ${res.status}): ${data.error?.message ?? "unknown"}`;
						if (isTransientGeminiError(res.status, data.error?.message ?? "")) {
							throw new Error(errMsg);
						}
						// Non-transient: throw a special marker so withGeminiRetry skips retries
						const e = new Error(errMsg);
						(e as Error & { permanent?: boolean }).permanent = true;
						throw e;
					}

					return { genRes: res, genData: data };
				}, maxAttempts, signal));
				break; // primary model succeeded
			} catch (err) {
				const isPermanent = (err as { permanent?: boolean })?.permanent === true;
				const isLastModel = mi === transcribeModels.length - 1;
				if (isPermanent || isLastModel) throw err;
				const nextModel = transcribeModels[mi + 1];
				console.warn(
					`[gemini-transcribe] model ${model} overloaded, falling back to ${nextModel}`,
				);
			}
		}

		if (!genRes.ok) {
			throw new Error(
				`Gemini generateContent failed: ${genData.error?.message ?? genRes.status}`,
			);
		}

		const rawText = genData.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
		const inputTokens = genData.usageMetadata?.promptTokenCount ?? 0;
		const outputTokens = genData.usageMetadata?.candidatesTokenCount ?? 0;
		const audioInTokens =
			genData.usageMetadata?.promptTokensDetails?.find(
				(d) => d.modality === "AUDIO",
			)?.tokenCount ?? 0;

		// [diag] long-audio near-empty transcript — tells us whether Gemini itself
		// returned little (finishReason / 0 output) or our parser dropped cues
		// (rawText long but saved VTT tiny). Remove after the 10-min case is fixed.
		const finishReason = (
			genData.candidates?.[0] as { finishReason?: string } | undefined
		)?.finishReason;
		console.log(
			`[gemini-transcribe] rawText.length=${rawText.length} outputTokens=${outputTokens} finishReason=${finishReason} durationSec=${audioDurationSec} preview=${JSON.stringify(rawText.slice(0, 220))}`,
		);

		// Always normalize Gemini's raw output into STANDARD WebVTT before saving,
		// regardless of the shape it returns (inline cues, single timestamps, etc.).
		// This keeps the AI workflow's parser happy and keeps HTML <track> captions valid.
		const { text: guardedText, runaway } = stripRunawayRepetition(rawText);
		if (runaway) {
			console.warn(
				`[gemini-transcribe] RUNAWAY repetition detected (outputTokens=${outputTokens}, finishReason=${finishReason}); truncated garbage tail, kept clean prefix`,
			);
		}

		if (guardedText.trim().length === 0) {
			throw new Error(
				`[gemini-transcribe] empty transcript from Gemini (finishReason=${finishReason}); not saving as complete`,
			);
		}

		const transcriptVtt = normalizeToWebVtt(guardedText, audioDurationSec);
		if (!transcriptVtt.includes("-->")) {
			console.warn(
				"[gemini-transcribe] Gemini did not return usable WEBVTT timestamps; fabricated approximate timestamps from plain text fallback.",
			);
		}

		return { transcriptVtt, inputTokens, outputTokens, audioInTokens };
	} finally {
		cleanupUploadedFile();
	}
}
