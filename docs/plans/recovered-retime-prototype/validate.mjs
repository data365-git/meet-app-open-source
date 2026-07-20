import fs from "node:fs";
import path from "node:path";
const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const TOTAL = 6993.71;
function parseTs(ts){const p=ts.trim().split(":");let h=0,m=0,s="0";if(p.length===3)[h,m,s]=[+p[0],+p[1],p[2]];else if(p.length===2)[m,s]=[+p[0],p[1]];else return null;return h*3600+m*60+parseFloat(s);}
function parse(file){const lines=fs.readFileSync(path.join(SCRATCH,file),"utf8").split(/\r?\n/);const cues=[];for(let i=0;i<lines.length;i++){const a=lines[i].indexOf("-->");if(a<0)continue;const st=parseTs(lines[i].slice(0,a));const en=parseTs(lines[i].slice(a+3).trim().split(/\s+/)[0]);if(st==null||en==null)continue;let t="";for(let j=i+1;j<lines.length&&lines[j].trim()!==""&&!lines[j].includes("-->");j++)t+=lines[j]+" ";cues.push({start:st,end:en,text:t.replace(/<[^>]+>/g,"").trim()});}return cues;}
const o=parse("vtt-live.vtt"), f=parse("fixed-eleven-live.vtt");
console.log(`orig cues=${o.length}  fixed cues=${f.length}  (must match: ${o.length===f.length})`);
let mono=true, oob=0, negDur=0, maxJump=0;
for(let i=0;i<f.length;i++){
  if(i>0&&f[i].start<f[i-1].start-0.001)mono=false;
  if(f[i].start<0||f[i].end>TOTAL+0.5)oob++;
  if(f[i].end<f[i].start)negDur++;
  maxJump=Math.max(maxJump,Math.abs(f[i].start-o[i].start));
}
console.log(`monotonic=${mono}  out-of-bounds=${oob}  negative-dur=${negDur}  maxShift=${maxJump.toFixed(0)}s`);
const durs=f.map(c=>c.end-c.start).sort((a,b)=>a-b);
console.log(`cue dur: median=${durs[durs.length>>1].toFixed(1)}s  p95=${durs[Math.floor(durs.length*0.95)].toFixed(1)}s  max=${durs[durs.length-1].toFixed(1)}s`);
console.log(`\nfirst 3 / last 3 (orig -> fixed):`);
for(const i of [0,1,2,f.length-3,f.length-2,f.length-1]){
  console.log(`  ${o[i].start.toFixed(0)}s -> ${f[i].start.toFixed(0)}s | ${f[i].text.slice(0,55)}`);
}
