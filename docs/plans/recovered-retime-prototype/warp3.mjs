// v3: Viterbi-constrained lag path over combined (envelope + onset-train) scores.
// Drift model: slow rise within a chunk (Gemini compresses time), sharp negative reset at chunk boundaries.
// measure: node warp3.mjs measure <vtt>
// fix:     node warp3.mjs fix <vtt> <out.vtt>
import fs from "node:fs";
import path from "node:path";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const HZ = 4;
const TOTAL = 6993.71;

// ---------- inputs ----------
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

// ---------- signals ----------
function audioSpeechEnvelope(silences) {
  const n = Math.ceil(TOTAL * HZ);
  const env = new Float32Array(n).fill(1);
  for (const { start, end } of silences) {
    const a = Math.max(0, Math.floor(start * HZ)), b = Math.min(n, Math.ceil(end * HZ));
    for (let i = a; i < b; i++) env[i] = 0;
  }
  return env;
}
function transcriptEnvelope(cues) {
  const n = Math.ceil(TOTAL * HZ);
  const env = new Float32Array(n);
  for (const c of cues) {
    const a = Math.max(0, Math.floor(c.start * HZ));
    const b = Math.min(n, Math.ceil(Math.min(c.end, c.start + 30) * HZ));
    for (let i = a; i < b; i++) env[i] = 1;
  }
  return env;
}
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
  for (const s of silences) {
    const dur = s.end - s.start;
    if (dur < 0.5 || s.end >= TOTAL) continue;
    addImpulse(arr, s.end, Math.sqrt(Math.min(dur, 10)), sigmaS * HZ);
  }
  return arr;
}
function transcriptOnsetTrain(cues, sigmaS) {
  const n = Math.ceil(TOTAL * HZ);
  const arr = new Float32Array(n);
  let prevEnd = 0;
  for (const c of cues) {
    const gap = Math.max(0, c.start - prevEnd);
    addImpulse(arr, c.start, 0.2 + Math.sqrt(Math.min(gap, 10)), sigmaS * HZ);
    prevEnd = Math.max(prevEnd, Math.min(c.end, c.start + 30));
  }
  return arr;
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

// ---------- Viterbi lag path ----------
// States: lag in [LAG_MIN, LAG_MAX] step 0.25s. Emission = envCorr + onsetCorr.
// Transition per hop: |d| <= RISE free-ish; negative jump (chunk reset) cheap-ish; else forbidden.
function lagPath(cues, silences, { W = 240, HOP = 30, SIGMA = 2, LAG_MIN = -20, LAG_MAX = 60 } = {}) {
  const A1 = audioSpeechEnvelope(silences);
  const T1 = transcriptEnvelope(cues);
  const A2 = audioOnsetTrain(silences, SIGMA);
  const T2 = transcriptOnsetTrain(cues, SIGMA);

  const centers = [];
  for (let c = W / 2; c + W / 2 <= TOTAL; c += HOP) centers.push(c);
  const lagStep = 1 / HZ;
  const nLags = Math.round((LAG_MAX - LAG_MIN) / lagStep) + 1;

  // emission matrix
  const E = centers.map((c) => {
    const a = Math.round((c - W / 2) * HZ), b = Math.round((c + W / 2) * HZ);
    const row = new Float32Array(nLags);
    for (let li = 0; li < nLags; li++) {
      const L = Math.round((LAG_MIN + li * lagStep) * HZ);
      row[li] = corrAt(T1, A1, a, b, L) + corrAt(T2, A2, a, b, L);
    }
    return row;
  });

  // transitions
  const RISE = 3;      // seconds of free-ish drift change per hop (both directions)
  const RISE_COST = 0.05; // per second beyond free band
  const RESET_COST = 0.35; // flat cost for a big negative jump (chunk boundary reset)
  const riseStates = Math.round(RISE / lagStep);

  const nW = centers.length;
  const score = new Float32Array(nW * nLags).fill(-1e9);
  const back = new Int32Array(nW * nLags).fill(-1);
  for (let li = 0; li < nLags; li++) score[li] = E[0][li];
  for (let w = 1; w < nW; w++) {
    const prevBase = (w - 1) * nLags, curBase = w * nLags;
    // precompute best-prev for reset jumps (from any HIGHER lag: reset goes downward)
    // suffix max over prev scores
    const sufMax = new Float32Array(nLags);
    const sufArg = new Int32Array(nLags);
    let bm = -1e9, ba = -1;
    for (let li = nLags - 1; li >= 0; li--) {
      if (score[prevBase + li] > bm) { bm = score[prevBase + li]; ba = li; }
      sufMax[li] = bm; sufArg[li] = ba;
    }
    for (let li = 0; li < nLags; li++) {
      let best = -1e9, bestFrom = -1;
      // smooth transitions
      for (let d = -riseStates; d <= riseStates; d++) {
        const pj = li - d;
        if (pj < 0 || pj >= nLags) continue;
        const s = score[prevBase + pj] - Math.abs(d * lagStep) * RISE_COST;
        if (s > best) { best = s; bestFrom = pj; }
      }
      // reset: from any prev lag ABOVE current+RISE (downward jump)
      const fromIdx = li + riseStates + 1;
      if (fromIdx < nLags && sufMax[fromIdx] - RESET_COST > best) {
        best = sufMax[fromIdx] - RESET_COST;
        bestFrom = sufArg[fromIdx];
      }
      score[curBase + li] = best + E[w][li];
      back[curBase + li] = bestFrom;
    }
  }
  // backtrack
  let bestEnd = 0;
  for (let li = 1; li < nLags; li++) if (score[(nW - 1) * nLags + li] > score[(nW - 1) * nLags + bestEnd]) bestEnd = li;
  const pathIdx = new Array(nW);
  pathIdx[nW - 1] = bestEnd;
  for (let w = nW - 1; w > 0; w--) pathIdx[w - 1] = back[w * nLags + pathIdx[w]];
  const pathScore = pathIdx.map((li, w) => E[w][li]);
  return {
    points: centers.map((c, w) => ({ c, lag: LAG_MIN + pathIdx[w] * lagStep, e: pathScore[w] })),
  };
}

function pathStats(points, label) {
  const lags = points.map(p => p.lag);
  const absL = lags.map(Math.abs).sort((a, b) => a - b);
  const med = [...lags].sort((a, b) => a - b)[Math.floor(lags.length / 2)];
  const meanAbs = absL.reduce((s, l) => s + l, 0) / absL.length;
  const p90 = absL[Math.floor(absL.length * 0.9)];
  const meanE = points.reduce((s, p) => s + p.e, 0) / points.length;
  console.log(`[${label}] n=${points.length} median=${med.toFixed(2)}s mean|lag|=${meanAbs.toFixed(2)}s P90|lag|=${p90.toFixed(2)}s meanE=${meanE.toFixed(2)}`);
}

function cueInSilence(cues, silences) {
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

// ---------- main ----------
const [cmd, vttPath, outPath] = process.argv.slice(2);
const silences = loadSilences();
const { lines, cues } = parseVtt(fs.readFileSync(vttPath, "utf8"));
console.log(`cues=${cues.length}`);

if (cmd === "measure") {
  const { points } = lagPath(cues, silences);
  pathStats(points, path.basename(vttPath));
  console.log(`cue-in-silence=${cueInSilence(cues, silences).toFixed(1)}%`);
  console.log("path:", points.map(p => `${(p.c / 60).toFixed(0)}m:${p.lag.toFixed(1)}`).join(" "));
} else if (cmd === "fix") {
  const before = lagPath(cues, silences);
  pathStats(before.points, "BEFORE");
  console.log(`cue-in-silence BEFORE=${cueInSilence(cues, silences).toFixed(1)}%`);
  const pts = before.points;
  const lagAt = (t) => {
    if (t <= pts[0].c) return pts[0].lag;
    if (t >= pts[pts.length - 1].c) return pts[pts.length - 1].lag;
    for (let i = 0; i < pts.length - 1; i++) {
      if (t >= pts[i].c && t <= pts[i + 1].c) {
        const f = (t - pts[i].c) / (pts[i + 1].c - pts[i].c);
        return pts[i].lag + f * (pts[i + 1].lag - pts[i].lag);
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
  // verify with DIFFERENT windowing (quasi-independent) + cue-in-silence
  const after = lagPath(warped, silences, { W: 150, HOP: 50 });
  pathStats(after.points, "AFTER (alt-window)");
  console.log(`cue-in-silence AFTER=${cueInSilence(warped, silences).toFixed(1)}%`);
  if (outPath) {
    const out = [...lines];
    warped.forEach((c, i) => { out[cues[i].lineIdx] = `${fmtTs(c.start)} --> ${fmtTs(c.end)}${cues[i].rest}`; });
    fs.writeFileSync(outPath, out.join("\n"));
    console.log(`wrote ${outPath}`);
  }
}
