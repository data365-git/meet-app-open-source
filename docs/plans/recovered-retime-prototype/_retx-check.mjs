// Check the 6-min re-transcribe of bbzt2424z6vvy6t: status, whether the free
// tier coped with ~20 chunks, and the within-chunk drift vs the 15-min baseline.
// Run: railway run --service @cap/web -- node apps/web/_retx-check.mjs
import mysql from "mysql2/promise";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const url = process.env.DATABASE_URL.replace(/@[^/@]+:\d+/, "@thomas.proxy.rlwy.net:26774");
const db = await mysql.createConnection(url);
const [[v]] = await db.query(
  `SELECT id, ownerId, duration, transcriptionStatus,
          JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.autoRecoverAttempts')) AS attempts,
          JSON_UNQUOTE(JSON_EXTRACT(metadata,'$.processingStartedAt')) AS startedAt
   FROM videos WHERE id='bbzt2424z6vvy6t'`,
);
console.log("status=", v.transcriptionStatus, " attempts=", v.attempts, " startedAt=", v.startedAt, " dur=", v.duration);

// Recent Gemini usage events for this video (did free work? paid fallback? how many calls?)
const [ev] = await db.query(
  `SELECT model, COUNT(*) n, ROUND(SUM(costUsdCents)/100,4) usd
   FROM ai_usage_events WHERE videoId='bbzt2424z6vvy6t'
   GROUP BY model ORDER BY n DESC`,
).catch((e) => { console.log("usage query err:", e.message); return [[]]; });
console.log("=== ai_usage by model ===");
for (const r of ev) console.log(` ${r.model} | calls=${r.n} | $${r.usd}`);

const s3 = new S3Client({
  region: process.env.CAP_AWS_REGION || "auto", endpoint: process.env.CAP_AWS_ENDPOINT,
  credentials: { accessKeyId: process.env.CAP_AWS_ACCESS_KEY, secretAccessKey: process.env.CAP_AWS_SECRET_KEY },
  forcePathStyle: true,
});
const bucket = process.env.CAP_AWS_BUCKET;
async function tryGet(key) {
  try { const o = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key })); return await o.Body.transformToString(); }
  catch { return null; }
}
let vtt = await tryGet(`${v.ownerId}/${v.id}/transcription.vtt`);
let src = "final";
if (v.transcriptionStatus !== "COMPLETE") {
  const p = await tryGet(`${v.ownerId}/${v.id}/transcription-partial.vtt`);
  if (p) { vtt = p; src = "partial(in-progress)"; }
}
if (!vtt) { console.log("no VTT yet"); await db.end(); process.exit(0); }

const toSec = (ts) => { const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/); return m ? (m[1]?+m[1]:0)*3600 + +m[2]*60 + +m[3] + +m[4].padEnd(3,"0")/1000 : null; };
const starts = vtt.split(/\r?\n/).filter((l)=>l.includes("-->")).map((l)=>toSec(l.split("-->")[0])).filter((n)=>n!=null);
console.log(`\n=== VTT (${src}): ${starts.length} cues, first=${starts[0]}, last=${starts.at(-1)?.toFixed(1)} ===`);

// Detect chunk size by re-anchor points: try 360 and 900.
for (const CHUNK of [360, 900]) {
  let anchored = 0, boundaries = 0, maxShort = 0;
  for (let b = CHUNK; b < starts.at(-1); b += CHUNK) {
    boundaries++;
    const after = starts.find((s) => s >= b);
    const before = [...starts].filter((s) => s < b).at(-1);
    if (after != null && Math.abs(after - b) < 2) anchored++;
    if (before != null) maxShort = Math.max(maxShort, b - before);
  }
  console.log(`  @${CHUNK}s chunks: re-anchored ${anchored}/${boundaries} boundaries, max within-chunk shortfall=${maxShort.toFixed(1)}s`);
}
await db.end();
