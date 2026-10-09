// Grid localization: WHERE is each probe cue's text actually spoken?
// Scans clips at offsets around the original cue time, scores fuzzy-stem F1.
// Ground truth for drift curve + verdict on the retime model.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const rw = JSON.parse(fs.readFileSync(path.join(SCRATCH, "rw.json"), "utf8"));
const KEY = rw.GEMINI_API_KEY;
const AUDIO = path.join(SCRATCH, "bbzt-audio.mp4");
const TOTAL = 6993.71;
const OFFSETS = [];
for (let o = -25; o <= 115; o += 10) OFFSETS.push(o);

function parseTs(ts) {
  const p = ts.trim().split(":");
  let h = 0, m = 0, s = "0";
  if (p.length === 3) [h, m, s] = [+p[0], +p[1], p[2]];
  else if (p.length === 2) [m, s] = [+p[0], p[1]];
  else return null;
  const sec = parseFloat(s);
  return Number.isNaN(h) || Number.isNaN(m) || Number.isNaN(sec) ? null : h * 3600 + m * 60 + sec;
}
function parseVtt(file) {
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
    cues.push({ start, end, text: text.replace(/<[^>]+>/g, " ").replace(/^[^:]{1,25}:\s*/, "").trim() });
  }
  return cues;
}
const norm = (s) => s.toLowerCase().replace(/[ʼ'`’‘]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, " ").replace(/\s+/g, " ").trim();
const stem = (w) => w.slice(0, 5); // agglutinative-tolerant prefix stem
const toStems = (s) => norm(s).split(" ").filter(w => w.length >= 3).map(stem);
function f1(a, b) {
  const A = toStems(a), B = toStems(b);
  if (!A.length || !B.length) return 0;
  const bag = new Map();
  for (const w of B) bag.set(w, (bag.get(w) ?? 0) + 1);
  let inter = 0;
  for (const w of A) { const c = bag.get(w) ?? 0; if (c > 0) { inter++; bag.set(w, c - 1); } }
  return 2 * inter / (A.length + B.length);
}
function extractClip(t, outFile) {
  const r = spawnSync("ffmpeg", ["-ss", String(Math.max(0, t)), "-t", "12", "-i", AUDIO, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", "-y", outFile], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.slice(-200)}`);
}
async function gemini(clipFile, attempt = 0) {
  const b64 = fs.readFileSync(clipFile).toString("base64");
  const model = attempt <= 1 ? "gemini-3-flash-preview" : "gemini-flash-latest";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [
      { inline_data: { mime_type: "audio/mpeg", data: b64 } },
      { text: "Transcribe this Uzbek audio snippet verbatim. Output ONLY the spoken words." },
    ] }] }),
  });
  if (!res.ok) {
    await res.text();
    if (attempt < 3) { await new Promise(r => setTimeout(r, attempt === 0 ? 4000 : 20000)); return gemini(clipFile, attempt + 1); }
    return ""; // give up on this cell, score 0
  }
  const json = await res.json();
  return (json.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join(" ").trim();
}

const orig = parseVtt("vtt-live.vtt");
const fixed = parseVtt("fixed-live.vtt");
// same probes as clip-verify (recompute identically)
const candidates = fixed.map((c, i) => ({ i, c, shift: c.start - orig[i].start }))
  .filter(x => x.c.text.length >= 40 && x.c.start > 120 && x.c.start < TOTAL - 60);
const probes = [];
for (let p = 0.08; p <= 0.92 && probes.length < 10; p += 0.084) {
  const t = p * TOTAL;
  let best = null, bestD = 1e9;
  for (const x of candidates) {
    if (probes.includes(x)) continue;
    const d = Math.abs(x.c.start - t);
    if (d < bestD) { bestD = d; best = x; }
  }
  if (best) probes.push(best);
}

const results = [];
for (const p of probes) {
  const ref = p.c.text + " " + (fixed[p.i + 1]?.text ?? "");
  const t0 = orig[p.i].start;
  const claimed = p.c.start - t0;
  const row = [];
  for (const off of OFFSETS) {
    const t = t0 + off;
    if (t < 0 || t > TOTAL - 12) { row.push({ off, f: 0 }); continue; }
    const clip = path.join(SCRATCH, "clip-grid.mp3");
    extractClip(t, clip);
    const text = await gemini(clip);
    row.push({ off, f: f1(text, ref) });
    await new Promise(r => setTimeout(r, 300));
  }
  const best = row.reduce((a, b) => (b.f > a.f ? b : a));
  const sorted = [...row].sort((a, b) => b.f - a.f);
  const conf = sorted[0].f - (sorted[1]?.f ?? 0);
  results.push({ i: p.i, t0, claimed, best, conf, row });
  console.log(`probe#${p.i} t0=${t0.toFixed(0)}s claimedShift=+${claimed.toFixed(1)}s | trueOffset=${best.off >= 0 ? "+" : ""}${best.off}s (F1=${best.f.toFixed(2)}, margin=${conf.toFixed(2)}) | grid: ${row.map(r => r.f.toFixed(2)).join(" ")}`);
}
console.log("\n=== SUMMARY (only probes with clear peak F1>=0.25) ===");
console.log("probe | claimedShift | trueShift | origErr | fixedErr");
let oErrs = [], fErrs = [];
for (const r of results) {
  if (r.best.f < 0.25) { console.log(`#${r.i} | +${r.claimed.toFixed(0)} | UNCLEAR (max F1 ${r.best.f.toFixed(2)})`); continue; }
  const oe = Math.abs(r.best.off), fe = Math.abs(r.best.off - r.claimed);
  oErrs.push(oe); fErrs.push(fe);
  console.log(`#${r.i} | +${r.claimed.toFixed(0)}s | ${r.best.off >= 0 ? "+" : ""}${r.best.off}s | ${oe.toFixed(0)}s | ${fe.toFixed(0)}s`);
}
if (oErrs.length) {
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  console.log(`\nmean |err|: ORIG=${mean(oErrs).toFixed(1)}s FIXED=${mean(fErrs).toFixed(1)}s (n=${oErrs.length})`);
}
