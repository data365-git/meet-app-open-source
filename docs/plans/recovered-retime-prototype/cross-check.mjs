// Hole-vs-compression: is the tail text of guarded chunks PRESENT in vtt-live?
// Uses vtt-baseline-6min (independent transcription run) as the text oracle.
import fs from "node:fs";
import path from "node:path";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";

function parseTs(ts) {
  const p = ts.trim().split(":");
  let h = 0, m = 0, s = "0";
  if (p.length === 3) [h, m, s] = [+p[0], +p[1], p[2]];
  else if (p.length === 2) [m, s] = [+p[0], p[1]];
  else return null;
  const sec = parseFloat(s);
  return Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(sec) ? null : h * 3600 + m * 60 + sec;
}
function parseVttWithText(file) {
  const lines = fs.readFileSync(path.join(SCRATCH, file), "utf8").split(/\r?\n/);
  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const arrow = lines[i].indexOf("-->");
    if (arrow < 0) continue;
    const start = parseTs(lines[i].slice(0, arrow));
    const end = parseTs(lines[i].slice(arrow + 3).trim().split(/\s+/)[0]);
    if (start == null || end == null) continue;
    let text = "";
    for (let j = i + 1; j < lines.length && lines[j].trim() !== "" && !lines[j].includes("-->"); j++) text += lines[j] + " ";
    cues.push({ start, end, text: text.trim() });
  }
  return cues;
}
const norm = (s) => s.toLowerCase().replace(/[ʼ'`’]/g, "'").replace(/[^a-zа-яёўқғҳo'\s]/gi, " ").replace(/\s+/g, " ").trim();
const words = (s) => norm(s).split(" ").filter(w => w.length >= 4); // content words only

const live = parseVttWithText("vtt-live.vtt");
const base = parseVttWithText("vtt-baseline-6min.vtt");
const liveWordSet = new Set(live.flatMap(c => words(c.text)));

// guarded chunks from warp4 run (k, c0, c1, M) — from chunk-density output
const guarded = [
  [2, 721, 1081, 107], [5, 1800, 2160, 91], [6, 2160, 2521, 99],
  [9, 3240, 3600, 69], [10, 3600, 3955, 90], [11, 3955, 4316, 81],
  [12, 4316, 4673, 86], [15, 5394, 5754, 82], [16, 5754, 6115, 101],
];
console.log("chunk | tailWindow(audio) | baseCues | foundInLive% (per-cue word-hit rates)");
for (const [k, c0, c1, M] of guarded) {
  // baseline cues whose times fall in the tail window (baseline drifts +0..30s ahead,
  // so widen: [c1-M-35, c1+5])
  const tail = base.filter(c => c.start >= c1 - M - 35 && c.start < c1 + 5);
  if (!tail.length) { console.log(`k${k} | ${(c1 - M).toFixed(0)}-${c1.toFixed(0)} | 0 cues | n/a`); continue; }
  const rates = tail.map(c => {
    const ws = words(c.text);
    if (!ws.length) return null;
    const hit = ws.filter(w => liveWordSet.has(w)).length;
    return hit / ws.length;
  }).filter(r => r != null);
  const found = rates.filter(r => r >= 0.6).length;
  console.log(`k${k} | ${(c1 - M).toFixed(0)}-${c1.toFixed(0)}s | ${rates.length} cues | ${(found / rates.length * 100).toFixed(0)}% [${rates.map(r => r.toFixed(2)).join(",")}]`);
}
// control: HEALTHY chunk tails should be ~100% found
console.log("--- controls (healthy chunks k3,k8,k13) ---");
for (const [k, c0, c1] of [[3, 1081, 1440], [8, 2882, 3240], [13, 4673, 5033]]) {
  const tail = base.filter(c => c.start >= c1 - 90 && c.start < c1 + 5);
  const rates = tail.map(c => {
    const ws = words(c.text);
    if (!ws.length) return null;
    const hit = ws.filter(w => liveWordSet.has(w)).length;
    return hit / ws.length;
  }).filter(r => r != null);
  const found = rates.filter(r => r >= 0.6).length;
  console.log(`k${k} | ${(c1 - 90).toFixed(0)}-${c1.toFixed(0)}s | ${rates.length} cues | ${(found / rates.length * 100).toFixed(0)}%`);
}
