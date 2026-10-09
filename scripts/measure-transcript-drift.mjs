// Measure transcript↔audio DRIFT for a real video, with no ElevenLabs and no
// human listening. Ground truth = short audio snippets cut at KNOWN offsets and
// transcribed on their own (a 20s clip has no room for Gemini's within-chunk
// clock drift), then located inside the full transcript.
//
//   drift(sample) = vttTimeWhereTextSits - trueOffsetSec
//
// Positive drift = the transcript claims the words happened LATER than they did;
// negative = earlier ("cues run ahead"). We report signed mean + max |drift|.
//
// Runs ON THE SERVER (inside the app container: ffmpeg-static, GEMINI key and R2
// creds all live there). Usage:
//   node measure-transcript-drift.mjs <videoId> [sampleCount] [sampleSec]
//
// Reads only: the video's result.mp4 + transcription.vtt from storage. Writes
// nothing to the database. Safe to run against production.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const videoId = process.argv[2];
const SAMPLES = Number(process.argv[3] ?? 10);
const SAMPLE_SEC = Number(process.argv[4] ?? 20);
if (!videoId) {
	console.error("usage: node measure-transcript-drift.mjs <videoId> [samples] [sampleSec]");
	process.exit(2);
}

const GEMINI_KEY = process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY_FREE;
if (!GEMINI_KEY) {
	console.error("no GEMINI_API_KEY in env");
	process.exit(2);
}
// Same model family the pipeline uses for transcription; a 20s clip is cheap.
const MODEL = process.env.DRIFT_PROBE_MODEL || "gemini-2.5-flash";

// ── inputs: the media URL and the VTT are passed in by the wrapper (it holds
// the storage credentials); this script takes plain files/URLs so it stays
// dumb and re-runnable.
const MEDIA = process.env.DRIFT_MEDIA_URL; // signed URL or local path
const VTT_PATH = process.env.DRIFT_VTT_PATH; // local path to transcription.vtt
if (!MEDIA || !VTT_PATH) {
	console.error("set DRIFT_MEDIA_URL and DRIFT_VTT_PATH (see wrapper)");
	process.exit(2);
}

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const work = mkdtempSync(join(tmpdir(), "drift-"));

// ── VTT parsing ────────────────────────────────────────────────────────────
const toSec = (ts) => {
	const m = ts.match(/(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/);
	if (!m) return null;
	return (
		Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000
	);
};
function parseVtt(text) {
	const cues = [];
	for (const block of text.split(/\r?\n\r?\n/)) {
		const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
		const i = lines.findIndex((l) => l.includes("-->"));
		if (i === -1) continue;
		const [a, b] = lines[i].split("-->").map((s) => s.trim());
		const start = toSec(a);
		const end = toSec(b);
		if (start == null || end == null) continue;
		cues.push({ start, end, text: lines.slice(i + 1).join(" ") });
	}
	return cues;
}

// ── text matching: normalized word n-gram overlap ───────────────────────────
const norm = (s) =>
	s
		.toLowerCase()
		.replace(/['’`]/g, "")
		.replace(/[^\p{L}\p{N}\s]/gu, " ")
		.split(/\s+/)
		.filter((w) => w.length > 2);

function bestMatch(cues, probeWords) {
	// Slide a window of cues covering ~SAMPLE_SEC and score word overlap.
	const probe = new Set(probeWords);
	let best = { score: 0, start: null, matched: 0 };
	for (let i = 0; i < cues.length; i++) {
		const words = [];
		let j = i;
		while (j < cues.length && cues[j].start - cues[i].start <= SAMPLE_SEC * 1.5) {
			words.push(...norm(cues[j].text));
			j++;
		}
		if (words.length === 0) continue;
		let hit = 0;
		for (const w of new Set(words)) if (probe.has(w)) hit++;
		const score = hit / Math.max(4, probe.size);
		if (score > best.score) {
			best = { score, start: cues[i].start, matched: hit };
		}
	}
	return best;
}

// ── Gemini transcription of one snippet ────────────────────────────────────
async function transcribeSnippet(filePath) {
	const b64 = readFileSync(filePath).toString("base64");
	const res = await fetch(
		`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				contents: [
					{
						parts: [
							{
								text: "Transcribe this audio verbatim. Output ONLY the spoken words, no timestamps, no commentary.",
							},
							{ inlineData: { mimeType: "audio/mp3", data: b64 } },
						],
					},
				],
			}),
		},
	);
	if (!res.ok) throw new Error(`gemini ${res.status}: ${(await res.text()).slice(0, 200)}`);
	const data = await res.json();
	return (
		data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join(" ") ?? ""
	);
}

// ── main ───────────────────────────────────────────────────────────────────
const vtt = parseVtt(readFileSync(VTT_PATH, "utf8"));
if (vtt.length === 0) {
	console.error("VTT had no cues");
	process.exit(1);
}
const lastCueEnd = vtt[vtt.length - 1].end;
console.log(`[drift] ${videoId}: ${vtt.length} cues, last cue ends ${lastCueEnd.toFixed(0)}s`);

// Probe evenly across the middle 90% (skip the very start/end), or across an
// explicit [DRIFT_FROM, DRIFT_TO] window — dense sampling inside ONE chunk is
// what reveals the drift SHAPE (linear-within-chunk vs step), which decides
// whether a per-chunk rescale can fix it.
const from = process.env.DRIFT_FROM ? Number(process.env.DRIFT_FROM) : null;
const to = process.env.DRIFT_TO ? Number(process.env.DRIFT_TO) : null;
const span = lastCueEnd;
const offsets =
	from != null && to != null
		? Array.from({ length: SAMPLES }, (_, i) =>
				Math.round(from + ((to - from) * i) / Math.max(1, SAMPLES - 1)),
			)
		: Array.from({ length: SAMPLES }, (_, i) =>
				Math.round(span * (0.05 + (0.9 * i) / Math.max(1, SAMPLES - 1))),
			);

// A drift larger than this cannot be real: cues re-anchor at every chunk start,
// so the ceiling is one chunk length. Anything beyond it is the text matcher
// landing on a repeated phrase — count it as an instrument miss, not as drift.
const IMPLAUSIBLE_DRIFT_SEC = Number(process.env.DRIFT_SANITY_SEC ?? 400);

const rows = [];
for (const off of offsets) {
	const clip = join(work, `s-${off}.mp3`);
	const cut = spawnSync(
		ffmpeg,
		["-hide_banner", "-loglevel", "error", "-ss", String(off), "-t", String(SAMPLE_SEC),
		 "-i", MEDIA, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-y", clip],
		{ encoding: "utf8" },
	);
	if (cut.status !== 0) {
		console.log(`[drift] ${off}s: ffmpeg failed — ${(cut.stderr ?? "").slice(0, 120)}`);
		continue;
	}
	let text = "";
	try {
		text = await transcribeSnippet(clip);
	} catch (e) {
		console.log(`[drift] ${off}s: gemini failed — ${e.message}`);
		continue;
	}
	const words = norm(text);
	if (words.length < 5) {
		console.log(`[drift] ${off}s: snippet had too few words (silence?) — skipped`);
		continue;
	}
	const m = bestMatch(vtt, words);
	// STRONG matches only, by default. A 0.33-score match can sit one or two cues
	// off, which is ~10s of pure instrument error on a single sample — and a
	// single bad sample sets the reported MAX, the number people quote. Measured
	// 2026-07-20: samples ranged 0.33-0.98 and the worst-looking outlier of one
	// run turned out to be the weakest match in it. Override with
	// DRIFT_MIN_SCORE=0.25 to reproduce an old reading.
	const MIN_SCORE = Number(process.env.DRIFT_MIN_SCORE ?? 0.5);
	if (m.score < MIN_SCORE || m.start == null) {
		console.log(
			`[drift] ${off}s: no confident match (score ${m.score.toFixed(2)} < ${MIN_SCORE}) — skipped`,
		);
		continue;
	}
	const drift = m.start - off;
	if (Math.abs(drift) > IMPLAUSIBLE_DRIFT_SEC) {
		console.log(
			`[drift] ${off}s: matched at ${m.start.toFixed(0)}s → ${drift.toFixed(0)}s, beyond the one-chunk ceiling — INSTRUMENT MISS (repeated phrase), excluded`,
		);
		continue;
	}
	rows.push({ off, vttStart: m.start, drift, score: m.score });
	console.log(
		`[drift] true ${off}s -> transcript ${m.start.toFixed(0)}s  drift ${drift >= 0 ? "+" : ""}${drift.toFixed(1)}s  (match ${m.score.toFixed(2)})`,
	);
}

if (rows.length === 0) {
	console.log("RESULT=UNMEASURED reason=no-usable-samples");
	process.exit(1);
}
const abs = rows.map((r) => Math.abs(r.drift));
const mean = rows.reduce((a, r) => a + r.drift, 0) / rows.length;
const meanAbs = abs.reduce((a, b) => a + b, 0) / abs.length;
const max = Math.max(...abs);
const out = {
	videoId,
	samples: rows.length,
	meanSignedDriftSec: Number(mean.toFixed(2)),
	meanAbsDriftSec: Number(meanAbs.toFixed(2)),
	maxAbsDriftSec: Number(max.toFixed(2)),
	rows,
};
// Report the UNCERTAINTY next to the numbers, not in a doc nobody opens. Two
// sources dominate: (1) cue-start quantization — a match resolves to the START of
// a cue, so with ~4.5s median cue length every sample carries a few seconds of
// error even against a perfect transcript; (2) sampling — with this much scatter,
// a 12-sample mean has a standard error of a couple of seconds. Without these on
// screen it is far too easy to report "10.2s vs 7.8s" as an improvement when the
// instrument cannot tell them apart.
const sd =
	rows.length > 1
		? Math.sqrt(
				abs.reduce((a, b) => a + (b - meanAbs) ** 2, 0) / (rows.length - 1),
			)
		: 0;
const stderr = rows.length > 0 ? sd / Math.sqrt(rows.length) : 0;
const worstScore = Math.min(...rows.map((r) => r.score));
out.meanAbsStdErrSec = Number(stderr.toFixed(2));
out.weakestMatchScore = Number(worstScore.toFixed(2));
writeFileSync(join(work, "drift.json"), JSON.stringify(out, null, 2));
console.log(
	`RESULT max_abs=${out.maxAbsDriftSec}s mean_abs=${out.meanAbsDriftSec}s (±${out.meanAbsStdErrSec}s stderr) mean_signed=${out.meanSignedDriftSec}s samples=${out.samples} weakest_match=${out.weakestMatchScore}`,
);
console.log(
	`note: differences smaller than ~${(2 * stderr).toFixed(1)}s are NOT distinguishable by this instrument.`,
);
console.log(`json: ${join(work, "drift.json")}`);
