// Generates test fixture files used by e2e/realistic.spec.ts.
// Called automatically from e2e/global-setup.ts when files are missing.
import pkg from "@tonejs/midi";
const { Midi } = pkg;
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, "..", "e2e", "fixtures");
mkdirSync(fixturesDir, { recursive: true });

// Perfect performance: all 16 notes of sample.musicxml at correct pitch/time.
const scale = [60, 62, 64, 65, 67, 69, 71, 72, 72, 71, 69, 67, 65, 64, 62, 60];
const q = 0.6; // quarter note at tempo 100

const midi = new Midi();
midi.header.setTempo(100);
const track = midi.addTrack();
scale.forEach((m, i) =>
  track.addNote({ midi: m, time: i * q, duration: q * 0.9, velocity: 0.8 })
);

const out = resolve(fixturesDir, "perfect-perf.mid");
writeFileSync(out, Buffer.from(midi.toArray()));
console.log(`Wrote ${out} (${track.notes.length} notes).`);
