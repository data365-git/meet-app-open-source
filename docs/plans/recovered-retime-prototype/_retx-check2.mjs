// Re-check the 6-min re-transcribe: complete? drift? which model/key was used?
// Run: railway run --service @cap/web -- node apps/web/_retx-check2.mjs
import mysql from "mysql2/promise";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const url = process.env.DATABASE_URL.replace(/@[^/@]+:\d+/, "@thomas.proxy.rlwy.net:26774");
const db = await mysql.createConnection(url);
const [[v]] = await db.query(
  `SELECT id, ownerId, duration, transcriptionStatus,
          JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.autoRecoverAttempts')) AS attempts
   FROM videos WHERE id='bbzt2424z6vvy6t'`,
);
console.log("status=", v.transcriptionStatus, " attempts=", v.attempts, " dur=", v.duration);

// usage events schema first
const [cols] = await db.query(`SHOW COLUMNS FROM ai_usage_events`).catch(() => [[]]);
const colNames = cols.map((c) => c.Field);
const [ev] = await db.query(
  `SELECT * FROM ai_usage_events WHERE videoId='bbzt2424z6vvy6t' ORDER BY createdAt DESC LIMIT 30`,
).catch((e) => { console.log("usage err:", e.message); return [[]]; });
console.log(`=== usage events (${ev.length}, cols: ${colNames.join(",").slice(0,200)}) ===`);
for (const r of ev.slice(0, 30)) {
  console.log(` ${r.createdAt?.toISOString?.() ?? r.createdAt} | ${r.model ?? "?"} | op=${r.operation ?? "?"} | cost=${r.costCents ?? r.cost ?? r.costUsd ?? "?"}`);
}

const s3 = new S3Client({
  region: "auto", endpoint: process.env.CAP_AWS_ENDPOINT,
  credentials: { accessKeyId: process.env.CAP_AWS_ACCESS_KEY, secretAccessKey: process.env.CAP_AWS_SECRET_KEY },
  forcePathStyle: true,
});
async function tryGet(key) {
  try { const o = await s3.send(new GetObjectCommand({ Bucket: process.env.CAP_AWS_BUCKET, Key: key })); return await o.Body.transformToString(); }
  catch { return null; }
}
let vtt = await tryGet(`${v.ownerId}/${v.id}/transcription.vtt`);
let src = "final";
const partial = await tryGet(`${v.ownerId}/${v.id}/transcription-partial.vtt`);
if (v.transcriptionStatus !== "COMPLETE" && partial) { vtt = partial; src = "partial"; }
if (!vtt) { console.log("no VTT"); await db.end(); process.exit(0); }

const toSec = (ts) => { const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/); return m ? (m[1]?+m[1]:0)*3600 + +m[2]*60 + +m[3] + +m[4].padEnd(3,"0")/1000 : null; };
const starts = vtt.split(/\r?\n/).filter((l)=>l.includes("-->")).map((l)=>toSec(l.split("-->")[0])).filter((n)=>n!=null);
console.log(`\n=== VTT (${src}): ${starts.length} cues, first=${starts[0]}, last=${starts.at(-1)?.toFixed(1)}, audio=${v.duration} ===`);

if (v.transcriptionStatus === "COMPLETE") {
  const CHUNK = 360;
  let worst = 0; const gaps = [];
  for (let b = CHUNK; b < v.duration; b += CHUNK) {
    const before = [...starts].filter((s) => s < b).at(-1);
    if (before != null) { const g = b - before; gaps.push(g.toFixed(0)); if (g > worst) worst = g; }
  }
  console.log(`6-min boundaries: shortfalls = [${gaps.join(", ")}]s ; WORST=${worst.toFixed(1)}s (15-min baseline worst was 92s)`);
}
await db.end();
