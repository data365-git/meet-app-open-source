// Restore bbzt live transcription.vtt to the ORIGINAL Gemini times (18s drift),
// for an honest free-path test (block-highlight over the worst-case drift).
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
const s3 = new S3Client({ region: rw.CAP_AWS_REGION || "auto", endpoint: rw.CAP_AWS_ENDPOINT,
  credentials: { accessKeyId: rw.CAP_AWS_ACCESS_KEY, secretAccessKey: rw.CAP_AWS_SECRET_KEY }, forcePathStyle: true });
const bak = await s3.send(new GetObjectCommand({ Bucket: rw.CAP_AWS_BUCKET, Key: bakKey }));
const text = await bak.Body.transformToString();
if (!text.startsWith("WEBVTT")) throw new Error("backup missing WEBVTT header — abort");
await s3.send(new PutObjectCommand({ Bucket: rw.CAP_AWS_BUCKET, Key: key, Body: text, ContentType: "text/vtt" }));
console.log(`restored ORIGINAL Gemini VTT -> ${key} (${text.length} chars). bbzt now at ~18s drift for the free-path test.`);
