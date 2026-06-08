import { samplesToNotes } from "./lib/audio";
import { detectScore } from "./lib/omr";
import { parseMusicXML } from "./lib/musicxml";
import { compare } from "./lib/compare";
import { buildFeedback } from "./lib/feedback";
import { readFileSync } from "node:fs";

// Reference from OMR of the demo image geometry (re-draw bitmap) OR from XML.
const xml = readFileSync("public/sample.musicxml", "utf8");
const ref = parseMusicXML(xml).notes;

// Audio performance
const SR = 44100, quarter = 0.6, noteDur = quarter * 0.9;
const scale = [60,62,64,65,67,69,71,72,72,71,69,67,65,64,62,60];
const ev: {midi:number;time:number;dur:number}[] = [];
scale.forEach((p,i)=>{ if(i===5)return; let m=p; if(i===2)m=63; let t=i*quarter; if(i===10)t+=0.4; ev.push({midi:m,time:t,dur:noteDur}); });
ev.sort((a,b)=>a.time-b.time);
for(let i=0;i<ev.length;i++){const no=i+1<ev.length?ev[i+1].time:Infinity;ev[i].dur=Math.max(0.08,Math.min(ev[i].dur,no-ev[i].time-0.03));}
const total=Math.ceil((Math.max(...ev.map(e=>e.time+e.dur))+0.1)*SR);
const buf=new Float32Array(total);const fade=Math.floor(0.005*SR);
for(const e of ev){const f=440*2**((e.midi-69)/12);const s=Math.floor(e.time*SR);const len=Math.floor(e.dur*SR);
  for(let n=0;n<len;n++){let a=0.6;if(n<fade)a*=n/fade;else if(n>len-fade)a*=(len-n)/fade;buf[s+n]+=a*Math.sin(2*Math.PI*f*n/SR);}}
const perf = samplesToNotes(buf, SR);

const r = compare(ref, perf);
console.log("AUDIO path -> counts:", r.counts, "a:", r.tempoRatio.toFixed(3), "acc:", r.pitchAccuracy.toFixed(1)+"%");
console.log(buildFeedback(r).join("\n"));
