// Transfer Whisper word-timestamps onto Gemini cue text via monotonic anchor alignment.
// Then measure against grid ground-truth (6 probes).
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
const stem = (w) => w.length >= 4 ? w.slice(0, 5) : null;

// ---- build Gemini word sequence ----
const { lines, cues } = parseVtt("vtt-live.vtt");
const G = []; // {cueIdx, stem}
cues.forEach((c, ci) => {
  for (const w of norm(c.text).split(" ")) {
    const st = stem(w);
    if (st) G.push({ cueIdx: ci, stem: st });
  }
});
// ---- Whisper word sequence ----
const whisper = JSON.parse(fs.readFileSync(path.join(SCRATCH, "whisper-words.json"), "utf8"));
const W = whisper.map(w => ({ time: w.start, stem: stem(norm(w.word)) })).filter(w => w.stem);

console.log(`Gemini words(stemmed)=${G.length}, Whisper words(stemmed)=${W.length}`);

// ---- anchors via trigrams unique in BOTH ----
function trigrams(arr) {
  const m = new Map();
  for (let i = 0; i + 2 < arr.length; i++) {
    const key = arr[i].stem + "|" + arr[i + 1].stem + "|" + arr[i + 2].stem;
    if (!m.has(key)) m.set(key, []);
    m.get(key).push(i);
  }
  return m;
}
const gTri = trigrams(G), wTri = trigrams(W);
let anchors = []; // {gPos, wTime}
for (const [key, gPos] of gTri) {
  const wPos = wTri.get(key);
  if (gPos.length === 1 && wPos && wPos.length === 1) {
    anchors.push({ gPos: gPos[0], wTime: W[wPos[0]].time });
  }
}
anchors.sort((a, b) => a.gPos - b.gPos);
console.log(`raw anchors (unique trigram both)=${anchors.length}`);

// ---- enforce monotonic wTime via LIS on wTime ----
function longestIncreasing(arr) {
  // arr of {gPos,wTime}; keep longest subsequence with increasing wTime
  const tails = [], idx = [], prev = new Array(arr.length).fill(-1);
  for (let i = 0; i < arr.length; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[tails[mid]].wTime < arr[i].wTime) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    if (lo === tails.length) tails.push(i); else tails[lo] = i;
    idx[lo] = i;
  }
  const res = [];
  let k = tails.length ? tails[tails.length - 1] : -1;
  while (k >= 0) { res.push(arr[k]); k = prev[k]; }
  return res.reverse();
}
anchors = longestIncreasing(anchors);
console.log(`monotonic anchors=${anchors.length} (1 per ~${(G.length / anchors.length).toFixed(0)} words)`);

// ---- map gPos -> time (piecewise linear, flat extrapolation) ----
function timeAtGPos(gp) {
  if (!anchors.length) return null;
  if (gp <= anchors[0].gPos) return anchors[0].wTime;
  if (gp >= anchors[anchors.length - 1].gPos) return anchors[anchors.length - 1].wTime;
  let lo = 0, hi = anchors.length - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (anchors[mid].gPos <= gp) lo = mid; else hi = mid; }
  const f = (gp - anchors[lo].gPos) / Math.max(1, anchors[hi].gPos - anchors[lo].gPos);
  return anchors[lo].wTime + f * (anchors[hi].wTime - anchors[lo].wTime);
}
// first gPos per cue
const firstGPosOfCue = new Map();
G.forEach((g, i) => { if (!firstGPosOfCue.has(g.cueIdx)) firstGPosOfCue.set(g.cueIdx, i); });

const newStart = cues.map((c, ci) => {
  const gp = firstGPosOfCue.get(ci);
  const t = gp == null ? null : timeAtGPos(gp);
  return t == null ? c.start : t;
});
// monotonic + bounds; end = next start
for (let i = 0; i < cues.length; i++) {
  if (i > 0 && newStart[i] < newStart[i - 1]) newStart[i] = newStart[i - 1];
  if (newStart[i] > TOTAL - 0.2) newStart[i] = TOTAL - 0.2;
  if (newStart[i] < 0) newStart[i] = 0;
}
const warped = cues.map((c, i) => {
  const s = newStart[i];
  const e = i + 1 < cues.length ? Math.max(s + 0.3, Math.min(newStart[i + 1], s + 15)) : Math.min(TOTAL, s + 3);
  return { ...c, start: s, end: e };
});

// write vtt
const out = [...lines];
warped.forEach((c, i) => { out[cues[i].lineIdx] = `${fmtTs(c.start)} --> ${fmtTs(c.end)}${cues[i].rest}`; });
fs.writeFileSync(path.join(SCRATCH, "fixed-whisper-live.vtt"), out.join("\n"));

// ---- MEASURE against grid truth (6 probes: t0=orig start, trueOffset) ----
const truth = [
  { i: 241, t0: 1145, off: 15 }, { i: 362, t0: 1706, off: 15 }, { i: 617, t0: 2909, off: 5 },
  { i: 746, t0: 3448, off: 35 }, { i: 844, t0: 4058, off: 15 }, { i: 1101, t0: 5223, off: 25 },
];
console.log(`\nprobe | origT | trueTime | A(retime)Err | D(whisper)Err`);
const aVtt = parseVtt("fixed-live.vtt").cues;
let sumOrig = 0, sumD = 0, sumA = 0;
for (const t of truth) {
  const trueTime = t.t0 + t.off;
  const dTime = warped[t.i].start;
  const aTime = aVtt[t.i]?.start ?? cues[t.i].start;
  const dErr = Math.abs(dTime - trueTime), aErr = Math.abs(aTime - trueTime), oErr = t.off;
  sumOrig += oErr; sumD += dErr; sumA += aErr;
  console.log(`#${t.i} | ${t.t0}s | ${trueTime}s | ${aErr.toFixed(0)}s | ${dErr.toFixed(0)}s   (D lands cue at ${dTime.toFixed(0)}s)`);
}
const n = truth.length;
console.log(`\nMEAN |err|:  ORIG=${(sumOrig / n).toFixed(1)}s   A/retime=${(sumA / n).toFixed(1)}s   D/whisper=${(sumD / n).toFixed(1)}s`);
