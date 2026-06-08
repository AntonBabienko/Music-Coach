// FAST step: grade the cached corpus with BOTH methods and print the two curves
// that define a trustworthy coach — false-accusation rate and error-detection
// recall, as functions of SNR — plus the stopped-early and transpose stress
// cases. Re-run freely after tuning lib/scoreInformed.ts.
//
//   node --experimental-strip-types scripts/eval-corpus.mjs
//   node --experimental-strip-types scripts/eval-corpus.mjs onsetThreshold=0.35

import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, decodeNotes, defaultParams } from "./eval-common.mjs";
import { compare, cleanPhantomSteps } from "../lib/compare.ts";
import { quantizeNotes, filterShortNotes } from "../lib/quantize.ts";
import { scoreInformedCompare } from "../lib/scoreInformed.ts";

const CORPUS_DIR = resolve(ROOT, "eval", "corpus");

const overrides = {};
for (const a of process.argv.slice(2)) {
  const m = a.match(/^(\w+)=([\d.]+)$/);
  if (m) overrides[m[1]] = parseFloat(m[2]);
}

let names;
try { names = readdirSync(CORPUS_DIR).filter((f) => f.endsWith(".json")); }
catch { console.error("No corpus. Run: node --experimental-strip-types scripts/eval-corpus-gen.mjs"); process.exit(1); }
if (names.length === 0) { console.error("Empty corpus. Run eval-corpus-gen.mjs first."); process.exit(1); }

// ---- predicted label per reference note ------------------------------------
function predict(cmp) {
  const pred = new Map();
  let extra = 0;
  for (const s of cmp.steps) {
    if (s.type === "extra") { extra++; continue; }
    if (s.refIndex == null) continue;
    if (s.type === "missed") pred.set(s.refIndex, "missed");
    else if (s.type === "wrong") pred.set(s.refIndex, "wrong");
    else pred.set(s.refIndex, "ok");
  }
  return { pred, extra };
}

function scoreClip(cmp, labels) {
  const { pred, extra } = predict(cmp);
  const t = labels.trueLabel;
  const s = {
    ok: 0, falseAcc: 0,
    missedInj: 0, missedCaught: 0,
    wrongInj: 0, wrongCaught: 0,
    extraInj: labels.extra.length, extraDet: extra,
    na: 0, naFlaggedErr: 0,
  };
  for (let i = 0; i < t.length; i++) {
    const p = pred.get(i) ?? "ok"; // a ref note with no step = treated as ok
    if (t[i] === "ok") { s.ok++; if (p === "missed" || p === "wrong") s.falseAcc++; }
    else if (t[i] === "missed") { s.missedInj++; if (p === "missed") s.missedCaught++; }
    else if (t[i] === "wrong") { s.wrongInj++; if (p === "wrong" || p === "missed") s.wrongCaught++; }
    else if (t[i] === "not-attempted") { s.na++; if (p === "missed" || p === "wrong") s.naFlaggedErr++; }
  }
  return s;
}

async function gradeBoth(clip) {
  const { ref, frames, onsets, contours, snrDb, bpm } = clip;
  const params = defaultParams({ snrDb, bpm }, overrides);
  // plain note-sequence compare path
  const perfRaw = await decodeNotes({ frames, onsets, contours }, params);
  const perf = quantizeNotes(filterShortNotes(perfRaw, 50, bpm), bpm);
  const plain = cleanPhantomSteps(compare(ref, perf));
  // posteriorgram score-informed path
  const si = scoreInformedCompare(ref, frames, onsets, {
    onsetThreshold: overrides.onsetThreshold,
    frameThreshold: overrides.frameThreshold,
    extraThreshold: overrides.extraThreshold,
  });
  return {
    plain: scoreClip(plain, clip.labels),
    si: scoreClip(si, clip.labels),
    siOffScore: !!si.offScore,
    siConf: si.alignmentConfidence ?? 0,
  };
}

// ---- aggregate --------------------------------------------------------------
// buckets[variant][snr] = { plain:[clipStats...], si:[...] }
const buckets = {};
for (const name of names.sort()) {
  const clip = JSON.parse(readFileSync(resolve(CORPUS_DIR, name), "utf-8"));
  const { variant, snr } = clip.meta;
  const res = await gradeBoth(clip);
  if (process.env.CONF_DEBUG) console.error(`[conf] ${name.replace(/\.json$/, "").padEnd(34)} conf=${res.siConf.toFixed(2)} off=${res.siOffScore}`);
  ((buckets[variant] ??= {})[snr] ??= { plain: [], si: [], off: [], conf: [] });
  buckets[variant][snr].plain.push(res.plain);
  buckets[variant][snr].si.push(res.si);
  buckets[variant][snr].off.push(res.siOffScore);
  buckets[variant][snr].conf.push(res.siConf);
}

const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const rate = (num, den) => (den ? (num / den) * 100 : 0);
const fmtPct = (x) => `${x.toFixed(0)}%`;

function aggFA(list) { return rate(sum(list, (s) => s.falseAcc), sum(list, (s) => s.ok)); }
function aggRecall(list) {
  const caught = sum(list, (s) => s.missedCaught + s.wrongCaught);
  const inj = sum(list, (s) => s.missedInj + s.wrongInj);
  return rate(caught, inj);
}
function aggExtra(list) { return { det: sum(list, (s) => s.extraDet), inj: sum(list, (s) => s.extraInj) }; }

// ---- report -----------------------------------------------------------------
if (Object.keys(overrides).length) console.log("overrides:", overrides, "\n");

console.log("CURVE 1 — false-accusation rate (clean performances; lower is better, goal ≈0)");
console.log("  SNR      plain      score-informed");
for (const snr of Object.keys(buckets.clean ?? {}).map(Number).sort((a, b) => b - a)) {
  const b = buckets.clean[snr];
  console.log(`  ${String(snr).padStart(3)}dB   ${fmtPct(aggFA(b.plain)).padStart(6)}     ${fmtPct(aggFA(b.si)).padStart(6)}`);
}

console.log("\nCURVE 2 — error-detection recall (performances with injected mistakes; higher is better)");
console.log("  SNR      plain      score-informed     | also false-acc on the OK notes");
for (const snr of Object.keys(buckets.errors ?? {}).map(Number).sort((a, b) => b - a)) {
  const b = buckets.errors[snr];
  console.log(
    `  ${String(snr).padStart(3)}dB   ${fmtPct(aggRecall(b.plain)).padStart(6)}     ${fmtPct(aggRecall(b.si)).padStart(6)}` +
    `          | plain ${fmtPct(aggFA(b.plain)).padStart(5)}  SI ${fmtPct(aggFA(b.si)).padStart(5)}`
  );
}
{
  const allP = Object.values(buckets.errors ?? {}).flatMap((b) => b.plain);
  const allS = Object.values(buckets.errors ?? {}).flatMap((b) => b.si);
  const ep = aggExtra(allP), es = aggExtra(allS);
  console.log(`  extra notes detected:  plain ${ep.det}/${ep.inj}   score-informed ${es.det}/${es.inj}`);
}

console.log("\nSTRESS — stopped-early (user quit at 60%): tail must NOT be blamed as mistakes");
for (const snr of Object.keys(buckets["stopped-early"] ?? {}).map(Number).sort((a, b) => b - a)) {
  const b = buckets["stopped-early"][snr];
  const phantom = (list) => rate(sum(list, (s) => s.naFlaggedErr), sum(list, (s) => s.na));
  const faPlayed = (list) => fmtPct(aggFA(list));
  console.log(
    `  ${String(snr).padStart(3)}dB   unplayed-tail flagged as mistake:  plain ${fmtPct(phantom(b.plain)).padStart(5)}  SI ${fmtPct(phantom(b.si)).padStart(5)}` +
    `   | FA on played part: plain ${faPlayed(b.plain)} SI ${faPlayed(b.si)}`
  );
}

console.log("\nSTRESS — transpose (+2, valid re-keying): must read as OK, not all-wrong");
for (const snr of Object.keys(buckets.transpose ?? {}).map(Number).sort((a, b) => b - a)) {
  const b = buckets.transpose[snr];
  console.log(`  ${String(snr).padStart(3)}dB   notes flagged as mistake:  plain ${fmtPct(aggFA(b.plain)).padStart(5)}  score-informed ${fmtPct(aggFA(b.si)).padStart(5)}`);
}

console.log("\nOFF-SCORE — playing a DIFFERENT piece: SI must flag offScore, not grade note-by-note");
const offFlag = (list) => rate(list.filter(Boolean).length, list.length);
const avgConf = (list) => list.reduce((a, x) => a + x, 0) / (list.length || 1);
for (const snr of Object.keys(buckets["off-score"] ?? {}).map(Number).sort((a, b) => b - a)) {
  const b = buckets["off-score"][snr];
  console.log(`  ${String(snr).padStart(3)}dB   offScore flagged: ${fmtPct(offFlag(b.off)).padStart(5)}   (avg alignmentConfidence ${avgConf(b.conf).toFixed(2)}, want ≈1)`);
}
// False-positive: offScore must NOT fire on real performances of the right piece.
const realVariants = ["clean", "errors", "stopped-early", "transpose"];
const fpList = realVariants.flatMap((v) => Object.values(buckets[v] ?? {}).flatMap((b) => b.off));
const confReal = realVariants.flatMap((v) => Object.values(buckets[v] ?? {}).flatMap((b) => b.conf));
console.log(`  false off-score on real performances: ${fmtPct(offFlag(fpList))}  (avg alignmentConfidence ${avgConf(confReal).toFixed(2)})`);
console.log();
