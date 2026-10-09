// Measure bbzt card sizes (mimic groupCuesIntoCards) to decide which drift level
// (11s retime vs 3s Scribe) fits within a card.
import fs from "node:fs";
import path from "node:path";
const SCRATCH = "C:/Users/mirko/AppData/Local/Temp/claude/D--vibecoding/45b320b2-e549-4e83-a97d-c5644f454aae/scratchpad";
function parseTs(ts){const p=ts.trim().split(":");let h=0,m=0,s="0";if(p.length===3)[h,m,s]=[+p[0],+p[1],p[2]];else if(p.length===2)[m,s]=[+p[0],p[1]];else return null;return h*3600+m*60+parseFloat(s);}
function parse(file){
  const lines=fs.readFileSync(path.join(SCRATCH,file),"utf8").split(/\r?\n/);
  const cues=[];
  for(let i=0;i<lines.length;i++){const a=lines[i].indexOf("-->");if(a<0)continue;
    const st=parseTs(lines[i].slice(0,a));const en=parseTs(lines[i].slice(a+3).trim().split(/\s+/)[0]);
    if(st==null||en==null)continue;
    let raw="";for(let j=i+1;j<lines.length&&lines[j].trim()!==""&&!lines[j].includes("-->");j++)raw+=lines[j]+" ";
    const sp=raw.match(/<v\s+([^>]+)>/);
    cues.push({start:st,end:en,speaker:sp?sp[1].trim():null});
  }
  return cues;
}
// mimic groupCuesIntoCards: same speaker, gap<=6, span<=60
function cards(cues){
  const GAP=6,SPAN=60,out=[];
  for(const c of cues){const cur=out[out.length-1];const prev=cur?.cues[cur.cues.length-1];
    const same=cur&&cur.speaker===c.speaker;const gapOk=prev&&c.start-prev.end<=GAP;const spanOk=cur&&c.end-cur.start<=SPAN;
    if(cur&&same&&gapOk&&spanOk)cur.cues.push(c);
    else out.push({speaker:c.speaker,start:c.start,cues:[c]});
  }
  return out.map(cd=>({start:cd.start,end:cd.cues[cd.cues.length-1].end,dur:cd.cues[cd.cues.length-1].end-cd.start,n:cd.cues.length}));
}
const cues=parse("vtt-live.vtt");
const cd=cards(cues);
const durs=cd.map(c=>c.dur).sort((a,b)=>a-b);
const q=(p)=>durs[Math.floor(durs.length*p)].toFixed(1);
console.log(`cues=${cues.length}, speakers=${new Set(cues.map(c=>c.speaker)).size}, CARDS=${cd.length}`);
console.log(`card dur (s): p10=${q(0.1)} p25=${q(0.25)} MEDIAN=${q(0.5)} p75=${q(0.75)} p90=${q(0.9)} max=${durs[durs.length-1].toFixed(1)}`);
const under = (t)=>`${(durs.filter(d=>d<t).length/durs.length*100).toFixed(0)}%`;
console.log(`cards shorter than: 5s=${under(5)} 11s=${under(11)} 18s=${under(18)} 30s=${under(30)}`);
console.log(`\nINTERPRETATION: a drift of X is "within a card" only when X < card dur.`);
console.log(`  -> 3s Scribe fits ${(durs.filter(d=>d>3).length/durs.length*100).toFixed(0)}% of cards`);
console.log(`  -> 11s retime fits ${(durs.filter(d=>d>11).length/durs.length*100).toFixed(0)}% of cards`);
console.log(`  -> 18s raw fits ${(durs.filter(d=>d>18).length/durs.length*100).toFixed(0)}% of cards`);
// first 6 cards timing
console.log(`\nfirst 8 cards [start-end dur]:`);
console.log(cd.slice(0,8).map(c=>`${c.start.toFixed(0)}-${c.end.toFixed(0)}(${c.dur.toFixed(0)}s)`).join("  "));
