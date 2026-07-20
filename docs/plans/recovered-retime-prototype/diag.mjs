import fs from "node:fs";
import path from "node:path";
const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
const whisper = JSON.parse(fs.readFileSync(path.join(SCRATCH, "whisper-words.json"), "utf8"));
function parseTs(ts){const p=ts.trim().split(":");let h=0,m=0,s="0";if(p.length===3)[h,m,s]=[+p[0],+p[1],p[2]];else if(p.length===2)[m,s]=[+p[0],p[1]];else return null;return h*3600+m*60+parseFloat(s);}
const lines=fs.readFileSync(path.join(SCRATCH,"vtt-live.vtt"),"utf8").split(/\r?\n/);
const cues=[];
for(let i=0;i<lines.length;i++){const a=lines[i].indexOf("-->");if(a<0)continue;const st=parseTs(lines[i].slice(0,a));if(st==null)continue;let t="";for(let j=i+1;j<lines.length&&lines[j].trim()!==""&&!lines[j].includes("-->");j++)t+=lines[j]+" ";cues.push({start:st,text:t.replace(/<[^>]+>/g," ").trim()});}
// window around probe #241 true time ~1160s
for(const T of [1160, 3483, 5248]){
  console.log(`\n===== around ${T}s =====`);
  const wWords=whisper.filter(w=>w.start>=T-8&&w.start<=T+8).map(w=>w.word.trim()).join(" ");
  console.log(`WHISPER @${T}: ${wWords.slice(0,300)}`);
  // gemini cue nearest to orig position (the cue whose text we expect here); grab cues near T-off
  const near=cues.filter(c=>Math.abs(c.start-(T-15))<10).map(c=>c.text).join(" | ");
  console.log(`GEMINI  near: ${near.slice(0,300)}`);
}
// overall language sniff: fraction of whisper words that are ASCII-only (likely English)
const ascii=whisper.filter(w=>/^[\x00-\x7f]+$/.test(w.word.trim())).length;
console.log(`\nWhisper ASCII-only words: ${ascii}/${whisper.length} = ${(ascii/whisper.length*100).toFixed(0)}%`);
