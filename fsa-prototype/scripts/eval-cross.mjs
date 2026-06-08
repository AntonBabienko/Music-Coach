// Cross-comparison matrix: transcribe each fixture's AUDIO, then compare it
// against every fixture's SCORE. The diagonal (audio vs its own score) must
// score high; off-diagonal (audio vs a different piece's score) must score low
// and trip the "score mismatch" signal. This validates that the comparison
// actually discriminates pieces, not just always reports a match.
//
//   node --experimental-strip-types scripts/eval-cross.mjs

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPTURE_DIR, discoverFixtures, readCapture, decodeNotes, defaultParams,
  loadScore, scoreMatchMetrics, pct,
} from "./eval-common.mjs";
import { quantizeNotes, filterShortNotes } from "../lib/quantize.ts";
import { compare, cleanPhantomSteps } from "../lib/compare.ts";

// Mismatch flag mirrors the app (ResultsPanel): a timing residual ratio above
// this means the matched notes don't sit on any tempo line → wrong score.
const MISMATCH_RESID = 2.0;

const fixtures = discoverFixtures().filter((f) => existsSync(resolve(CAPTURE_DIR, `${f.name}.json`)));
if (fixtures.length < 2) {
  console.error("Need ≥2 captured fixtures. Run: npm run eval:capture");
  process.exit(1);
}

// Transcribe each fixture's audio once (from its cached tensors).
const transcription = {};
for (const f of fixtures) {
  const cap = readCapture(f.name);
  transcription[f.name] = { notes: await decodeNotes(cap, defaultParams(cap)) };
}
// Load each fixture's score once.
const score = {};
for (const f of fixtures) score[f.name] = loadScore(f.xmlPath);

const names = fixtures.map((f) => f.name);
const cell = (audio, scoreName) => {
  const sc = score[scoreName];
  const perf = quantizeNotes(filterShortNotes(transcription[audio].notes, 50, sc.bpm), sc.bpm);
  const cmp = cleanPhantomSteps(compare(sc.notes, perf));
  return { pitch: cmp.pitchAccuracy, f1: scoreMatchMetrics(cmp).f1 * 100, resid: cmp.timingResidualRatio };
};

const short = (n) => (n.length > 12 ? n.slice(0, 11) + "…" : n).padEnd(12);

// --- pitch-accuracy matrix (audio rows × score cols) ---
console.log("pitch accuracy — AUDIO (row) compared against SCORE (col)\n");
console.log("audio \\ score ".padEnd(14) + names.map((n) => short(n).slice(0, 12).padStart(13)).join(""));
for (const a of names) {
  let line = short(a);
  for (const s of names) {
    const c = cell(a, s);
    const mark = a === s ? "*" : " ";
    line += `${(c.pitch.toFixed(0) + "%" + mark).padStart(13)}`;
  }
  console.log(line);
}

// --- verdict over every cell: diagonal should MATCH, off-diagonal MISMATCH ---
// A pair reads as "match" when the timing residual fits a tempo line and pitch
// recall is non-trivial (the same gate the app uses to flag a wrong score).
console.log("\nverdict (diagonal should be MATCH, off-diagonal MISMATCH):");
const N = names.length;
let correct = 0;
let diagOk = 0;
for (const a of names) {
  for (const s of names) {
    const c = cell(a, s);
    const isSame = a === s;
    const saysMatch = c.resid <= MISMATCH_RESID && c.pitch >= 50;
    const ok = saysMatch === isSame;
    if (ok) correct++;
    if (isSame && ok) diagOk++;
    const label = isSame ? "vs OWN     " : "vs " + short(s);
    console.log(
      `  ${short(a)} ${label} → ${(saysMatch ? "MATCH" : "MISMATCH").padEnd(8)} ` +
      `(pitch ${c.pitch.toFixed(0).padStart(3)}%, resid ${c.resid.toFixed(2).padStart(6)}×) ${ok ? "✓" : "✗"}`
    );
  }
}
console.log(`\ndiagonal (same piece) correct: ${diagOk}/${N}`);
console.log(`all cells correct:            ${correct}/${N * N}`);
