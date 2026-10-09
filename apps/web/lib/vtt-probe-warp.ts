/**
 * Probe-anchored piecewise VTT warp — ladder step ④ of the "Gemini-only
 * maximum accuracy" directive (owner, 2026-07-29; design consultation with an
 * independent reviewer folded in, see docs/plans/2026-07-29-timestamp-ladder-v2.md).
 *
 * The idea: after transcription, pick a handful of HIGH-INFORMATION cues, ask
 * Gemini to localize each cue's exact text inside a narrow audio window around
 * its claimed time ("known-text localization" — stronger than blind
 * transcription + fuzzy matching), and warp the whole VTT through the accepted
 * anchors with a monotone piecewise-linear map.
 *
 * This module is the PURE half: anchor-candidate selection, anchor acceptance
 * (outlier/monotonicity filtering), and the warp itself. No I/O, no AI calls —
 * the workflow step owns those. Every reviewer-named failure mode has a
 * corresponding guard here, each pinned by a unit test:
 *   - repeated/backchannel text must never anchor (uniqueness + length gates)
 *   - a lone bad probe must not corrupt the video (bounded shift, outlier drop)
 *   - out-of-order anchors are filtered, not clamped into piles
 *   - no extrapolation beyond the first/last accepted anchor (identity outside)
 *   - cue order, minimum duration and bounds survive the warp
 */

export interface VttCueRef {
	/** Cue start in seconds (absolute). */
	start: number;
	/** Cue end in seconds (absolute). */
	end: number;
	/** Cue text with voice tags stripped. */
	text: string;
}

export interface ProbeAnchorCandidate {
	/** The cue this candidate would anchor. */
	cue: VttCueRef;
	/** Normalized high-information text to hand the localizer. */
	probeText: string;
}

export interface AcceptedAnchor {
	/** Where the VTT currently CLAIMS the text starts (seconds). */
	claimedSec: number;
	/** Where the audio actually holds it (seconds). */
	actualSec: number;
}

const MIN_PROBE_WORDS = 5;
const MAX_PROBE_WORDS = 14;
/** A candidate's normalized text must be unique in the transcript — a repeated
 * phrase can localize to the WRONG occurrence, which is worse than no anchor. */
const BACKCHANNEL = new Set([
	"xo'p",
	"mhm",
	"aha",
	"ha",
	"yaxshi",
	"mayli",
	"rahmat",
	"davom",
	"etamiz",
]);

export function normalizeProbeText(text: string): string {
	return text
		.replace(/<[^>]+>/g, " ")
		.replace(/\*\*/g, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s']/gu, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function contentWords(normalized: string): string[] {
	return normalized.split(" ").filter((w) => w.length >= 3);
}

/** Parse absolute-time cues out of a WebVTT string. Tolerant of voice tags and
 * settings after the end timestamp; ignores non-timing blocks. */
export function parseVttCues(vtt: string): VttCueRef[] {
	const cues: VttCueRef[] = [];
	const re =
		/(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})[^\n]*\n([\s\S]*?)(?=\n\n|\n*$)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(vtt))) {
		const start =
			Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
		const end =
			Number(m[5]) * 3600 + Number(m[6]) * 60 + Number(m[7]) + Number(m[8]) / 1000;
		const text = (m[9] ?? "")
			.split("\n")
			.map((l) => l.trim())
			.filter(Boolean)
			.join(" ");
		if (text) cues.push({ start, end, text });
	}
	return cues;
}

/**
 * Pick up to `maxCandidates` cues worth probing, spread across the video.
 * Gates (each is a reviewer-named failure mode, see the header):
 *   - 5–14 content words: long enough to be findable, short enough for one window
 *   - UNIQUE normalized text (first occurrence of a duplicate disqualifies BOTH —
 *     localizing either could hit the other occurrence)
 *   - not composed mostly of backchannel words
 *   - spread: at most one candidate per `minGapSec` of timeline
 */
export function selectProbeCandidates(
	cues: VttCueRef[],
	maxCandidates: number,
	minGapSec = 120,
): ProbeAnchorCandidate[] {
	const counts = new Map<string, number>();
	for (const cue of cues) {
		const n = normalizeProbeText(cue.text);
		counts.set(n, (counts.get(n) ?? 0) + 1);
	}
	const out: ProbeAnchorCandidate[] = [];
	let lastTaken = Number.NEGATIVE_INFINITY;
	for (const cue of cues) {
		if (out.length >= maxCandidates) break;
		if (cue.start - lastTaken < minGapSec) continue;
		const normalized = normalizeProbeText(cue.text);
		if ((counts.get(normalized) ?? 0) !== 1) continue;
		const words = contentWords(normalized);
		if (words.length < MIN_PROBE_WORDS || words.length > MAX_PROBE_WORDS)
			continue;
		const backchannelShare =
			words.filter((w) => BACKCHANNEL.has(w)).length / words.length;
		if (backchannelShare > 0.4) continue;
		out.push({ cue, probeText: normalized });
		lastTaken = cue.start;
	}
	return out;
}

/**
 * Filter raw probe results into a usable anchor set.
 *   - |shift| > maxShiftSec → discarded (a localization that far off is far more
 *     likely a wrong match than a real error of that size)
 *   - anchors must be strictly increasing in BOTH claimed and actual time;
 *     violators are dropped greedily (keep the earlier anchor), never clamped
 *   - fewer than `minAnchors` survivors → empty set (the warp then no-ops)
 */
export function acceptAnchors(
	raw: AcceptedAnchor[],
	options?: { maxShiftSec?: number; minAnchors?: number },
): AcceptedAnchor[] {
	const maxShift = options?.maxShiftSec ?? 45;
	const minAnchors = options?.minAnchors ?? 3;
	const bounded = raw
		.filter((a) => Math.abs(a.actualSec - a.claimedSec) <= maxShift)
		.sort((a, b) => a.claimedSec - b.claimedSec);
	const monotone: AcceptedAnchor[] = [];
	for (const a of bounded) {
		const prev = monotone[monotone.length - 1];
		if (prev && (a.claimedSec <= prev.claimedSec || a.actualSec <= prev.actualSec))
			continue;
		monotone.push(a);
	}
	return monotone.length >= minAnchors ? monotone : [];
}

/**
 * Warp every cue time through the anchor map:
 *   - inside [firstAnchor, lastAnchor]: piecewise-linear interpolation
 *   - OUTSIDE: constant offset of the nearest anchor (no slope extrapolation —
 *     extending a distant segment's slope through silence is how endpoints get
 *     mangled; a constant shift is the conservative continuation)
 *   - afterwards: global monotone pass, end ≥ start + 0.2s, clamp to
 *     [0, totalDurationSec] when provided
 * Returns the input string UNCHANGED (===) when anchors is empty.
 */
export function warpVtt(
	vtt: string,
	anchors: AcceptedAnchor[],
	totalDurationSec?: number,
): { vtt: string; applied: boolean; medianShiftSec: number } {
	if (anchors.length === 0) return { vtt, applied: false, medianShiftSec: 0 };

	const mapTime = (t: number): number => {
		const first = anchors[0] as AcceptedAnchor;
		const last = anchors[anchors.length - 1] as AcceptedAnchor;
		if (t <= first.claimedSec) return t + (first.actualSec - first.claimedSec);
		if (t >= last.claimedSec) return t + (last.actualSec - last.claimedSec);
		for (let i = 0; i < anchors.length - 1; i++) {
			const a = anchors[i] as AcceptedAnchor;
			const b = anchors[i + 1] as AcceptedAnchor;
			if (t >= a.claimedSec && t <= b.claimedSec) {
				const f = (t - a.claimedSec) / (b.claimedSec - a.claimedSec);
				return a.actualSec + f * (b.actualSec - a.actualSec);
			}
		}
		return t;
	};

	const shifts: number[] = [];
	const timing =
		/(\d{2}):(\d{2}):(\d{2})\.(\d{3})(\s*-->\s*)(\d{2}):(\d{2}):(\d{2})\.(\d{3})/;
	const fmt = (sec: number): string => {
		const s = Math.max(0, sec);
		const h = Math.floor(s / 3600);
		const min = Math.floor((s % 3600) / 60);
		const ss = Math.floor(s % 60);
		const ms = Math.round((s - Math.floor(s)) * 1000);
		const p = (n: number, w: number) => String(n).padStart(w, "0");
		return `${p(h, 2)}:${p(min, 2)}:${p(ss, 2)}.${p(ms, 3)}`;
	};

	let prevStart = 0;
	const lines = vtt.split("\n").map((line) => {
		const m = line.match(timing);
		if (!m) return line;
		const start =
			Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
		const end =
			Number(m[6]) * 3600 + Number(m[7]) * 60 + Number(m[8]) + Number(m[9]) / 1000;
		let ns = mapTime(start);
		let ne = mapTime(end);
		shifts.push(Math.abs(ns - start));
		// Monotone + duration + bounds — order must survive the warp.
		if (ns < prevStart) ns = prevStart;
		if (ne < ns + 0.2) ne = ns + 0.2;
		if (totalDurationSec != null) {
			ns = Math.min(ns, totalDurationSec);
			ne = Math.min(ne, Math.max(totalDurationSec, ns + 0.2));
		}
		prevStart = ns;
		return line.replace(timing, `${fmt(ns)}$5${fmt(ne)}`);
	});

	const sorted = [...shifts].sort((a, b) => a - b);
	const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
	return { vtt: lines.join("\n"), applied: true, medianShiftSec: median };
}
