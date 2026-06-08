// Generates public/sample-score.svg: a clean treble-clef rendering of the
// C-major scale (the same notes as sample.musicxml) as a raster-friendly image
// for the OMR (image -> score) demo path.
//
// The image is deliberately "clean": full-width staff lines + filled noteheads,
// no stems / beams / ledger lines / accidentals — matching the v1 OMR detector
// constraints (see lib/omr.ts and README).
//
// Run with: node scripts/gen-score-image.mjs  (or: npm run gen-image)

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(__dirname, "..", "public", "sample-score.svg");

const scale = [60, 62, 64, 65, 67, 69, 71, 72, 72, 71, 69, 67, 65, 64, 62, 60];

// Staff geometry (must match what the detector reconstructs from pixels).
const SPACING = 12; // px between adjacent staff lines
const Y_BOTTOM = 120; // y of the bottom line (E4)
const halfSlot = SPACING / 2;
const START_X = 44;
const STEP_X = 36;
const WIDTH = START_X + scale.length * STEP_X + 20;
const HEIGHT = 170;

const LETTERS = "CDEFGAB";
const SEMITONE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

// MIDI -> diatonic slot relative to bottom line E4 (slot 0).
function midiToSlot(midi) {
  const pc = ((midi % 12) + 12) % 12;
  const letter = Object.keys(SEMITONE).find((k) => SEMITONE[k] === pc) ?? "C";
  const octave = Math.floor(midi / 12) - 1;
  const diatonicAbs = octave * 7 + LETTERS.indexOf(letter);
  return diatonicAbs - 30; // E4 diatonicAbs = 30
}

const lines = [0, 1, 2, 3, 4].map((i) => Y_BOTTOM - i * SPACING); // E4..F5

const noteEls = scale
  .map((midi, i) => {
    const x = START_X + i * STEP_X;
    const y = Y_BOTTOM - midiToSlot(midi) * halfSlot;
    return `  <ellipse cx="${x}" cy="${y}" rx="6" ry="4.5" fill="#000000" />`;
  })
  .join("\n");

const lineEls = lines
  .map(
    (y) =>
      `  <line x1="8" y1="${y}" x2="${WIDTH - 8}" y2="${y}" stroke="#000000" stroke-width="1.6" />`
  )
  .join("\n");

const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <rect width="${WIDTH}" height="${HEIGHT}" fill="#ffffff" />
${lineEls}
${noteEls}
</svg>
`;

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, svg);
console.log(`Wrote ${outPath} (${scale.length} noteheads, ${WIDTH}x${HEIGHT}).`);
