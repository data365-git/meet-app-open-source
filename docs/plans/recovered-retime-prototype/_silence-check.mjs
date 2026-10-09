import { spawn } from "node:child_process";
import mysql from "mysql2/promise";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { computeSilenceAnchoredCuts } from "./lib/audio-extract.ts";

const FFMPEG = "C:/Users/mirko/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe";

const url = process.env.DATABASE_URL.replace(/@[^/@]+:\d+/, "@thomas.proxy.rlwy.net:26774");
const db = await mysql.createConnection(url);
const [[v]] = await db.query(`SELECT id, ownerId, duration FROM videos WHERE id='bbzt2424z6vvy6t'`);
await db.end();

const s3 = new S3Client({ region: "auto", endpoint: process.env.CAP_AWS_ENDPOINT,
  credentials: { accessKeyId: process.env.CAP_AWS_ACCESS_KEY, secretAccessKey: process.env.CAP_AWS_SECRET_KEY }, forcePathStyle: true });
const signed = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.CAP_AWS_BUCKET, Key: `${v.ownerId}/${v.id}/raw-upload.mp4` }), { expiresIn: 3600 });

async function detect(noise) {
  const stderr = await new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, ["-i", signed, "-vn", "-af", `silencedetect=noise=${noise}:d=0.35`, "-f", "null", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let e = ""; p.stderr.on("data", (d) => (e += d));
    p.on("error", reject);
    p.on("close", () => resolve(e));
  });
  const starts = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const ends = [...stderr.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map((m) => Number(m[1]));
  const hasInput = /Duration:/.test(stderr);
  return { silences: starts.map((s, i) => ({ start: s, end: ends[i] ?? v.duration })), hasInput, err: /Error|Invalid|No such/.test(stderr) };
}

for (const noise of ["-30dB", "-25dB", "-20dB", "-18dB"]) {
  const { silences, hasInput, err } = await detect(noise);
  const lead = silences.find((s) => s.start <= 1.0);
  console.log(`\n=== ${noise} | ffmpegReadInput=${hasInput} err=${err} | ${silences.length} silences ===`);
  console.log("  leading:", lead ? `${lead.start.toFixed(1)}->${lead.end.toFixed(1)}` : "NONE");
  silences.slice(0, 5).forEach((s) => console.log(`   ${s.start.toFixed(1)}->${s.end.toFixed(1)}`));
  const specs = computeSilenceAnchoredCuts(silences, v.duration, 360);
  console.log(`  chunk0 startSec=${specs[0].startSec} | chunks=${specs.length}`);
}
