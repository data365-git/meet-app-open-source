// Transcribe bbzt chunks via Groq whisper-large-v3-turbo with WORD timestamps.
// Collects absolute-time words -> whisper-words.json
import fs from "node:fs";
import path from "node:path";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const KEY = process.env.GROQ_API_KEY;
if (!KEY) throw new Error("set GROQ_API_KEY");
const CHUNK_SEC = 600;
const dir = path.join(SCRATCH, "groq-chunks");
const files = fs.readdirSync(dir).filter(f => /^gc-\d+\.mp3$/.test(f)).sort();

async function transcribeChunk(filePath, attempt = 0) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/mpeg" }), path.basename(filePath));
  fd.append("model", "whisper-large-v3-turbo");
  fd.append("response_format", "verbose_json");
  fd.append("timestamp_granularities[]", "word");
  fd.append("language", "uz");
  fd.append("temperature", "0");
  const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}` },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      const wait = 10000 * (attempt + 1);
      console.log(`  ${res.status}, retry in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      return transcribeChunk(filePath, attempt + 1);
    }
    throw new Error(`Groq ${res.status}: ${body.slice(0, 300)}`);
  }
  return res.json();
}

const allWords = [];
let totalDur = 0;
for (let i = 0; i < files.length; i++) {
  const offset = i * CHUNK_SEC;
  const t0 = Date.now();
  const json = await transcribeChunk(path.join(dir, files[i]));
  const words = json.words ?? [];
  for (const w of words) {
    allWords.push({ word: w.word, start: +(w.start + offset).toFixed(3), end: +(w.end + offset).toFixed(3) });
  }
  const dur = json.duration ?? 0;
  totalDur = offset + dur;
  console.log(`chunk ${i} (${files[i]}): ${words.length} words, dur=${dur.toFixed(0)}s, ${(json.text || "").length} chars [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
}
fs.writeFileSync(path.join(SCRATCH, "whisper-words.json"), JSON.stringify(allWords));
console.log(`\nTOTAL: ${allWords.length} words, coverage to ${totalDur.toFixed(0)}s`);
console.log(`sample:`, allWords.slice(100, 108).map(w => `${w.word}@${w.start}`).join(" "));
