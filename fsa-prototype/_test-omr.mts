import { detectScore } from "./lib/omr";

// Mirror the geometry of scripts/gen-score-image.mjs into a raw RGBA bitmap.
const scale = [60, 62, 64, 65, 67, 69, 71, 72, 72, 71, 69, 67, 65, 64, 62, 60];
const SPACING = 12;
const Y_BOTTOM = 120;
const half = SPACING / 2;
const START_X = 44;
const STEP_X = 36;
const WIDTH = START_X + scale.length * STEP_X + 20;
const HEIGHT = 170;

const LETTERS = "CDEFGAB";
const SEM: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function midiToSlot(midi: number) {
  const pc = ((midi % 12) + 12) % 12;
  const letter = Object.keys(SEM).find((k) => SEM[k] === pc)!;
  const octave = Math.floor(midi / 12) - 1;
  return octave * 7 + LETTERS.indexOf(letter) - 30;
}

const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4).fill(255); // white
const setBlack = (x: number, y: number) => {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return;
  const i = (y * WIDTH + x) * 4;
  data[i] = data[i + 1] = data[i + 2] = 0;
  data[i + 3] = 255;
};

// staff lines (2px thick, full width)
for (let k = 0; k < 5; k++) {
  const y = Y_BOTTOM - k * SPACING;
  for (let x = 8; x < WIDTH - 8; x++) {
    setBlack(x, y);
    setBlack(x, y + 1);
  }
}
// noteheads (filled ellipses rx6 ry4.5)
scale.forEach((midi, idx) => {
  const cx = START_X + idx * STEP_X;
  const cy = Y_BOTTOM - midiToSlot(midi) * half;
  for (let dx = -6; dx <= 6; dx++) {
    for (let dy = -5; dy <= 5; dy++) {
      if ((dx * dx) / (6 * 6) + (dy * dy) / (4.5 * 4.5) <= 1) {
        setBlack(Math.round(cx + dx), Math.round(cy + dy));
      }
    }
  }
});

const { notes, musicXml } = detectScore({ data, width: WIDTH, height: HEIGHT });
const got = notes.map((n) => n.midi);
console.log("OMR detected count:", notes.length);
console.log("got     :", got.join(" "));
console.log("expected:", scale.join(" "));
console.log("MATCH:", JSON.stringify(got) === JSON.stringify(scale));
console.log("measures:", notes.map((n) => n.measure).join(" "));
console.log("musicXml ok:", musicXml.includes("<score-partwise") && musicXml.includes("<step>"));
