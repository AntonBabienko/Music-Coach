import { samplesToNotes } from "./lib/audio";

const SR = 44100;
const quarter = 0.6;
const noteDur = quarter * 0.9;
const scale = [60, 62, 64, 65, 67, 69, 71, 72, 72, 71, 69, 67, 65, 64, 62, 60];
const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

const events: { midi: number; time: number; dur: number }[] = [];
scale.forEach((p, i) => {
  if (i === 5) return;
  let m = p;
  if (i === 2) m = 63;
  let time = i * quarter;
  if (i === 10) time += 0.4;
  events.push({ midi: m, time, dur: noteDur });
});

events.sort((a, b) => a.time - b.time);
for (let i = 0; i < events.length; i++) {
  const nextOnset = i + 1 < events.length ? events[i + 1].time : Infinity;
  events[i].dur = Math.max(0.08, Math.min(events[i].dur, nextOnset - events[i].time - 0.03));
}

const total = Math.ceil((Math.max(...events.map((e) => e.time + e.dur)) + 0.1) * SR);
const buf = new Float32Array(total);
const fade = Math.floor(0.005 * SR);
for (const e of events) {
  const f = midiToFreq(e.midi);
  const s = Math.floor(e.time * SR);
  const len = Math.floor(e.dur * SR);
  for (let n = 0; n < len; n++) {
    let amp = 0.6;
    if (n < fade) amp *= n / fade;
    else if (n > len - fade) amp *= (len - n) / fade;
    buf[s + n] += amp * Math.sin((2 * Math.PI * f * n) / SR);
  }
}

const notes = samplesToNotes(buf, SR);
const got = notes.map((n) => n.midi);
const expected = [60, 62, 63, 65, 67, 71, 72, 72, 71, 69, 67, 65, 64, 62, 60];
console.log("audio detected count:", notes.length);
console.log("got     :", got.join(" "));
console.log("expected:", expected.join(" "));
console.log("MATCH:", JSON.stringify(got) === JSON.stringify(expected));
console.log("first 5 onsets:", notes.slice(0, 5).map((n) => n.onsetSec.toFixed(2)).join(" "));
