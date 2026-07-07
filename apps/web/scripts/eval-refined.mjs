// GOLDEN-SET EVAL (docs/qa/GOLDEN_EVAL.md): pulls raw VTT + aiSummary for the
// given videos and measures refined-transcript data retention. Run after ANY
// prompt/model change in generate-ai.ts and compare with recorded baselines.
// Usage:
//   DATABASE_URL=<mysql url (public proxy)> \
//   CAP_AWS_ENDPOINT=... CAP_AWS_ACCESS_KEY=... CAP_AWS_SECRET_KEY=... \
//   node scripts/eval-refined.mjs [videoId ...]   (default: the golden set)
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import mysql from "mysql2/promise";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const GOLDEN_SET = ["4htfajtyrv30cv3", "patefma8qhn5rqe"];
const OUT = process.env.OUT || path.join(os.tmpdir(), "data365-eval");
const ids = process.argv.slice(2).length ? process.argv.slice(2) : GOLDEN_SET;

const s3 = new S3Client({
  region: "auto",
  endpoint: process.env.CAP_AWS_ENDPOINT,
  forcePathStyle: true,
  credentials: {
    accessKeyId: process.env.CAP_AWS_ACCESS_KEY,
    secretAccessKey: process.env.CAP_AWS_SECRET_KEY,
  },
});
const BUCKET = process.env.CAP_AWS_BUCKET || "ustoz-videos";

const conn = await mysql.createConnection(process.env.DATABASE_URL);

function extractTokens(text) {
  // protected tokens: numbers (incl. money like 400ming / 30k$ / 16:30 / 3.11.2025 / percentages)
  const re = /\d[\d.,:%\-\/]*\d|\d/g;
  const raw = text.match(re) || [];
  // normalize: strip trailing punctuation, dedupe
  const set = new Map();
  for (const t of raw) {
    const n = t.replace(/[.,:]+$/, "");
    if (n.length === 0) continue;
    set.set(n, (set.get(n) || 0) + 1);
  }
  return set;
}

function vttToText(vtt) {
  return vtt
    .split("\n")
    .filter((l) => l.trim() && !l.includes("-->") && l.trim() !== "WEBVTT" && !/^\d+$/.test(l.trim()))
    .join("\n");
}

for (const id of ids) {
  const [rows] = await conn.query("SELECT id, ownerId, name, duration, metadata FROM videos WHERE id=?", [id]);
  const v = rows[0];
  if (!v) { console.log(id, "NOT FOUND"); continue; }
  const meta = typeof v.metadata === "string" ? JSON.parse(v.metadata) : v.metadata;
  const ai = meta?.aiSummary;

  // fetch VTT
  let vtt = null;
  for (const key of [`${v.ownerId}/${id}/transcription.vtt`]) {
    try {
      const r = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
      vtt = await r.Body.transformToString();
      break;
    } catch (e) { console.log(id, "S3 miss:", key, e.name); }
  }
  if (!vtt) { console.log(id, "NO VTT"); continue; }

  const rawText = vttToText(vtt);
  const refinedParas = (ai?.refinedTranscript?.chapters || []).flatMap((c) => c.paragraphs || []);
  const refinedText = refinedParas.join("\n\n");

  fs.writeFileSync(path.join(OUT, `${id}-raw.txt`), rawText);
  fs.writeFileSync(path.join(OUT, `${id}-refined.txt`), refinedText);
  fs.writeFileSync(path.join(OUT, `${id}-aisummary.json`), JSON.stringify(ai, null, 2));

  // metrics
  const rawTokens = extractTokens(rawText);
  const refTokens = extractTokens(refinedText);
  const missing = [];
  for (const [tok] of rawTokens) {
    if (!refTokens.has(tok) && !refinedText.includes(tok)) missing.push(tok);
  }
  const speakerLabels = (refinedText.match(/Spiker\s*\d|Speaker\s*\d|Suhbatdosh\s*\d/gi) || []).length;

  console.log("=== " + id + " | " + v.name + " | dur " + Math.round(v.duration / 60) + "min ===");
  console.log("raw chars:", rawText.length, "| refined chars:", refinedText.length, "| ratio:", (refinedText.length / rawText.length).toFixed(2));
  console.log("refined chapters:", (ai?.refinedTranscript?.chapters || []).length, "| paragraphs:", refinedParas.length);
  console.log("summary chapters:", (ai?.chapters || []).length, "| tasks:", (ai?.tasks || []).length, "| nextSteps:", (ai?.nextSteps || []).length, "| topics:", (ai?.topics || []).length);
  console.log("numeric tokens raw:", rawTokens.size, "| missing in refined:", missing.length);
  if (missing.length) console.log("MISSING:", missing.slice(0, 40).join(" · "));
  console.log("speaker labels left in refined:", speakerLabels);
  console.log("");
}
await conn.end();
