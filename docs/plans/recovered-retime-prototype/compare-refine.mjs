// Option E quality test: refine Scribe raw text vs Gemini raw text (same window),
// using the app's ACTUAL refine prompt + model. Judge fact/number preservation.
import fs from "node:fs";
import path from "node:path";
const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const rw = JSON.parse(fs.readFileSync(path.join(SCRATCH, "rw.json"), "utf8"));
const KEY = rw.GEMINI_API_KEY_FREE || rw.GEMINI_API_KEY;
const MODEL = "gemini-2.5-flash"; // free-key accessible; SAME model both sides = fair A/B

const MIXED = `Mixed-language script-preservation rules (HARD requirements — violating any of these makes the whole output WRONG):
- Every word keeps its ORIGINAL script exactly as spoken/written. Russian words stay in Cyrillic: любой stays любой — writing "lyuboy" is an ERROR. English words stay in Latin: deadline stays deadline — writing "dedlayn" is an ERROR.
- NEVER transliterate between scripts in either direction: Cyrillic → Latin is forbidden, Latin → Cyrillic is forbidden.
- NEVER translate foreign/technical words into the dominant language: dashboard must NOT become "boshqaruv paneli", deadline must NOT become "muddat", сразу must NOT become "srazu".
- Technical terms, product names, brand names, code identifiers, and acronyms stay exactly as spoken.
- Ordinary prose in the dominant language may be cleaned or summarized normally (for Uzbek: in Uzbek Latin).
- Preserve existing markdown **bold** around foreign terms when present.`;

function refinePrompt(transcript) {
  return `You are an expert note-taker. Below is a meeting/video transcript excerpt (the content may be in Uzbek, Russian, or English). Each line is "Speaker: text".

Rewrite it into clean, readable notes in flowing prose — as if a person listened to the conversation and wrote down everything important in an easy-to-read short-form style. This is NOT a short summary: it is a full, faithful rendition with the clutter removed.

HARD rules:
- Include EVERY point actually discussed and EVERY number, quantity, price, count, date, name, product, decision and task — exactly as stated. Missing or altering a number/fact is a FAILURE.
- Only remove: filler, hesitation, verbatim repetition, small talk, and back-channel ("aha", "xo'p", "mm", "mhm"). Do NOT compress two different facts into one; do NOT generalize specifics away.
- Aim for roughly HALF to TWO-THIRDS of the original length — fuller than a summary, tighter than verbatim.
- NO speaker labels ("Spiker 1", "Speaker 2", "Bunyodbek:"). Write flowing prose, NOT a dialogue. A person's name may appear naturally inside a sentence when it carries meaning.
- Write in the SAME language as the transcript (Uzbek → Uzbek Latin).
- Group related points into short paragraphs of 2–4 sentences, separated by a blank line.
- Output ONLY the notes — no preamble, no heading, no bullet symbols.

${MIXED}

Transcript:
${transcript}`;
}

function parseTs(ts){const p=ts.trim().split(":");let h=0,m=0,s="0";if(p.length===3)[h,m,s]=[+p[0],+p[1],p[2]];else if(p.length===2)[m,s]=[+p[0],p[1]];else return null;return h*3600+m*60+parseFloat(s);}
const lines = fs.readFileSync(path.join(SCRATCH, "vtt-live.vtt"), "utf8").split(/\r?\n/);
const cues = [];
for (let i = 0; i < lines.length; i++) {
  const a = lines[i].indexOf("-->"); if (a < 0) continue;
  const st = parseTs(lines[i].slice(0, a)); if (st == null) continue;
  let t = ""; for (let j = i + 1; j < lines.length && lines[j].trim() !== "" && !lines[j].includes("-->"); j++) t += lines[j] + " ";
  cues.push({ start: st, text: t.replace(/<[^>]+>/g, "").trim() });
}
const words = JSON.parse(fs.readFileSync(path.join(SCRATCH, "eleven-words.json"), "utf8"));

// pick 6-min window richest in digit-groups (numbers = highest quality risk)
const WIN = 360;
let best = { t0: 0, score: -1 };
for (let t0 = 300; t0 + WIN < 6600; t0 += WIN) {
  const txt = cues.filter(c => c.start >= t0 && c.start < t0 + WIN).map(c => c.text).join(" ");
  const score = (txt.match(/\d+/g) || []).length + (txt.match(/[A-Za-zА-Яа-я]{2,}/g) || []).filter(w => /[A-Za-z]/.test(w) && /^[A-Za-z]+$/.test(w)).length * 0.1;
  if (score > best.score) best = { t0, score };
}
const { t0 } = best; const t1 = t0 + WIN;
const gemText = cues.filter(c => c.start >= t0 && c.start < t1).map(c => c.text).join("\n");
const scrText = words.filter(w => w.start >= t0 && w.start < t1).map(w => w.word).join(" ").replace(/\s+([,.?!])/g, "$1").replace(/\s+/g, " ").trim();
console.log(`WINDOW ${(t0/60).toFixed(0)}-${(t1/60).toFixed(0)}min | gemini ${gemText.length}ch, scribe ${scrText.length}ch`);

async function gemini(prompt, attempt = 0) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.3 } }),
  });
  if (!res.ok) {
    const body = await res.text();
    if ((res.status === 503 || res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = 8000 * (attempt + 1);
      console.log(`  ${res.status}, retry ${attempt + 1}/5 in ${wait / 1000}s...`);
      await new Promise(r => setTimeout(r, wait));
      return gemini(prompt, attempt + 1);
    }
    throw new Error(`gemini ${res.status}: ${body.slice(0, 200)}`);
  }
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts ?? []).map(p => p.text ?? "").join("").trim();
}
const nums = (s) => [...new Set((s.match(/\d[\d.,]*/g) || []).map(x => x.replace(/[.,]$/, "")))].sort();

console.log("refining Gemini base...");
const gemRef = await gemini(refinePrompt(gemText));
console.log("refining Scribe base...");
const scrRef = await gemini(refinePrompt(scrText));

fs.writeFileSync(path.join(SCRATCH, "E-test-output.md"),
`# Option E quality test — window ${(t0/60).toFixed(0)}-${(t1/60).toFixed(0)}min\n\n## RAW Gemini (${gemText.length}ch)\n${gemText}\n\n## RAW Scribe (${scrText.length}ch)\n${scrText}\n\n## REFINED from Gemini\n${gemRef}\n\n## REFINED from Scribe\n${scrRef}\n`);

console.log(`\n===== NUMBERS =====`);
console.log(`raw Gemini: ${nums(gemText).join(" ")}`);
console.log(`raw Scribe: ${nums(scrText).join(" ")}`);
console.log(`refined(Gemini): ${nums(gemRef).join(" ")}`);
console.log(`refined(Scribe): ${nums(scrRef).join(" ")}`);
console.log(`\n===== REFINED FROM GEMINI (${gemRef.length}ch) =====\n${gemRef.slice(0, 1400)}`);
console.log(`\n===== REFINED FROM SCRIBE (${scrRef.length}ch) =====\n${scrRef.slice(0, 1400)}`);
console.log(`\n(full side-by-side saved: E-test-output.md)`);
