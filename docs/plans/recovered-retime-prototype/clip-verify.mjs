// Ground-truth ear test: extract audio clips at ORIGINAL vs RETIMED cue times,
// transcribe with Gemini, score word-F1 against the cue text.
// node clip-verify.mjs
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const rw = JSON.parse(fs.readFileSync(path.join(SCRATCH, "rw.json"), "utf8"));
const KEY = rw.GEMINI_API_KEY;
const AUDIO = path.join(SCRATCH, "bbzt-audio.mp4");
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
    cues.push({ start, end, text: text.replace(/^[^:]{1,25}:\s*/, "").trim() });
  }
  return cues;
}
const norm = (s) => s.toLowerCase().replace(/[ʼ'`’‘]/g, "'").replace(/[^\p{L}\p{N}'\s]/gu, " ").replace(/\s+/g, " ").trim();
const toWords = (s) => norm(s).split(" ").filter(Boolean);
function f1(clipText, refText) {
  const a = toWords(clipText), b = toWords(refText);
  if (!a.length || !b.length) return 0;
  const bag = new Map();
  for (const w of b) bag.set(w, (bag.get(w) ?? 0) + 1);
  let inter = 0;
  for (const w of a) { const c = bag.get(w) ?? 0; if (c > 0) { inter++; bag.set(w, c - 1); } }
  return 2 * inter / (a.length + b.length);
}

function extractClip(t, outFile) {
  const r = spawnSync("ffmpeg", ["-ss", String(Math.max(0, t)), "-t", "10", "-i", AUDIO, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "48k", "-f", "mp3", "-y", outFile], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${r.stderr?.slice(-200)}`);
}
async function gemini(clipFile, attempt = 0) {
  const b64 = fs.readFileSync(clipFile).toString("base64");
  const model = attempt === 0 ? "gemini-3-flash-preview" : "gemini-flash-latest";
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { inline_data: { mime_type: "audio/mpeg", data: b64 } },
        { text: "Transcribe this Uzbek audio snippet verbatim. Output ONLY the spoken words, no timestamps, no labels, no commentary." },
      ] }],
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await new Promise(r => setTimeout(r, 15000));
      return gemini(clipFile, attempt + 1);
    }
    if (res.status === 404 && attempt === 0) return gemini(clipFile, 1);
    throw new Error(`gemini ${res.status}: ${body.slice(0, 150)}`);
  }
  const json = await res.json();
  return (json.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join(" ").trim();
}

const orig = parseVtt("vtt-live.vtt");
const fixed = parseVtt("fixed-live.vtt");
if (orig.length !== fixed.length) throw new Error(`cue count mismatch ${orig.length} vs ${fixed.length}`);

// pick 10 probes: text>=40 chars, spread across duration, prefer bigger shifts
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

console.log("idx | origT | fixedT | shift | F1orig | F1fixed | verdict");
let fixedBetter = 0, origBetter = 0, same = 0, sumO = 0, sumF = 0;
const details = [];
for (const p of probes) {
  const ref = p.c.text + " " + (fixed[p.i + 1]?.text ?? "");
  const oClip = path.join(SCRATCH, "clip-o.mp3"), fClip = path.join(SCRATCH, "clip-f.mp3");
  extractClip(orig[p.i].start - 1, oClip);
  extractClip(p.c.start - 1, fClip);
  const oText = await gemini(oClip);
  await new Promise(r => setTimeout(r, 1000));
  const fText = await gemini(fClip);
  await new Promise(r => setTimeout(r, 1000));
  const fo = f1(oText, ref), ff = f1(fText, ref);
  sumO += fo; sumF += ff;
  const verdict = ff - fo > 0.08 ? "FIXED_BETTER" : fo - ff > 0.08 ? "ORIG_BETTER" : "SAME";
  if (verdict === "FIXED_BETTER") fixedBetter++; else if (verdict === "ORIG_BETTER") origBetter++; else same++;
  console.log(`${p.i} | ${orig[p.i].start.toFixed(0)}s | ${p.c.start.toFixed(0)}s | +${(p.c.start - orig[p.i].start).toFixed(1)}s | ${fo.toFixed(2)} | ${ff.toFixed(2)} | ${verdict}`);
  details.push({ i: p.i, ref: ref.slice(0, 80), oText: oText.slice(0, 80), fText: fText.slice(0, 80) });
}
console.log(`\nSUMMARY: FIXED_BETTER=${fixedBetter} ORIG_BETTER=${origBetter} SAME=${same} | meanF1 orig=${(sumO / probes.length).toFixed(2)} fixed=${(sumF / probes.length).toFixed(2)}`);
console.log("\n--- transcripts (80ch) ---");
for (const d of details) {
  console.log(`#${d.i} REF:   ${d.ref}\n#${d.i} ORIG:  ${d.oText}\n#${d.i} FIXED: ${d.fText}\n`);
}
