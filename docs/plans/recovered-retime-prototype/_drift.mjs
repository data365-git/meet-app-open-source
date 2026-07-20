// Proper drift metric: cross-correlate the transcript's cue-active signal
// against the audio's speech signal. The lag that maximizes overlap = how many
// seconds the transcript is shifted. lag>0 => transcript is AHEAD (cues earlier
// than speech). ~0 => aligned. Uses the two saved VTTs ($0, no re-transcribe).
// Run: railway run --service @cap/web -- node apps/web/_drift.mjs
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/89fc7341-325e-4c7e-8108-fa93d00990c5/scratchpad";
const FFMPEG = "C:/Users/mirko/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.2-full_build/bin/ffmpeg.exe";
const DUR = 6994, N = Math.ceil(DUR);

const s3 = new S3Client({ region: "auto", endpoint: process.env.CAP_AWS_ENDPOINT,
  credentials: { accessKeyId: process.env.CAP_AWS_ACCESS_KEY, secretAccessKey: process.env.CAP_AWS_SECRET_KEY }, forcePathStyle: true });
const signed = await getSignedUrl(s3, new GetObjectCommand({ Bucket: process.env.CAP_AWS_BUCKET, Key: "25s3fqp7e7vc5p0/bbzt2424z6vvy6t/raw-upload.mp4" }), { expiresIn: 3600 });

// speech[t] = 1 if second t is speech (not in a silence region)
const stderr = await new Promise((res, rej) => { const p = spawn(FFMPEG, ["-i", signed, "-vn", "-af", "silencedetect=noise=-30dB:d=0.5", "-f", "null", "-"], { stdio:["pipe","pipe","pipe"] }); let e=""; p.stderr.on("data",(d)=>e+=d); p.on("error",rej); p.on("close",()=>res(e)); });
const ss = [...stderr.matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)].map((m)=>Number(m[1]));
const se = [...stderr.matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)/g)].map((m)=>Number(m[1]));
const speech = new Float64Array(N).fill(1);
ss.forEach((s,i)=>{ const e=se[i]??DUR; for(let t=Math.floor(s);t<Math.min(N,Math.ceil(e));t++) speech[t]=0; });

const toSec = (ts) => { const m = ts.trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/); return m ? (m[1]?+m[1]:0)*3600+ +m[2]*60+ +m[3]+ +m[4].padEnd(3,"0")/1000 : null; };
function cueSignal(vtt){ const a=new Float64Array(N); vtt.split(/\r?\n/).filter((l)=>l.includes("-->")).forEach((l)=>{ const[x,y]=l.split("-->"); const s=toSec(x),e=toSec(y); if(s==null||e==null)return; for(let t=Math.floor(s);t<Math.min(N,Math.ceil(e));t++)a[t]=1; }); return a; }

function bestLag(cue){
  // shift cue by +lag (later) and measure overlap with speech; lag>0 means cue
  // was ahead and needs delaying to match speech.
  let best=0,bestScore=-1;
  for(let lag=-60;lag<=150;lag++){
    let dot=0,cn=0,sn=0;
    for(let t=0;t<N;t++){ const c=cue[t-lag]||0; dot+=c*speech[t]; cn+=c; sn+=speech[t]; }
    const score=dot/Math.sqrt((cn||1)*(sn||1));
    if(score>bestScore){bestScore=score;best=lag;}
  }
  return {best,bestScore};
}

for(const label of ["baseline-6min","after-silence-anchored"]){
  let vtt; try{ vtt=readFileSync(`${SCRATCH}/vtt-${label}.vtt`,"utf8"); }catch{ console.log(label,"- no saved VTT"); continue; }
  const {best,bestScore}=bestLag(cueSignal(vtt));
  console.log(`${label}: best-lag = ${best>0?"+":""}${best}s  (lag>0 = transcript AHEAD by that many s)  corr=${bestScore.toFixed(3)}`);
}
