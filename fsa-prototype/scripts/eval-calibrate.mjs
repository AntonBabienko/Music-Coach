// Calibration: compare a score (MusicXML) against the transcription of its OWN
// etalon recording (mp3). Because polyphonic audio transcription can never hit
// 100%, this run is the *ceiling* — the best the pipeline can do on a faithful
// performance. Student scores are then read relative to this ceiling, not 100%
// (mirrors the app's "Save as baseline" calibration in lib/calibrate.ts).
//
//   npm run eval:calibrate            # default: a fixture whose name has "jesus"
//   npm run eval:calibrate -- <name>  # calibrate against a specific fixture

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CAPTURE_DIR, readCapture, runPipeline, pct } from "./eval-common.mjs";
import { readdirSync } from "node:fs";

const arg = process.argv.slice(2).find((a) => !a.startsWith("-"));
const names = readdirSync(CAPTURE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
const name = arg
  ? names.find((n) => n === arg)
  : names.find((n) => /jesus/i.test(n)) ?? names[0];

if (!name) {
  console.error(`No capture found${arg ? ` for "${arg}"` : ""}. Run: npm run eval:capture`);
  process.exit(1);
}

const cap = readCapture(name);
const { params, transcribed, perf, scoreMatch, cmp } = await runPipeline(cap);

console.log(`Calibration — ${name}  (score MusicXML  ↔  etalon recording)\n`);
console.log(`thresholds (SNR ${cap.snrDb.toFixed(1)}dB → adaptive): onset=${params.onsetThreshold} frame=${params.frameThreshold} vel=${params.velocityThreshold}`);
console.log(`score notes: ${cmp.refCount}   transcribed (raw→quantized): ${transcribed.length}→${perf.length}\n`);

console.log("Alignment vs score:");
console.log(`  match ${cmp.counts.match}   wrong ${cmp.counts.wrong}   missed ${cmp.counts.missed}   extra ${cmp.counts.extra}   (late ${cmp.counts.late} / early ${cmp.counts.early})`);
console.log("");
console.log("Accuracy (this is the CEILING — etalon, not a student):");
console.log(`  pitch    ${pct(cmp.pitchAccuracy / 100)}   (matched pitch / score notes)`);
console.log(`  coverage ${pct(cmp.coverageAccuracy / 100)}   (any alignment / score notes)`);
console.log(`  on-time  ${pct(cmp.onTimeAccuracy / 100)}   (matched AND ≤150ms)`);
console.log(`  tempo a  ${cmp.tempoRatio.toFixed(3)}  (R²=${cmp.timingR2.toFixed(2)}, resid=${cmp.timingResidualRatio.toFixed(2)}×)`);
console.log("");
console.log(`Transcription quality (tempo-invariant): precision ${pct(scoreMatch.precision)} / recall ${pct(scoreMatch.recall)} / F1 ${pct(scoreMatch.f1)}  (${scoreMatch.extra} extra detections)`);

// Persist the ceiling so the app / further evals can normalize against it.
const calibration = {
  fixture: name,
  capturedAt: new Date().toISOString(),
  pitchCeiling: +cmp.pitchAccuracy.toFixed(1),
  coverageCeiling: +cmp.coverageAccuracy.toFixed(1),
  onTimeCeiling: +cmp.onTimeAccuracy.toFixed(1),
  thresholds: params,
};
const outPath = resolve(CAPTURE_DIR, "..", "calibration.json");
writeFileSync(outPath, JSON.stringify(calibration, null, 2) + "\n");
console.log(`\nSaved ceiling → eval/calibration.json`);
console.log(`Interpretation: this etalon caps at pitch ${cmp.pitchAccuracy.toFixed(0)}% — a student is graded ` +
  `relative to that ceiling (normalizeAgainstBaseline), not to a fictional 100%.`);
