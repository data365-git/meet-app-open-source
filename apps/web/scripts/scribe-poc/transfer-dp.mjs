// v2 transfer: FULL word-level alignment (anchor-banded LCS DP) between Gemini
// text words and Scribe timed words -> dense per-word time map -> per-cue start.
// Uses the SAME eleven-words.json (no new API cost).
import fs from "node:fs";
import path from "node:path";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const TOTAL = 6993.71;

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
function parseVtt(file) {
  const lines = fs.readFileSync(path.join(SCRATCH, file), "utf8").split(/\r?\n/);
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
    let text = "";
    for (let j = i + 1; j < lines.length && lines[j].trim() !== "" && !lines[j].includes("-->"); j++) text += lines[j] + " ";
    cues.push({ lineIdx: i, start, end, rest, text: text.replace(/<[^>]+>/g, " ").replace(/^[^:]{1,25}:\s*/, "").trim() });
  }
  return { lines, cues };
}
const norm = (s) => s.toLowerCase().replace(/[ʼ'`’‘]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, " ").replace(/\s+/g, " ").trim();
const stem = (w) => (w.length >= 3 ? w.slice(0, 5) : null);

const { lines, cues } = parseVtt("vtt-live.vtt");
const G = []; // gemini word stream: {cueIdx, wordIdxInCue, stem}
cues.forEach((c, ci) => {
  let wi = 0;
  for (const w of norm(c.text).split(" ")) {
    const st = stem(w);
    if (st) G.push({ cueIdx: ci, wordIdxInCue: wi, stem: st });
    wi++;
  }
});
const scribe = JSON.parse(fs.readFileSync(path.join(SCRATCH, "eleven-words.json"), "utf8"));
const W = scribe.map(w => ({ time: w.start, stem: stem(norm(w.word)) })).filter(w => w.stem);
console.log(`G=${G.length} W=${W.length}`);

// ---- skeleton anchors: unique tri+bigrams (as v1) ----
function grams(arr, n) {
  const m = new Map();
  for (let i = 0; i + n - 1 < arr.length; i++) {
    const key = arr.slice(i, i + n).map(x => x.stem).join("|");
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(i);
  }
  return m;
}
const anchorMap = new Map(); // gIdx -> wIdx
for (const n of [3, 2]) {
  const gG = grams(G, n), wG = grams(W, n);
  for (const [key, gPos] of gG) {
    const wPos = wG.get(key);
    if (gPos.length === 1 && wPos && wPos.length === 1 && !anchorMap.has(gPos[0])) anchorMap.set(gPos[0], wPos[0]);
  }
}
let skel = [...anchorMap.entries()].map(([g, w]) => ({ g, w })).sort((a, b) => a.g - b.g);
// monotonic (LIS on w)
{
  const tails = [], prev = new Array(skel.length).fill(-1);
  for (let i = 0; i < skel.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (skel[tails[mid]].w < skel[i].w) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i); else tails[lo] = i;
  }
  const res = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) { res.push(skel[k]); k = prev[k]; }
  skel = res.reverse();
}
console.log(`skeleton anchors=${skel.length}`);

// ---- segment-wise LCS DP between consecutive anchors -> dense matches ----
const matches = []; // {gIdx, time}
function lcsAlign(g0, g1, w0, w1) {
  const n = g1 - g0, m = w1 - w0;
  if (n <= 0 || m <= 0 || n * m > 250000) return; // skip huge/empty segments
  // DP LCS
  const dp = new Uint16Array((n + 1) * (m + 1));
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      dp[i * (m + 1) + j] = G[g0 + i - 1].stem === W[w0 + j - 1].stem
        ? dp[(i - 1) * (m + 1) + j - 1] + 1
        : Math.max(dp[(i - 1) * (m + 1) + j], dp[i * (m + 1) + j - 1]);
    }
  }
  // backtrack
  let i = n, j = m;
  const seg = [];
  while (i > 0 && j > 0) {
    if (G[g0 + i - 1].stem === W[w0 + j - 1].stem && dp[i * (m + 1) + j] === dp[(i - 1) * (m + 1) + j - 1] + 1) {
      seg.push({ gIdx: g0 + i - 1, time: W[w0 + j - 1].time });
      i--; j--;
    } else if (dp[(i - 1) * (m + 1) + j] >= dp[i * (m + 1) + j - 1]) i--;
    else j--;
  }
  for (let k = seg.length - 1; k >= 0; k--) matches.push(seg[k]);
}
let prevA = { g: 0, w: 0 };
for (const a of skel) {
  lcsAlign(prevA.g, a.g, prevA.w, a.w);
  matches.push({ gIdx: a.g, time: W[a.w].time });
  prevA = { g: a.g + 1, w: a.w + 1 };
}
lcsAlign(prevA.g, G.length, prevA.w, W.length);
matches.sort((a, b) => a.gIdx - b.gIdx);
console.log(`dense matches=${matches.length} (${(matches.length / G.length * 100).toFixed(0)}% of gemini words)`);

// ---- OUTLIER FILTER: reject dense matches deviating >8s from the robust
// skeleton interpolation (a lone false LCS match can land 100s+ away). ----
{
  const sg = skel.map(a => a.g), st = skel.map(a => W[a.w].time);
  const skelAt = (gi) => {
    if (!sg.length) return null;
    if (gi <= sg[0]) return st[0];
    if (gi >= sg[sg.length - 1]) return st[st.length - 1];
    let lo = 0, hi = sg.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (sg[mid] <= gi) lo = mid; else hi = mid; }
    const f = (gi - sg[lo]) / (sg[hi] - sg[lo]);
    return st[lo] + f * (st[hi] - st[lo]);
  };
  const before = matches.length;
  const kept = matches.filter(m => { const e = skelAt(m.gIdx); return e == null || Math.abs(m.time - e) <= 8; });
  matches.length = 0; matches.push(...kept);
  console.log(`outlier filter: kept ${matches.length}/${before}`);
}

// ---- per-cue start: first matched word in cue (with small word-offset correction),
//      else interpolate between neighbor matches ----
const timeByGIdx = new Map(matches.map(m => [m.gIdx, m.time]));
const gIdxsSorted = matches.map(m => m.gIdx);
function interpAt(gIdx) {
  // binary search neighbors
  let lo = 0, hi = gIdxsSorted.length - 1;
  if (gIdx <= gIdxsSorted[0]) return matches[0].time;
  if (gIdx >= gIdxsSorted[hi]) return matches[hi].time;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (gIdxsSorted[mid] <= gIdx) lo = mid; else hi = mid; }
  const f = (gIdx - gIdxsSorted[lo]) / (gIdxsSorted[hi] - gIdxsSorted[lo]);
  return matches[lo].time + f * (matches[hi].time - matches[lo].time);
}
// group G word indices by cue
const cueFirstG = new Map(), cueWords = new Map();
G.forEach((g, idx) => {
  if (!cueFirstG.has(g.cueIdx)) cueFirstG.set(g.cueIdx, idx);
  if (!cueWords.has(g.cueIdx)) cueWords.set(g.cueIdx, []);
  cueWords.get(g.cueIdx).push(idx);
});
const AVG_WORD_SEC = 0.38;
const newStart = cues.map((c, ci) => {
  const wIdxs = cueWords.get(ci);
  if (!wIdxs) return c.start;
  // first MATCHED word within the cue
  for (const gi of wIdxs) {
    const t = timeByGIdx.get(gi);
    if (t != null) {
      const wordOffset = G[gi].wordIdxInCue; // how many words into the cue
      return Math.max(0, t - wordOffset * AVG_WORD_SEC);
    }
  }
  return interpAt(wIdxs[0]);
});
// monotonic + bounds
for (let i = 0; i < cues.length; i++) {
  if (i > 0 && newStart[i] < newStart[i - 1]) newStart[i] = newStart[i - 1];
  if (newStart[i] > TOTAL - 0.2) newStart[i] = TOTAL - 0.2;
}
const warped = cues.map((c, i) => {
  const s = newStart[i];
  const e = i + 1 < cues.length ? Math.max(s + 0.3, Math.min(newStart[i + 1], s + 15)) : Math.min(TOTAL, s + 3);
  return { start: s, end: e };
});

// ---- measure vs grid truth ----
const truth = [
  { i: 241, t0: 1145, off: 15 }, { i: 362, t0: 1706, off: 15 }, { i: 617, t0: 2909, off: 5 },
  { i: 746, t0: 3448, off: 35 }, { i: 844, t0: 4058, off: 15 }, { i: 1101, t0: 5223, off: 25 },
];
console.log(`\nprobe | trueTime | v1Err(3.7s mean) | v2Err`);
let sum = 0;
for (const t of truth) {
  const trueTime = t.t0 + t.off;
  const err = Math.abs(warped[t.i].start - trueTime);
  sum += err;
  console.log(`#${t.i} | ${trueTime}s | - | ${err.toFixed(1)}s (lands ${warped[t.i].start.toFixed(1)}s)`);
}
console.log(`MEAN v2 |err| = ${(sum / truth.length).toFixed(2)}s  (v1 was 3.7s, orig 18.3s)`);

// ---- write ----
const out = [...lines];
warped.forEach((c, i) => { out[cues[i].lineIdx] = `${fmtTs(c.start)} --> ${fmtTs(c.end)}${cues[i].rest}`; });
fs.writeFileSync(path.join(SCRATCH, "fixed-eleven-v2.vtt"), out.join("\n"));
console.log("wrote fixed-eleven-v2.vtt");
