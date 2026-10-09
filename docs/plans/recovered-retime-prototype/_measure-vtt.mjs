// Probe: find the most recent long AUDIO video and dump its transcript VTT
// timestamp format (head + tail) to diagnose the transcript-ahead sync bug.
// Run: railway run --service @cap/web -- node apps/web/_measure-vtt.mjs
import mysql from "mysql2/promise";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

// The service's DATABASE_URL points at the internal host (only resolves inside
// Railway). Swap it for the public TCP proxy so this runs from a dev machine.
const publicUrl = process.env.DATABASE_URL.replace(
  /@[^/@]+:\d+/,
  "@thomas.proxy.rlwy.net:26774",
);
const db = await mysql.createConnection(publicUrl);

const [rows] = await db.query(
  `SELECT id, ownerId, name, source, duration, transcriptionStatus, metadata, createdAt
   FROM videos
   ORDER BY createdAt DESC
   LIMIT 25`,
);

const isAudio = (m) => {
  try { return !!(typeof m === "string" ? JSON.parse(m) : m)?.isAudio; } catch { return false; }
};

console.log("=== recent videos (newest first) ===");
for (const r of rows) {
  console.log(
    [r.id, `dur=${r.duration ?? "?"}s`, `audio=${isAudio(r.metadata)}`,
     r.transcriptionStatus, (r.name || "").slice(0, 30), r.createdAt?.toISOString?.() ?? r.createdAt]
      .join("  |  "),
  );
}

// Pick: the newest video whose duration is long (>= 3600s) OR flagged audio.
const target =
  rows.find((r) => isAudio(r.metadata) && Number(r.duration) >= 3000) ||
  rows.find((r) => Number(r.duration) >= 3600) ||
  rows.find((r) => isAudio(r.metadata)) ||
  rows[0];

console.log("\n=== TARGET ===");
console.log(target.id, "owner=", target.ownerId, "dur=", target.duration, "audio=", isAudio(target.metadata), "status=", target.transcriptionStatus);

const s3 = new S3Client({
  region: process.env.CAP_AWS_REGION || "auto",
  endpoint: process.env.CAP_AWS_ENDPOINT,
  credentials: {
    accessKeyId: process.env.CAP_AWS_ACCESS_KEY,
    secretAccessKey: process.env.CAP_AWS_SECRET_KEY,
  },
  forcePathStyle: true,
});
const bucket = process.env.CAP_AWS_BUCKET;
const key = `${target.ownerId}/${target.id}/transcription.vtt`;
console.log("VTT key:", key);

const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
const vtt = await obj.Body.transformToString();

// Only the timestamp lines (contain -->)
const tsLines = vtt.split(/\r?\n/).filter((l) => l.includes("-->"));
console.log(`\n=== VTT: ${tsLines.length} cue timestamp lines ===`);
console.log("--- FIRST 8 ---");
tsLines.slice(0, 8).forEach((l) => console.log(l));
console.log("--- LAST 12 (near end of a 2h audio) ---");
tsLines.slice(-12).forEach((l) => console.log(l));

// --- Full-file linearity + continuity analysis ---
// Parse start seconds of every cue (hh:mm:ss.mmm | mm:ss.mmm).
const toSec = (ts) => {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  const h = m[1] ? +m[1] : 0;
  return h * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1000;
};
const starts = tsLines.map((l) => toSec(l.split("-->")[0])).filter((n) => n != null);
console.log(`\n=== linearity: ${starts.length} parsed starts ===`);
console.log("first=", starts[0], "last=", starts.at(-1), "audioDur=", target.duration);

let backwards = 0, maxGap = 0, maxGapAt = 0;
for (let i = 1; i < starts.length; i++) {
  const d = starts[i] - starts[i - 1];
  if (d < -0.001) backwards++;
  if (d > maxGap) { maxGap = d; maxGapAt = starts[i - 1]; }
}
console.log(`backward steps=${backwards}  maxGap=${maxGap.toFixed(1)}s at ~${maxGapAt.toFixed(0)}s`);

// Sample every ~10% to see cue-index -> time mapping shape.
console.log("--- sampled (idx% -> startSec) ---");
for (let p = 0; p <= 100; p += 10) {
  const idx = Math.min(starts.length - 1, Math.floor((p / 100) * starts.length));
  console.log(`${p}% (cue ${idx}) -> ${starts[idx]?.toFixed(1)}s`);
}

await db.end();
