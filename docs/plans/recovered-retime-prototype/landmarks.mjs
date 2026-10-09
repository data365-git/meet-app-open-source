// Direct landmark probe: long audio silences vs nearest transcript gaps.
// node landmarks.mjs <vtt> [minSilence] [minGap]
import fs from "node:fs";
import path from "node:path";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const TOTAL = 6993.71;

const log = fs.readFileSync(path.join(SCRATCH, "silencedetect.log"), "utf8");
const starts = [...log.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map(m => +m[1]);
const ends = [...log.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map(m => +m[1]);
const silences = starts.map((s, i) => ({ start: s, end: ends[i] ?? TOTAL, dur: (ends[i] ?? TOTAL) - s }));

function parseTs(ts) {
  const p = ts.trim().split(":");
  let h = 0, m = 0, s = "0";
  if (p.length === 3) [h, m, s] = [+p[0], +p[1], p[2]];
  else if (p.length === 2) [m, s] = [+p[0], p[1]];
  else return null;
  const sec = parseFloat(s);
  return Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(sec) ? null : h * 3600 + m * 60 + sec;
}
const [vttPath, minSilArg, minGapArg] = process.argv.slice(2);
const MIN_SIL = minSilArg ? +minSilArg : 4;
const MIN_GAP = minGapArg ? +minGapArg : 1.0;
const text = fs.readFileSync(vttPath, "utf8");
const cues = [];
for (const line of text.split(/\r?\n/)) {
  const arrow = line.indexOf("-->");
  if (arrow < 0) continue;
  const start = parseTs(line.slice(0, arrow));
  const end = parseTs(line.slice(arrow + 3).trim().split(/\s+/)[0]);
  if (start == null || end == null) continue;
  cues.push({ start, end });
}
// transcript gaps (between consecutive cue end -> next start)
const gaps = [];
for (let i = 0; i < cues.length - 1; i++) {
  const g = cues[i + 1].start - cues[i].end;
  if (g >= MIN_GAP) gaps.push({ start: cues[i].end, end: cues[i + 1].start, dur: g });
}
const longSil = silences.filter(s => s.dur >= MIN_SIL && s.start > 30 && s.end < TOTAL - 5);
console.log(`long silences (>=${MIN_SIL}s): ${longSil.length} | transcript gaps (>=${MIN_GAP}s): ${gaps.length}`);
console.log("audioSilence(min:sec dur) -> nearestTranscriptGap(dur) offset=gapStart-silStart (negative = transcript AHEAD)");
for (const s of longSil) {
  // nearest gap by start within +-120s
  let best = null, bestD = 1e9;
  for (const g of gaps) {
    const d = Math.abs(g.start - s.start);
    if (d < bestD) { bestD = d; best = g; }
  }
  const mm = Math.floor(s.start / 60), ss = (s.start % 60).toFixed(0);
  if (!best || bestD > 120) { console.log(`${mm}m${ss}s dur=${s.dur.toFixed(1)} -> NO GAP within 120s`); continue; }
  const off = best.start - s.start;
  console.log(`${mm}m${String(ss).padStart(2, "0")}s dur=${s.dur.toFixed(1)}s -> gap dur=${best.dur.toFixed(1)}s offset=${off.toFixed(1)}s`);
}
