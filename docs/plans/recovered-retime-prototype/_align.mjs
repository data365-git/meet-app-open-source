// Alignment metric: fraction of transcript cue-time that overlaps DETECTED
// SILENCE (proxy for "transcript not lined up with speech" — higher = more
// misaligned/ahead). Saves the current VTT to scratchpad so before/after can be
// compared even after a re-transcribe overwrites it.
// Run: railway run --service @cap/web -- node apps/web/_align.mjs <label>
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const LABEL = process.argv[2] || "run";
const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/89fc7341-325e-4c7e-8108-fa93d00990c5/scratchpad";
const FFMPEG = "C:/Users/mirko/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe";

const url = process.env.DATABASE_URL.replace(/@[^/@]+:\d+/, "@thomas.proxy.rlwy.net:26774");
const db = await mysql.createConnection(url);
const [[v]] = await db.query(`SELECT id, ownerId, duration, transcriptionStatus FROM videos WHERE id='bbzt2424z6vvy6t'`);
await db.end();
console.log(`[${LABEL}] status=${v.transcriptionStatus} dur=${v.duration}`);

const s3 = new S3Client({ region: "auto", endpoint: process.env.CAP_AWS_ENDPOINT,
  credentials: { accessKeyId: process.env.CAP_AWS_ACCESS_KEY, secretAccessKey: process.env.CAP_AWS_SECRET_KEY }, forcePathStyle: true });
const get = async (k) => { try { const o = await s3.send(new GetObjectCommand({ Bucket: process.env.CAP_AWS_BUCKET, Key: k })); return await o.Body.transformToString(); } catch { return null; } };
const vtt = await get(`${v.ownerId}/${v.id}/transcription.vtt`);
if (!vtt) { console.log("no VTT"); process.exit(1); }
writeFileSync(`${SCRATCH}/vtt-${LABEL}.vtt`, vtt);

// cues
const toSec = (ts) => { const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/); return m ? (m[1]?+m[1]:0)*3600+ +m[2]*60+ +m[3]+ +m[4].padEnd(3,"0")/1000 : null; };
const cues = vtt.split(/\r?\n/).filter((l)=>l.includes("-->")).map((l)=>{ const [a,b]=l.split("-->"); return { s: toSec(a), e: toSec(b) }; }).filter((c)=>c.s!=null&&c.e!=null&&c.e>c.s);
console.log(`[${LABEL}] ${cues.length} cues, first=${cues[0].s}, last=${cues.at(-1).e.toFixed(1)}`);

// silence regions
const signed = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.CAP_AWS_BUCKET, Key: `${v.ownerId}/${v.id}/raw-upload.mp4` }), { expiresIn: 3600 });
const stderr = await new Promise((res, rej) => { const p = spawn(FFMPEG, ["-i", signed, "-vn", "-af", "silencedetect=noise=-30dB:d=0.5", "-f", "null", "-"], { stdio:["pipe","pipe","pipe"] }); let e=""; p.stderr.on("data",(d)=>e+=d); p.on("error",rej); p.on("close",()=>res(e)); });
const ss = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map((m)=>Number(m[1]));
const se = [...stderr.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map((m)=>Number(m[1]));
const sil = ss.map((s,i)=>({ s, e: se[i] ?? v.duration })).filter((x)=>x.e>x.s);
const totalSil = sil.reduce((n,x)=>n+(x.e-x.s),0);
console.log(`[${LABEL}] ${sil.length} silence regions, ${(totalSil).toFixed(0)}s silent (${(100*totalSil/v.duration).toFixed(0)}% of audio)`);

// overlap of cue-time with silence
function overlapWithSilence(cs, ce) {
  let ov = 0;
  for (const z of sil) { const lo = Math.max(cs, z.s), hi = Math.min(ce, z.e); if (hi > lo) ov += hi - lo; }
  return ov;
}
let cueTime = 0, cueInSil = 0;
for (const c of cues) { cueTime += c.e - c.s; cueInSil += overlapWithSilence(c.s, c.e); }
console.log(`[${LABEL}] cue-in-silence = ${(100*cueInSil/cueTime).toFixed(1)}%  (lower = better aligned; if transcript is AHEAD, cues fall into silence more)`);
