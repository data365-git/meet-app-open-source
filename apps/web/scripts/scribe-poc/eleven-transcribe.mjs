// Transcribe bbzt chunks via ElevenLabs Scribe with WORD timestamps.
// MAX_CHUNKS env limits how many (probe first). -> whisper-words.json style output.
import fs from "node:fs";
import path from "node:path";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const KEY = process.env.ELEVEN_API_KEY;
if (!KEY) throw new Error("set ELEVEN_API_KEY");
const CHUNK_SEC = 600;
const MAX = process.env.MAX_CHUNKS ? +process.env.MAX_CHUNKS : 999;
const dir = path.join(SCRATCH, "groq-chunks");
const files = fs.readdirSync(dir).filter(f => /^gc-\d+\.mp3$/.test(f)).sort().slice(0, MAX);

async function transcribeChunk(filePath, attempt = 0) {
  const buf = fs.readFileSync(filePath);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type: "audio/mpeg" }), path.basename(filePath));
  fd.append("model_id", "scribe_v1");
  fd.append("language_code", "uzb"); // ISO-639-3 Uzbek
  fd.append("timestamps_granularity", "word");
  fd.append("diarize", "false");
  const res = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": KEY },
    body: fd,
  });
  if (!res.ok) {
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < 3) {
      await new Promise(r => setTimeout(r, 10000 * (attempt + 1)));
      return transcribeChunk(filePath, attempt + 1);
    }
    throw new Error(`Eleven ${res.status}: ${body.slice(0, 400)}`);
  }
  return res.json();
}

const allWords = [];
for (let i = 0; i < files.length; i++) {
  const offset = i * CHUNK_SEC;
  const t0 = Date.now();
  const json = await transcribeChunk(path.join(dir, files[i]));
  const words = (json.words ?? []).filter(w => w.type === "word" || w.type == null);
  for (const w of words) {
    if (typeof w.start !== "number") continue;
    allWords.push({ word: w.text, start: +(w.start + offset).toFixed(3), end: +((w.end ?? w.start) + offset).toFixed(3) });
  }
  console.log(`chunk ${i}: lang=${json.language_code}(${(json.language_probability ?? 0).toFixed(2)}) words=${words.length} [${((Date.now() - t0) / 1000).toFixed(1)}s]`);
  if (i === 0) console.log(`  SAMPLE TEXT: ${(json.text || "").slice(0, 260)}`);
}
if (MAX >= 12) {
  fs.writeFileSync(path.join(SCRATCH, "eleven-words.json"), JSON.stringify(allWords));
  console.log(`\nSAVED eleven-words.json: ${allWords.length} words`);
} else {
  console.log(`\n(probe only, ${allWords.length} words — not saved)`);
}
