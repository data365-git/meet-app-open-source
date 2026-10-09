// Repair bbzt live transcription.vtt in R2 with the Scribe-aligned VTT.
// Keeps a backup of the original. Reversible.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire("D:/vibecoding/ustoz-github/apps/web/package.json");
const { S3Client, GetObjectCommand, PutObjectCommand } = require("@aws-sdk/client-s3");

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const rw = JSON.parse(fs.readFileSync(path.join(SCRATCH, "rw.json"), "utf8"));
const ownerId = "25s3fqp7e7vc5p0", videoId = "bbzt2424z6vvy6t";
const key = `${ownerId}/${videoId}/transcription.vtt`;
const bakKey = `${ownerId}/${videoId}/transcription.vtt.bak-predrift`;

const s3 = new S3Client({
  region: rw.CAP_AWS_REGION || "auto",
  endpoint: rw.CAP_AWS_ENDPOINT,
  credentials: { accessKeyId: rw.CAP_AWS_ACCESS_KEY, secretAccessKey: rw.CAP_AWS_SECRET_KEY },
  forcePathStyle: true,
});

// 1) backup original (skip if backup already exists — don't clobber the true original)
let haveBak = false;
try { await s3.send(new GetObjectCommand({ Bucket: rw.CAP_AWS_BUCKET, Key: bakKey })); haveBak = true; } catch {}
if (!haveBak) {
  const orig = await s3.send(new GetObjectCommand({ Bucket: rw.CAP_AWS_BUCKET, Key: key }));
  const origText = await orig.Body.transformToString();
  await s3.send(new PutObjectCommand({ Bucket: rw.CAP_AWS_BUCKET, Key: bakKey, Body: origText, ContentType: "text/vtt" }));
  console.log(`backup saved -> ${bakKey} (${origText.length} chars)`);
} else {
  console.log(`backup already exists at ${bakKey} (original preserved, not overwritten)`);
}

// 2) upload the Scribe-aligned VTT
const fixed = fs.readFileSync(path.join(SCRATCH, "fixed-eleven-live.vtt"), "utf8");
if (!fixed.startsWith("WEBVTT")) throw new Error("fixed vtt missing WEBVTT header — abort");
await s3.send(new PutObjectCommand({ Bucket: rw.CAP_AWS_BUCKET, Key: key, Body: fixed, ContentType: "text/vtt" }));
console.log(`uploaded Scribe-aligned VTT -> ${key} (${fixed.length} chars)`);
console.log(`REVERT if needed: copy ${bakKey} back to ${key}`);
