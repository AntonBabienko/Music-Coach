// Re-derive each capture's ground truth (played/ref) from its fixture MusicXML,
// keeping the cached CNN tensors. Use this when the ground-truth logic changes
// (e.g. now merging all score parts) so you don't pay the slow re-capture.
//
//   node --experimental-strip-types scripts/eval-reground.mjs

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { CAPTURE_DIR, discoverFixtures, loadScore } from "./eval-common.mjs";

const fixtures = new Map(discoverFixtures().map((f) => [f.name, f]));
const captures = readdirSync(CAPTURE_DIR).filter((f) => f.endsWith(".json"));

for (const file of captures) {
  const name = file.replace(/\.json$/, "");
  const fx = fixtures.get(name);
  if (!fx) { console.log(`· ${name}: no fixture, skipped`); continue; }
  const path = resolve(CAPTURE_DIR, file);
  const cap = JSON.parse(readFileSync(path, "utf-8"));
  const before = cap.ref?.length ?? 0;
  const { notes, bpm } = loadScore(fx.xmlPath);
  cap.played = notes;
  cap.ref = notes;
  cap.bpm = bpm;
  writeFileSync(path, JSON.stringify(cap));
  console.log(`✓ ${name}: ground truth ${before} → ${notes.length} notes (bpm ${bpm})`);
}
console.log("\nDone. Re-run: npm run eval");
