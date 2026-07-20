// v4: DETERMINISTIC pause-reinsertion retiming (no correlation).
// Model: Gemini's within-chunk clock partially skips pauses. Per chunk:
//   M = chunkDur - geminiSpan  (missing time)
//   redistribute M into the chunk's real silences (proportional), keeping
//   speech slope 1; if M exceeds total silence, linear-stretch the rest.
// Anchors: chunk start (exact), chunk end (exact by construction).
// usage: node warp4.mjs <vtt> <cutMode: anchored|fixed> [out.vtt]
import fs from "node:fs";
import path from "node:path";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const TOTAL = 6993.71;
const TARGET_CHUNK = 360;
const HZ = 4;

// ---------- silences ----------
const log = fs.readFileSync(path.join(SCRATCH, "silencedetect.log"), "utf8");
const sStarts = [...log.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map(m => +m[1]);
const sEnds = [...log.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map(m => +m[1]);
const silences = sStarts.map((s, i) => ({ start: s, end: sEnds[i] ?? TOTAL }));

// ---------- cuts (port of computeSilenceAnchoredCuts) ----------
function anchoredCuts(silences, totalDurationSec, targetChunkSec) {
  const sorted = silences.filter(s => s.end > s.start).sort((a, b) => a.start - b.start);
  const WINDOW = targetChunkSec * 0.4;
  const MIN_CHUNK = 60;
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
function fixedCuts(totalDurationSec, chunkSec) {
  const b = [];
  for (let t = 0; t < totalDurationSec - 1; t += chunkSec) b.push(t);
  return b;
}

// ---------- vtt ----------
function parseTs(ts) {
  const p = ts.trim().split(":");
  let h = 0, m = 0, s = "0";
  if (p.length === 3) [h, m, s] = [+p[0], +p[1], p[2]];
  else if (p.length === 2) [m, s] = [+p[0], p[1]];
  else return null;
  const sec = parseFloat(s);
  return Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(sec) ? null : h * 3600 + m * 60 + sec;
}
function fmtTs(t) {
  if (t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}
function parseVtt(text) {
  const lines = text.split(/\r?\n/);
  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const arrow = lines[i].indexOf("-->");
    if (arrow < 0) continue;
    const start = parseTs(lines[i].slice(0, arrow));
    const afterArrow = lines[i].slice(arrow + 3).trim();
    const endToken = afterArrow.split(/\s+/)[0];
    const rest = afterArrow.slice(endToken.length);
    const end = parseTs(endToken);
    if (start == null || end == null) continue;
    cues.push({ lineIdx: i, start, end, rest });
  }
  return { lines, cues };
}

// ---------- per-chunk pause-reinsertion map ----------
// Returns a function mapping chunk-relative gemini time -> chunk-relative audio time.
function buildChunkMap(chunkDur, chunkSilences, geminiSpan) {
  const MIN_PAUSE = 0.7;
  const sils = chunkSilences
    .map(s => ({ start: Math.max(0, s.start), end: Math.min(chunkDur, s.end) }))
    .filter(s => s.end - s.start >= MIN_PAUSE)
    .sort((a, b) => a.start - b.start);
  const dSil = sils.reduce((t, s) => t + (s.end - s.start), 0);
  const G = geminiSpan;
  const M = chunkDur - G;

  if (G <= 5 || Math.abs(M) < 2) return (g) => g; // aligned enough / no data

  if (M < 0 || dSil < 0.5) {
    // Gemini overshot, or no pauses to reinsert into: plain linear rescale.
    const k = chunkDur / G;
    return (g) => g * k;
  }

  const rho = Math.max(0, (dSil - M) / dSil); // fraction of pause time Gemini kept
  // Build piecewise-linear map from gemini-axis to audio-axis.
  // Walk audio segments: speech slope 1, pause: gemini advances rho*d, audio d.
  const gPts = [0], aPts = [0];
  let a = 0, g = 0;
  for (const s of sils) {
    const speech = s.start - a; // speech before this pause
    a = s.start; g += speech;
    gPts.push(g); aPts.push(a);
    const d = s.end - s.start;
    a = s.end; g += rho * d;
    gPts.push(g); aPts.push(a);
  }
  // trailing speech to chunk end
  gPts.push(g + (chunkDur - a)); aPts.push(chunkDur);
  // Normalize so geminiSpan maps exactly to chunkDur (handles M > dSil residue).
  const gEnd = gPts[gPts.length - 1];
  const norm = gEnd > 1 ? G / gEnd : 1; // rescale gemini axis so that G hits the end
  const map = (x) => {
    const gx = x / norm;
    if (gx <= 0) return 0;
    if (gx >= gEnd) return chunkDur + (gx - gEnd); // overhang passes through
    let lo = 0, hi = gPts.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (gPts[mid] <= gx) lo = mid; else hi = mid; }
    const f = (gx - gPts[lo]) / Math.max(1e-9, gPts[hi] - gPts[lo]);
    return aPts[lo] + f * (aPts[hi] - aPts[lo]);
  };
  return map;
}

// ---------- metrics ----------
function cueInSilence(cues) {
  const n = Math.ceil(TOTAL * HZ);
  const sil = new Uint8Array(n);
  for (const { start, end } of silences) {
    const a = Math.max(0, Math.floor(start * HZ)), b = Math.min(n, Math.ceil(end * HZ));
    for (let i = a; i < b; i++) sil[i] = 1;
  }
  const act = new Uint8Array(n);
  for (const c of cues) {
    const a = Math.max(0, Math.floor(c.start * HZ)), b = Math.min(n, Math.ceil(Math.min(c.end, c.start + 30) * HZ));
    for (let i = a; i < b; i++) act[i] = 1;
  }
  let active = 0, inSil = 0;
  for (let i = 0; i < n; i++) if (act[i]) { active++; if (sil[i]) inSil++; }
  return inSil / active * 100;
}
// windowed envelope corr (v1 style) — meaningful AFTER retiming creates gaps
function envelopeProfile(cues, label) {
  const n = Math.ceil(TOTAL * HZ);
  const A = new Float32Array(n).fill(1);
  for (const { start, end } of silences) {
    const a = Math.max(0, Math.floor(start * HZ)), b = Math.min(n, Math.ceil(end * HZ));
    for (let i = a; i < b; i++) A[i] = 0;
  }
  const T = new Float32Array(n);
  for (const c of cues) {
    const a = Math.max(0, Math.floor(c.start * HZ)), b = Math.min(n, Math.ceil(Math.min(c.end, c.start + 30) * HZ));
    for (let i = a; i < b; i++) T[i] = 1;
  }
  const corrAt = (a, b, L) => {
    let sT = 0, sA = 0, sTT = 0, sAA = 0, sTA = 0, m = 0;
    for (let i = a; i < b; i++) {
      const j = i + L;
      if (j < 0 || j >= n) continue;
      sT += T[i]; sA += A[j]; sTT += T[i] * T[i]; sAA += A[j] * A[j]; sTA += T[i] * A[j]; m++;
    }
    if (m < 8) return 0;
    const cov = sTA - sT * sA / m, vT = sTT - sT * sT / m, vA = sAA - sA * sA / m;
    return vT <= 1e-9 || vA <= 1e-9 ? 0 : cov / Math.sqrt(vT * vA);
  };
  const W = 180, HOP = 90;
  const prof = [];
  for (let c = W / 2; c + W / 2 <= TOTAL; c += HOP) {
    const a = Math.round((c - W / 2) * HZ), b = Math.round((c + W / 2) * HZ);
    let best = { lag: 0, r: -2 };
    for (let L = -30 * HZ; L <= 45 * HZ; L++) {
      const r = corrAt(a, b, L);
      if (r > best.r) best = { lag: L / HZ, r };
    }
    if (best.r >= 0.3) prof.push(best);
  }
  const lags = prof.map(p => Math.abs(p.lag)).sort((x, y) => x - y);
  if (!lags.length) { console.log(`[${label}] env-profile: no confident windows`); return; }
  const med = lags[Math.floor(lags.length / 2)];
  const mean = lags.reduce((s, l) => s + l, 0) / lags.length;
  const p90 = lags[Math.floor(lags.length * 0.9)];
  const meanR = prof.reduce((s, p) => s + p.r, 0) / prof.length;
  console.log(`[${label}] env-profile: windows=${prof.length} median|lag|=${med.toFixed(2)}s mean|lag|=${mean.toFixed(2)}s P90|lag|=${p90.toFixed(2)}s meanR=${meanR.toFixed(2)}`);
}

// ---------- main ----------
const [vttPath, cutMode, outPath] = process.argv.slice(2);
const { lines, cues } = parseVtt(fs.readFileSync(vttPath, "utf8"));
const boundaries = cutMode === "fixed" ? fixedCuts(TOTAL, TARGET_CHUNK) : anchoredCuts(silences, TOTAL, TARGET_CHUNK);
console.log(`cues=${cues.length} | cuts(${cutMode})=${boundaries.length}: ${boundaries.slice(0, 8).map(b => b.toFixed(0)).join(",")}...`);

console.log(`cue-in-silence BEFORE=${cueInSilence(cues).toFixed(1)}%`);
envelopeProfile(cues, "BEFORE");

// per-chunk retime
const warped = cues.map(c => ({ ...c }));
let shifts = [];
for (let k = 0; k < boundaries.length; k++) {
  const c0 = boundaries[k];
  const c1 = k + 1 < boundaries.length ? boundaries[k + 1] : TOTAL;
  const dur = c1 - c0;
  const inChunk = warped.filter(c => c.start >= c0 - 0.01 && c.start < c1 - 0.01);
  if (!inChunk.length) continue;
  const geminiSpan = Math.max(...inChunk.map(c => Math.min(c.end, c.start + 30))) - c0;
  const chunkSil = silences
    .filter(s => s.end > c0 && s.start < c1)
    .map(s => ({ start: s.start - c0, end: s.end - c0 }));
  const map = buildChunkMap(dur, chunkSil, geminiSpan);
  for (const c of inChunk) {
    const ns = c0 + map(c.start - c0);
    const ne = c0 + map(Math.min(c.end, c.start + 30) - c0);
    shifts.push(ns - c.start);
    c.start = ns; c.end = ne;
  }
}
const shSorted = shifts.map(Math.abs).sort((a, b) => a - b);
console.log(`shift stats: median=${shSorted[Math.floor(shSorted.length / 2)].toFixed(1)}s max=${shSorted[shSorted.length - 1].toFixed(1)}s`);

// monotone + bounds
let prev = 0;
for (const c of warped) {
  if (c.start < prev) c.start = prev;
  if (c.end < c.start + 0.2) c.end = c.start + 0.2;
  if (c.end > TOTAL) c.end = TOTAL;
  if (c.start > TOTAL - 0.2) c.start = Math.max(0, TOTAL - 0.2);
  prev = c.start;
}

console.log(`cue-in-silence AFTER=${cueInSilence(warped).toFixed(1)}%`);
envelopeProfile(warped, "AFTER");

if (outPath) {
  const out = [...lines];
  warped.forEach((c, i) => { out[cues[i].lineIdx] = `${fmtTs(c.start)} --> ${fmtTs(c.end)}${cues[i].rest}`; });
  fs.writeFileSync(outPath, out.join("\n"));
  console.log(`wrote ${outPath}`);
}
