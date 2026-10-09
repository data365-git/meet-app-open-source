// Silence-envelope time-warp prototype.
// measure: node warp.mjs measure <vtt>
// fix:     node warp.mjs fix <vtt> <out.vtt> [windowSec] [hopSec]
import fs from "node:fs";
import path from "node:path";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const HZ = 4; // samples per second
const TOTAL = 6993.71; // bbzt duration

// ---------- silence map ----------
function loadSilences() {
  const log = fs.readFileSync(path.join(SCRATCH, "silencedetect.log"), "utf8");
  const starts = [...log.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map(m => +m[1]);
  const ends = [...log.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map(m => +m[1]);
  return starts.map((s, i) => ({ start: s, end: ends[i] ?? TOTAL }));
}

// ---------- vtt ----------
function parseTs(ts) {
  const p = ts.trim().split(":");
  let h = 0, m = 0, s = "0";
  if (p.length === 3) [h, m, s] = [+p[0], +p[1], p[2]];
  else if (p.length === 2) [m, s] = [+p[0], p[1]];
  else return null;
  const sec = parseFloat(s);
  if (Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(sec)) return null;
  return h * 3600 + m * 60 + sec;
}
function fmtTs(t) {
  if (t < 0) t = 0;
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${s.toFixed(3).padStart(6, "0")}`;
}
function parseVtt(text) {
  // returns {lines, cues:[{lineIdx,start,end,rest}]}
  const lines = text.split(/\r?\n/);
  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const arrow = line.indexOf("-->");
    if (arrow < 0) continue;
    const start = parseTs(line.slice(0, arrow));
    const afterArrow = line.slice(arrow + 3).trim();
    const endToken = afterArrow.split(/\s+/)[0];
    const rest = afterArrow.slice(endToken.length);
    const end = parseTs(endToken);
    if (start == null || end == null) continue;
    cues.push({ lineIdx: i, start, end, rest });
  }
  return { lines, cues };
}

// ---------- envelopes ----------
function audioSpeechEnvelope(silences) {
  const n = Math.ceil(TOTAL * HZ);
  const env = new Float32Array(n).fill(1);
  for (const { start, end } of silences) {
    const a = Math.max(0, Math.floor(start * HZ));
    const b = Math.min(n, Math.ceil(end * HZ));
    for (let i = a; i < b; i++) env[i] = 0;
  }
  return env;
}
function transcriptEnvelope(cues) {
  const n = Math.ceil(TOTAL * HZ);
  const env = new Float32Array(n).fill(0);
  for (const c of cues) {
    const end = Math.min(c.end, c.start + 30); // don't trust runaway ends
    const a = Math.max(0, Math.floor(c.start * HZ));
    const b = Math.min(n, Math.ceil(end * HZ));
    for (let i = a; i < b; i++) env[i] = 1;
  }
  return env;
}

// Pearson correlation of T[a..b) against A shifted by lag samples.
function corrAt(T, A, a, b, lagSamples) {
  let sT = 0, sA = 0, sTT = 0, sAA = 0, sTA = 0, n = 0;
  for (let i = a; i < b; i++) {
    const j = i + lagSamples;
    if (j < 0 || j >= A.length) continue;
    const t = T[i], v = A[j];
    sT += t; sA += v; sTT += t * t; sAA += v * v; sTA += t * v; n++;
  }
  if (n < 8) return { r: 0, n };
  const covTA = sTA - (sT * sA) / n;
  const varT = sTT - (sT * sT) / n;
  const varA = sAA - (sA * sA) / n;
  if (varT <= 1e-9 || varA <= 1e-9) return { r: 0, n };
  return { r: covTA / Math.sqrt(varT * varA), n };
}

function bestLag(T, A, a, b, lagMinS, lagMaxS) {
  let best = { lag: 0, r: -2 };
  for (let L = Math.round(lagMinS * HZ); L <= Math.round(lagMaxS * HZ); L++) {
    const { r } = corrAt(T, A, a, b, L);
    if (r > best.r) best = { lag: L / HZ, r };
  }
  return best;
}

// ---------- measurement ----------
function measure(cues, silences, label) {
  const A = audioSpeechEnvelope(silences);
  const T = transcriptEnvelope(cues);
  const g = bestLag(T, A, 0, T.length, -60, 90);
  // window profile
  const W = 180, HOP = 90;
  const prof = [];
  for (let c = W / 2; c + W / 2 <= TOTAL; c += HOP) {
    const a = Math.round((c - W / 2) * HZ), b = Math.round((c + W / 2) * HZ);
    // audio window must contain BOTH speech and silence
    let sil = 0;
    for (let i = a; i < b; i++) sil += 1 - A[i];
    const silFrac = sil / (b - a);
    if (silFrac < 0.02 || silFrac > 0.98) continue;
    const w = bestLag(T, A, a, b, -30, 60);
    if (w.r < 0.25) continue;
    prof.push({ c, lag: w.lag, r: +w.r.toFixed(2) });
  }
  const lags = prof.map(p => p.lag);
  const meanAbs = lags.length ? lags.reduce((s, l) => s + Math.abs(l), 0) / lags.length : NaN;
  console.log(`[${label}] GLOBAL lag=${g.lag.toFixed(2)}s (corr ${g.r.toFixed(3)}) | windows=${prof.length} mean|lag|=${meanAbs.toFixed(2)}s`);
  return { global: g, prof, meanAbs };
}

// ---------- warp ----------
function buildWarp(cues, silences, windowSec, hopSec) {
  const A = audioSpeechEnvelope(silences);
  const T = transcriptEnvelope(cues);
  const raw = [];
  for (let c = windowSec / 2; c + windowSec / 2 <= TOTAL; c += hopSec) {
    const a = Math.round((c - windowSec / 2) * HZ), b = Math.round((c + windowSec / 2) * HZ);
    let sil = 0;
    for (let i = a; i < b; i++) sil += 1 - A[i];
    const silFrac = sil / (b - a);
    if (silFrac < 0.02 || silFrac > 0.98) continue;
    const w = bestLag(T, A, a, b, -15, 60);
    if (w.r < 0.3) continue;
    raw.push({ c, lag: w.lag, r: w.r });
  }
  if (raw.length < 3) return null;
  // median-of-3 smoothing to kill outliers
  const sm = raw.map((p, i) => {
    const trio = [raw[Math.max(0, i - 1)].lag, p.lag, raw[Math.min(raw.length - 1, i + 1)].lag].sort((x, y) => x - y);
    return { c: p.c, lag: trio[1] };
  });
  // piecewise-linear lag(t), flat extrapolation
  const lagAt = (t) => {
    if (t <= sm[0].c) return sm[0].lag;
    if (t >= sm[sm.length - 1].c) return sm[sm.length - 1].lag;
    for (let i = 0; i < sm.length - 1; i++) {
      if (t >= sm[i].c && t <= sm[i + 1].c) {
        const f = (t - sm[i].c) / (sm[i + 1].c - sm[i].c);
        return sm[i].lag + f * (sm[i + 1].lag - sm[i].lag);
      }
    }
    return 0;
  };
  return { lagAt, points: sm };
}

function applyWarp(cues, lagAt) {
  const warped = cues.map(c => ({ ...c, start: c.start + lagAt(c.start), end: c.end + lagAt(c.end) }));
  // enforce monotonic starts + valid durations + bounds
  let prev = 0;
  for (const c of warped) {
    if (c.start < prev) c.start = prev;
    if (c.end < c.start + 0.2) c.end = c.start + 0.2;
    if (c.end > TOTAL) c.end = TOTAL;
    if (c.start > TOTAL - 0.2) c.start = TOTAL - 0.2;
    prev = c.start;
  }
  return warped;
}

// ---------- main ----------
const [cmd, vttPath, outPath, wSec, hSec] = process.argv.slice(2);
const silences = loadSilences();
const text = fs.readFileSync(vttPath, "utf8");
const { lines, cues } = parseVtt(text);
console.log(`cues=${cues.length}, silences=${silences.length}, silenceFrac=${(silences.reduce((s, x) => s + (x.end - x.start), 0) / TOTAL * 100).toFixed(1)}%`);

if (cmd === "measure") {
  measure(cues, silences, path.basename(vttPath));
} else if (cmd === "fix") {
  measure(cues, silences, "BEFORE");
  const W = wSec ? +wSec : 150, H = hSec ? +hSec : 45;
  const warp = buildWarp(cues, silences, W, H);
  if (!warp) { console.log("warp: not enough signal"); process.exit(1); }
  const lagsTxt = warp.points.map(p => `${(p.c / 60).toFixed(0)}m:${p.lag.toFixed(1)}`).join(" ");
  console.log(`warp points (min:lagS): ${lagsTxt}`);
  const warped = applyWarp(cues, warp.lagAt);
  measure(warped, silences, "AFTER");
  // write output vtt
  const out = [...lines];
  warped.forEach((c, i) => {
    out[cues[i].lineIdx] = `${fmtTs(c.start)} --> ${fmtTs(c.end)}${cues[i].rest}`;
  });
  fs.writeFileSync(outPath, out.join("\n"));
  console.log(`wrote ${outPath}`);
}
