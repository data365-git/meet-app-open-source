// Confirm the drift mechanism: does each 900s chunk re-anchor (sawtooth =
// within-chunk Gemini compression) or accumulate (global offset)?
// Run: railway run --service @cap/web -- node apps/web/_measure-drift.mjs
import mysql from "mysql2/promise";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";

const publicUrl = process.env.DATABASE_URL.replace(/@[^/@]+:\d+/, "@thomas.proxy.rlwy.net:26774");
const db = await mysql.createConnection(publicUrl);
const [[v]] = await db.query(
  `SELECT id, ownerId, duration FROM videos WHERE id='bbzt2424z6vvy6t'`,
);
await db.end();

const s3 = new S3Client({
  region: process.env.CAP_AWS_REGION || "auto",
  endpoint: process.env.CAP_AWS_ENDPOINT,
  credentials: { accessKeyId: process.env.CAP_AWS_ACCESS_KEY, secretAccessKey: process.env.CAP_AWS_SECRET_KEY },
  forcePathStyle: true,
});
const obj = await s3.send(new GetObjectCommand({ Bucket: process.env.CAP_AWS_BUCKET, Key: `${v.ownerId}/${v.id}/transcription.vtt` }));
const vtt = await obj.Body.transformToString();

const toSec = (ts) => {
  const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/);
  if (!m) return null;
  return (m[1] ? +m[1] : 0) * 3600 + +m[2] * 60 + +m[3] + +m[4].padEnd(3, "0") / 1000;
};
const starts = vtt.split(/\r?\n/).filter((l) => l.includes("-->"))
  .map((l) => toSec(l.split("-->")[0])).filter((n) => n != null);

const CHUNK = 900;
console.log(`dur=${v.duration}  cues=${starts.length}\n`);
console.log("boundary | last cue < b | first cue >= b | gap-before-boundary");
for (let b = CHUNK; b < v.duration; b += CHUNK) {
  const before = [...starts].filter((s) => s < b).at(-1);
  const after = starts.find((s) => s >= b);
  console.log(
    `${b}s`.padEnd(9),
    `| ${before?.toFixed(1)}`.padEnd(15),
    `| ${after?.toFixed(1)}`.padEnd(16),
    `| ${before != null ? (b - before).toFixed(1) + "s below" : "-"}`,
  );
}
// If 'first cue >= b' ~= b for every boundary -> re-anchored (within-chunk drift).
// If it grows past b -> accumulating global offset.
