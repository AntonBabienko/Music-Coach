// FAST step (<1s): score the audio-analysis pipeline against the cached CNN
// tensors and print transcription-fidelity + app-grade metrics. This is the
// tuning loop — change a threshold in lib/, re-run, see the deltas.
//
//   npm run eval                         # score all captures vs golden
//   npm run eval -- onsetThreshold=0.5   # override a param for all captures
//   npm run eval -- --save-golden        # snapshot current scores as the baseline
//
// Exit code is non-zero if any fixture's F1 drops more than REGRESS_TOL below
// golden, so it doubles as a regression gate.

import { readdirSync, writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  CAPTURE_DIR, GOLDEN_PATH, goldenExists,
  readCapture, runPipeline, pct,
} from "./eval-common.mjs";

const REGRESS_TOL = 0.02;

// ---- args -------------------------------------------------------------------
const args = process.argv.slice(2);
const saveGolden = args.includes("--save-golden");
const overrides = {};
for (const a of args) {
  const m = a.match(/^(\w+)=([\d.]+)$/);
  if (m) overrides[m[1]] = parseFloat(m[2]);
}
if (Object.keys(overrides).length) console.log("param overrides:", overrides, "\n");

// ---- load captures ----------------------------------------------------------
let names;
try {
  names = readdirSync(CAPTURE_DIR).filter((f) => f.endsWith(".json")).map((f) => f.replace(/\.json$/, ""));
} catch {
  console.error("No captures found. Run:  npm run eval:capture");
  process.exit(1);
}
if (names.length === 0) {
  console.error("No captures found. Run:  npm run eval:capture");
  process.exit(1);
}

const golden = goldenExists() ? JSON.parse(readFileSync(GOLDEN_PATH, "utf-8")) : null;

// ---- run --------------------------------------------------------------------
const results = {};
const rows = [];
for (const name of names.sort()) {
  const cap = readCapture(name);
  const { scoreMatch: sm, cmp } = await runPipeline(cap, overrides);
  results[name] = {
    f1: +sm.f1.toFixed(4), precision: +sm.precision.toFixed(4), recall: +sm.recall.toFixed(4),
    pitchAccuracy: +cmp.pitchAccuracy.toFixed(1),
  };
  rows.push({ name, sm, cmp });
}

// ---- report -----------------------------------------------------------------
const delta = (name, key, cur) => {
  if (!golden?.[name]) return "";
  const prev = golden[name][key];
  if (prev == null) return "";
  const d = cur - prev;
  if (Math.abs(d) < 1e-9) return " (=)";
  const sign = d > 0 ? "+" : "";
  return ` (${sign}${d.toFixed(3)})`;
};

console.log("fixture          ref  det  match wrong extra  precision   recall       F1            pitchAcc");
console.log("─".repeat(96));
let regressed = false;
for (const { name, sm, cmp } of rows) {
  const f1d = delta(name, "f1", +sm.f1.toFixed(4));
  if (golden?.[name] && +sm.f1.toFixed(4) < golden[name].f1 - REGRESS_TOL) regressed = true;
  console.log(
    `${name.padEnd(15)} ${String(sm.refCount).padStart(4)} ${String(sm.perfCount).padStart(4)}  ` +
    `${String(sm.match).padStart(5)} ${String(sm.wrong).padStart(5)} ${String(sm.extra).padStart(5)}  ` +
    `${pct(sm.precision).padStart(7)}  ${pct(sm.recall).padStart(7)}  ` +
    `${pct(sm.f1).padStart(7)}${f1d.padEnd(11)} ${pct(cmp.pitchAccuracy / 100).padStart(7)}`
  );
}
console.log("─".repeat(96));
const meanF1 = rows.reduce((s, r) => s + r.sm.f1, 0) / rows.length;
const gMeanF1 = golden ? Object.values(golden).reduce((s, g) => s + g.f1, 0) / Object.keys(golden).length : null;
console.log(`mean F1: ${pct(meanF1)}${gMeanF1 != null ? delta("__mean__", "f1", +meanF1.toFixed(4)).replace("__mean__", "") || ` (${(meanF1 - gMeanF1 >= 0 ? "+" : "")}${(meanF1 - gMeanF1).toFixed(3)})` : ""}`);

// ---- golden -----------------------------------------------------------------
if (saveGolden) {
  writeFileSync(GOLDEN_PATH, JSON.stringify(results, null, 2) + "\n");
  console.log(`\nSaved golden baseline → eval/golden.json`);
} else if (!golden) {
  console.log("\nNo golden baseline yet. Save one with:  npm run eval -- --save-golden");
} else if (regressed) {
  console.log(`\n✗ Regression: an F1 dropped >${REGRESS_TOL} below golden.`);
  process.exit(1);
} else {
  console.log("\n✓ No F1 regression vs golden.");
}
