// v2: onset-impulse-train alignment (speech onsets after silences <-> cue starts).
// measure: node warp2.mjs measure <vtt>
// fix:     node warp2.mjs fix <vtt> <out.vtt> [W] [HOP] [SIGMA]
import fs from "node:fs";
import path from "node:path";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const HZ = 4;
const TOTAL = 6993.71;

function loadSilences() {
  const log = fs.readFileSync(path.join(SCRATCH, "silencedetect.log"), "utf8");
  const starts = [...log.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map(m => +m[1]);
  const ends = [...log.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map(m => +m[1]);
  return starts.map((s, i) => ({ start: s, end: ends[i] ?? TOTAL }));
}
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

// ---- impulse trains, gaussian-smoothed ----
function addImpulse(arr, tSec, weight, sigmaSamples) {
  const c = tSec * HZ;
  const lo = Math.max(0, Math.floor(c - 3 * sigmaSamples));
  const hi = Math.min(arr.length - 1, Math.ceil(c + 3 * sigmaSamples));
  for (let i = lo; i <= hi; i++) {
    const d = (i - c) / sigmaSamples;
    arr[i] += weight * Math.exp(-0.5 * d * d);
  }
}
function audioOnsetTrain(silences, sigmaS) {
  const n = Math.ceil(TOTAL * HZ);
  const arr = new Float32Array(n);
  let count = 0;
  for (const s of silences) {
    const dur = s.end - s.start;
    if (dur < 0.5 || s.end >= TOTAL) continue;
    addImpulse(arr, s.end, Math.sqrt(Math.min(dur, 10)), sigmaS * HZ);
    count++;
  }
  return { arr, count };
}
function transcriptOnsetTrain(cues, sigmaS) {
  const n = Math.ceil(TOTAL * HZ);
  const arr = new Float32Array(n);
  let count = 0;
  let prevEnd = 0;
  for (const c of cues) {
    const gap = Math.max(0, c.start - prevEnd);
    const w = 0.2 + Math.sqrt(Math.min(gap, 10)); // every start counts a bit; pause-preceded starts count more
    addImpulse(arr, c.start, w, sigmaS * HZ);
    prevEnd = Math.max(prevEnd, Math.min(c.end, c.start + 30));
    count++;
  }
  return { arr, count };
}
function corrAt(T, A, a, b, lagSamples) {
  let sT = 0, sA = 0, sTT = 0, sAA = 0, sTA = 0, n = 0;
  for (let i = a; i < b; i++) {
    const j = i + lagSamples;
    if (j < 0 || j >= A.length) continue;
    const t = T[i], v = A[j];
    sT += t; sA += v; sTT += t * t; sAA += v * v; sTA += t * v; n++;
  }
  if (n < 8) return 0;
  const covTA = sTA - (sT * sA) / n;
  const varT = sTT - (sT * sT) / n;
  const varA = sAA - (sA * sA) / n;
  if (varT <= 1e-9 || varA <= 1e-9) return 0;
  return covTA / Math.sqrt(varT * varA);
}
function bestLag(T, A, a, b, lagMinS, lagMaxS) {
  let best = { lag: 0, r: -2 };
  for (let L = Math.round(lagMinS * HZ); L <= Math.round(lagMaxS * HZ); L++) {
    const r = corrAt(T, A, a, b, L);
    if (r > best.r) best = { lag: L / HZ, r };
  }
  return best;
}

function profile(cues, silences, { W, HOP, SIGMA, lagMin, lagMax, rMin }) {
  const { arr: A, count: na } = audioOnsetTrain(silences, SIGMA);
  const { arr: T, count: nt } = transcriptOnsetTrain(cues, SIGMA);
  const raw = [];
  let rejected = 0;
  for (let c = W / 2; c + W / 2 <= TOTAL; c += HOP) {
    const a = Math.round((c - W / 2) * HZ), b = Math.round((c + W / 2) * HZ);
    const w = bestLag(T, A, a, b, lagMin, lagMax);
    if (w.r < rMin) { rejected++; continue; }
    raw.push({ c, lag: w.lag, r: w.r });
  }
  return { raw, rejected, na, nt };
}

function summarize(raw, label) {
  const lags = raw.map(p => p.lag).sort((a, b) => a - b);
  if (!lags.length) { console.log(`[${label}] NO ACCEPTED WINDOWS`); return; }
  const med = lags[Math.floor(lags.length / 2)];
  const absL = raw.map(p => Math.abs(p.lag)).sort((a, b) => a - b);
  const meanAbs = absL.reduce((s, l) => s + l, 0) / absL.length;
  const p90 = absL[Math.floor(absL.length * 0.9)];
  const meanR = raw.reduce((s, p) => s + p.r, 0) / raw.length;
  console.log(`[${label}] windows=${raw.length} median lag=${med.toFixed(2)}s mean|lag|=${meanAbs.toFixed(2)}s P90|lag|=${p90.toFixed(2)}s meanR=${meanR.toFixed(2)}`);
}

// cue-in-silence % — independent secondary metric
function cueInSilence(cues, silences) {
  const n = Math.ceil(TOTAL * HZ);
  const sil = new Uint8Array(n);
  for (const { start, end } of silences) {
    const a = Math.max(0, Math.floor(start * HZ)), b = Math.min(n, Math.ceil(end * HZ));
    for (let i = a; i < b; i++) sil[i] = 1;
  }
  let active = 0, inSil = 0;
  const act = new Uint8Array(n);
  for (const c of cues) {
    const a = Math.max(0, Math.floor(c.start * HZ)), b = Math.min(n, Math.ceil(Math.min(c.end, c.start + 30) * HZ));
    for (let i = a; i < b; i++) act[i] = 1;
  }
  for (let i = 0; i < n; i++) { if (act[i]) { active++; if (sil[i]) inSil++; } }
  return (inSil / active * 100);
}

const [cmd, vttPath, outPath, wArg, hArg, sArg] = process.argv.slice(2);
const silences = loadSilences();
const { lines, cues } = parseVtt(fs.readFileSync(vttPath, "utf8"));
const W = wArg ? +wArg : 240, HOP = hArg ? +hArg : 60, SIGMA = sArg ? +sArg : 2;
const opts = { W, HOP, SIGMA, lagMin: -20, lagMax: 60, rMin: 0.2 };
console.log(`cues=${cues.length} | opts W=${W} HOP=${HOP} SIGMA=${SIGMA}`);

if (cmd === "measure") {
  const { raw, rejected, na, nt } = profile(cues, silences, opts);
  console.log(`onsets: audio=${na} transcript=${nt} | rejected windows=${rejected}`);
  summarize(raw, path.basename(vttPath));
  console.log(`cue-in-silence=${cueInSilence(cues, silences).toFixed(1)}%`);
  console.log("profile:", raw.map(p => `${(p.c / 60).toFixed(0)}m:${p.lag.toFixed(1)}(r${p.r.toFixed(2)})`).join(" "));
} else if (cmd === "fix") {
  const before = profile(cues, silences, opts);
  summarize(before.raw, "BEFORE");
  console.log(`cue-in-silence BEFORE=${cueInSilence(cues, silences).toFixed(1)}%`);
  if (before.raw.length < 5) { console.log("not enough signal"); process.exit(1); }
  // median-3 smoothing
  const sm = before.raw.map((p, i, arr) => {
    const trio = [arr[Math.max(0, i - 1)].lag, p.lag, arr[Math.min(arr.length - 1, i + 1)].lag].sort((x, y) => x - y);
    return { c: p.c, lag: trio[1] };
  });
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
  const warped = cues.map(c => ({ ...c, start: c.start + lagAt(c.start), end: c.end + lagAt(c.end) }));
  let prev = 0;
  for (const c of warped) {
    if (c.start < prev) c.start = prev;
    if (c.end < c.start + 0.2) c.end = c.start + 0.2;
    if (c.end > TOTAL) c.end = TOTAL;
    if (c.start > TOTAL - 0.2) c.start = Math.max(0, TOTAL - 0.2);
    prev = c.start;
  }
  const after = profile(warped, silences, opts);
  summarize(after.raw, "AFTER");
  console.log(`cue-in-silence AFTER=${cueInSilence(warped, silences).toFixed(1)}%`);
  if (outPath) {
    const out = [...lines];
    warped.forEach((c, i) => { out[cues[i].lineIdx] = `${fmtTs(c.start)} --> ${fmtTs(c.end)}${cues[i].rest}`; });
    fs.writeFileSync(outPath, out.join("\n"));
    console.log(`wrote ${outPath}`);
  }
}
