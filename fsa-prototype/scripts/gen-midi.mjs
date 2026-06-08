// Generates public/sample-performance.mid: the C-major scale from
// sample.musicxml at tempo 100, with deliberate errors injected so the demo
// exercises every error type:
//   - index 2  (E4) replaced with MIDI 63 (D#4)  -> "wrong"
//   - index 5  (A4) skipped                       -> "missed"
//   - index 10 (A4) shifted later by +0.4s        -> "late"
//
// Run with: node scripts/gen-midi.mjs   (or: npm run gen-midi)

import pkg from "@tonejs/midi";
const { Midi } = pkg;
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "..", "public", "sample-performance.mid");

const TEMPO = 100;
const quarter = 60 / TEMPO; // seconds per quarter note = 0.6s

// Reference scale (MIDI), matching sample.musicxml exactly.
const scale = [60, 62, 64, 65, 67, 69, 71, 72, 72, 71, 69, 67, 65, 64, 62, 60];

const midi = new Midi();
midi.header.setTempo(TEMPO);
const track = midi.addTrack();

scale.forEach((pitch, i) => {
  if (i === 5) return; // missed: skip this note entirely

  let m = pitch;
  if (i === 2) m = 63; // wrong: D#4 instead of E4

  let time = i * quarter;
  if (i === 10) time += 0.4; // late: shift this note later

  track.addNote({
    midi: m,
    time,
    duration: quarter * 0.9,
    velocity: 0.8,
  });
});

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, Buffer.from(midi.toArray()));

console.log(`Wrote ${outPath} (${track.notes.length} notes).`);
