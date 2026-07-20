// Per-chunk text-density diagnostic: hole (text missing) vs compression (time squeezed).
import fs from "node:fs";
import path from "node:path";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const TOTAL = 6993.71;
const TARGET_CHUNK = 360;

const log = fs.readFileSync(path.join(SCRATCH, "silencedetect.log"), "utf8");
const sStarts = [...log.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map(m => +m[1]);
const sEnds = [...log.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map(m => +m[1]);
const silences = sStarts.map((s, i) => ({ start: s, end: sEnds[i] ?? TOTAL }));

function anchoredCuts(silences, totalDurationSec, targetChunkSec) {
  const sorted = silences.filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
  const WINDOW = targetChunkSec * 0.4, MIN_CHUNK = 60;
  const first = sorted[0];
  const firstOnset = first && first.start <= 1.0 ? first.end : 0;
  const boundaries = [firstOnset];
  let pos = firstOnset;
  while (totalDurationSec - pos > targetChunkSec + WINDOW) {
    const target = pos + targetChunkSec;
    let candidate = null, candidateDist = Infinity;
    for (const s of sorted) {
      if (s.end < target - WINDOW || s.end > target + WINDOW) continue;
      const dist = Math.abs(s.end - target);
      if (dist < candidateDist) { candidateDist = dist; candidate = s; }
    }
    let cutAt = candidate ? candidate.end : target;
    if (cutAt - pos < MIN_CHUNK) cutAt = pos + targetChunkSec;
    boundaries.push(cutAt);
    pos = cutAt;
  }
  return boundaries;
}

function parseTs(ts) {
  const p = ts.trim().split(":");
  let h = 0, m = 0, s = "0";
  if (p.length === 3) [h, m, s] = [+p[0], +p[1], p[2]];
  else if (p.length === 2) [m, s] = [+p[0], p[1]];
  else return null;
  const sec = parseFloat(s);
  return Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(sec) ? null : h * 3600 + m * 60 + sec;
}
// parse cues WITH text
const lines = fs.readFileSync(path.join(SCRATCH, "vtt-live.vtt"), "utf8").split(/\r?\n/);
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

const boundaries = anchoredCuts(silences, TOTAL, TARGET_CHUNK);
console.log("k | c0(min) | dur | geminiSpan | M | pauses(dSil) | chars | ch/audioSec | ch/gemSec | lastCueEndsAt(rel)");
for (let k = 0; k < boundaries.length; k++) {
  const c0 = boundaries[k];
  const c1 = k + 1 < boundaries.length ? boundaries[k + 1] : TOTAL;
  const dur = c1 - c0;
  const inChunk = cues.filter(c => c.start >= c0 - 0.01 && c.start < c1 - 0.01);
  if (!inChunk.length) { console.log(`${k} | ${(c0 / 60).toFixed(1)} | ${dur.toFixed(0)} | NO CUES`); continue; }
  const span = Math.max(...inChunk.map(c => Math.min(c.end, c.start + 30))) - c0;
  const M = dur - span;
  const dSil = silences
    .filter(s => s.end > c0 && s.start < c1)
    .reduce((t, s) => t + Math.min(c1, s.end) - Math.max(c0, s.start), 0);
  const chars = inChunk.reduce((t, c) => t + c.text.length, 0);
  console.log(
    `${k} | ${(c0 / 60).toFixed(1)}m | ${dur.toFixed(0)} | ${span.toFixed(0)} | ${M.toFixed(0)} | ${dSil.toFixed(0)} | ${chars} | ${(chars / dur).toFixed(1)} | ${(chars / span).toFixed(1)} | ${(Math.max(...inChunk.map(c => c.end)) - c0).toFixed(0)}`,
  );
}
