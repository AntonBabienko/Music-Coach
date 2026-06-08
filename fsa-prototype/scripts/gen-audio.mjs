// Generates public/sample-performance.wav: the same error-injected C-major
// scale as the demo MIDI, rendered as mono 16-bit sine tones so the audio
// pitch-detection path has a deterministic demo input.
//
//   - index 2  (E4) -> MIDI 63 (D#4)  "wrong"
//   - index 5  (A4) skipped            "missed"
//   - index 10 (A4) shifted +0.4s      "late"
//
// Run with: node scripts/gen-audio.mjs   (or: npm run gen-audio)

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "..", "public", "sample-performance.wav");

const SAMPLE_RATE = 44100;
const TEMPO = 100;
const quarter = 60 / TEMPO; // 0.6s
const noteDur = quarter * 0.9; // 0.54s sounding, 0.06s gap

const scale = [60, 62, 64, 65, 67, 69, 71, 72, 72, 71, 69, 67, 65, 64, 62, 60];

const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// Build the note timeline with the injected errors.
const events = [];
scale.forEach((pitch, i) => {
  if (i === 5) return; // missed
  let m = pitch;
  if (i === 2) m = 63; // wrong
  let time = i * quarter;
  if (i === 10) time += 0.4; // late
  events.push({ midi: m, time, dur: noteDur });
});

// Clip each note's sounding so it never overlaps the next onset. Without this,
// the deliberately "late" note (onset +0.4s) would overlap the following note,
// and two summed sine tones read as an ambiguous in-between pitch.
events.sort((a, b) => a.time - b.time);
for (let i = 0; i < events.length; i++) {
  const nextOnset = i + 1 < events.length ? events[i + 1].time : Infinity;
  events[i].dur = Math.max(0.08, Math.min(events[i].dur, nextOnset - events[i].time - 0.03));
}

const totalSec = Math.max(...events.map((e) => e.time + e.dur)) + 0.1;
const totalSamples = Math.ceil(totalSec * SAMPLE_RATE);
const buf = new Float32Array(totalSamples);

const fade = Math.floor(0.005 * SAMPLE_RATE); // 5ms attack/release to avoid clicks
for (const e of events) {
  const freq = midiToFreq(e.midi);
  const start = Math.floor(e.time * SAMPLE_RATE);
  const len = Math.floor(e.dur * SAMPLE_RATE);
  for (let n = 0; n < len; n++) {
    let amp = 0.6;
    if (n < fade) amp *= n / fade;
    else if (n > len - fade) amp *= (len - n) / fade;
    buf[start + n] += amp * Math.sin((2 * Math.PI * freq * n) / SAMPLE_RATE);
  }
}

// Encode as 16-bit PCM mono WAV.
const bytesPerSample = 2;
const dataSize = totalSamples * bytesPerSample;
const out = Buffer.alloc(44 + dataSize);
out.write("RIFF", 0);
out.writeUInt32LE(36 + dataSize, 4);
out.write("WAVE", 8);
out.write("fmt ", 12);
out.writeUInt32LE(16, 16); // PCM chunk size
out.writeUInt16LE(1, 20); // PCM
out.writeUInt16LE(1, 22); // mono
out.writeUInt32LE(SAMPLE_RATE, 24);
out.writeUInt32LE(SAMPLE_RATE * bytesPerSample, 28); // byte rate
out.writeUInt16LE(bytesPerSample, 32); // block align
out.writeUInt16LE(16, 34); // bits per sample
out.write("data", 36);
out.writeUInt32LE(dataSize, 40);
for (let i = 0; i < totalSamples; i++) {
  const s = Math.max(-1, Math.min(1, buf[i]));
  out.writeInt16LE(Math.round(s * 32767), 44 + i * bytesPerSample);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out);
console.log(`Wrote ${outPath} (${events.length} notes, ${totalSec.toFixed(2)}s).`);
