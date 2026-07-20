// Fetch bbzt audio from R2 + compute silence map locally.
// Run with cwd = apps/web so node_modules resolve.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire("D:/vibecoding/ustoz-github/apps/web/package.json");
const mysql = require("mysql2/promise");
const { S3Client, ListObjectsV2Command, GetObjectCommand } = require("@aws-sdk/client-s3");

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const VIDEO_ID = "bbzt2424z6vvy6t";

const rw = JSON.parse(fs.readFileSync(path.join(SCRATCH, "rw.json"), "utf8"));
const dbUrl = rw.DATABASE_URL.replace(/@[^/]+\//, "@thomas.proxy.rlwy.net:26774/");

// 1) ownerId + duration from DB
const conn = await mysql.createConnection(dbUrl);
const [rows] = await conn.execute(
  "SELECT ownerId, duration, transcriptionStatus FROM videos WHERE id = ?",
  [VIDEO_ID],
);
await conn.end();
if (!rows.length) throw new Error("video not found");
const { ownerId, duration, transcriptionStatus } = rows[0];
console.log(`ownerId=${ownerId} duration=${duration} status=${transcriptionStatus}`);

// 2) list R2 prefix
const s3 = new S3Client({
  region: rw.CAP_AWS_REGION || "auto",
  endpoint: rw.CAP_AWS_ENDPOINT,
  credentials: { accessKeyId: rw.CAP_AWS_ACCESS_KEY, secretAccessKey: rw.CAP_AWS_SECRET_KEY },
  forcePathStyle: true,
});
const list = await s3.send(new ListObjectsV2Command({
  Bucket: rw.CAP_AWS_BUCKET,
  Prefix: `${ownerId}/${VIDEO_ID}/`,
}));
const objs = (list.Contents ?? []).map(o => ({ key: o.Key, mb: +(o.Size / 1e6).toFixed(1) }));
console.log(JSON.stringify(objs, null, 1));

// 3) download the raw audio source (prefer raw-upload.*, else result.mp4)
const candidates = objs
  .filter(o => /raw-upload\.|result\.mp4/.test(o.key))
  .sort((a, b) => a.mb - b.mb);
const pick = candidates[0];
if (!pick) { console.log("NO SOURCE FILE FOUND"); process.exit(1); }
console.log(`downloading ${pick.key} (${pick.mb}MB)...`);
const obj = await s3.send(new GetObjectCommand({ Bucket: rw.CAP_AWS_BUCKET, Key: pick.key }));
const outPath = path.join(SCRATCH, "bbzt-audio" + path.extname(pick.key));
const ws = fs.createWriteStream(outPath);
await new Promise((res, rej) => { obj.Body.pipe(ws).on("finish", res).on("error", rej); });
console.log(`saved ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)}MB)`);

// 4) also grab the LIVE transcription.vtt (current silence-anchored one)
const vttObj = await s3.send(new GetObjectCommand({
  Bucket: rw.CAP_AWS_BUCKET, Key: `${ownerId}/${VIDEO_ID}/transcription.vtt`,
}));
const vttText = await vttObj.Body.transformToString();
fs.writeFileSync(path.join(SCRATCH, "vtt-live.vtt"), vttText);
console.log(`vtt-live.vtt saved (${vttText.length} chars)`);
