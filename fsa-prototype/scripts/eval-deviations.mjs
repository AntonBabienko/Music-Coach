// DEVIATION eval: the captures used by `npm run eval` have played===ref===score
// (a faithful performance), so they measure how well we RECOVER the score, not
// how well we CATCH a student's mistakes. This script closes that gap.
//
//   node --experimental-strip-types scripts/eval-deviations.mjs
//
// It builds a clean reference melody, injects a known set of errors
// (missed / wrong-pitch / extra notes), synthesizes the resulting performance to
// audio, runs the basic-pitch CNN on it, then grades that audio with BOTH the
// note-sequence compare() and the posteriorgram scoreInformedCompare(). Because
// the ground-truth label of every reference note is known, it reports the actual
// coaching quality: did we catch each injected mistake, and how often did we
// falsely accuse a correctly-played note?

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";

import { SR, ROOT, synth, normalizePeak, estimateSnrDb, decodeNotes, defaultParams } from "./eval-common.mjs";
import { compare, cleanPhantomSteps } from "../lib/compare.ts";
import { quantizeNotes, filterShortNotes } from "../lib/quantize.ts";
import { scoreInformedCompare } from "../lib/scoreInformed.ts";

// ---- 1. clean reference melody ---------------------------------------------
const BPM = 120;
const Q = 60 / BPM; // quarter-note seconds
// Four octaves of a C-major scale, up then down (~57 notes) — wide pitch range,
// fully monophonic so every detected event attributes to exactly one ref note.
const DEGREES = [0, 2, 4, 5, 7, 9, 11];
const up = [];
for (let oct = 3; oct <= 6; oct++) for (const d of DEGREES) up.push(12 * (oct + 1) + d); // C3..B6
up.push(96); // top C7
const SCALE = [...up, ...up.slice(0, -1).reverse()];

const refNotes = SCALE.map((midi, i) => ({
  midi,
  onsetSec: i * Q,
  durationSec: Q * 0.9,
  measure: Math.floor(i / 4) + 1,
}));

// ---- 2. inject known errors ------------------------------------------------
// Deterministic so the run is reproducible. Labels: "missed" (not played),
// "wrong" (played a different pitch), else "ok".
const trueLabel = refNotes.map(() => "ok");
const wrongTo = new Array(refNotes.length).fill(null);
for (let i = 0; i < refNotes.length; i++) {
  if (i % 7 === 3) trueLabel[i] = "missed";
  else if (i % 5 === 2) { trueLabel[i] = "wrong"; wrongTo[i] = refNotes[i].midi + 3; } // up a minor third
}
// Extra notes the score never asked for: a few foreign pitches between onsets.
const EXTRA_TIMES = [5.25, 11.75, 18.25, 24.75];
const EXTRA_PITCHES = [61, 66, 70, 63];
const injectedMissed = trueLabel.filter((l) => l === "missed").length;
const injectedWrong = trueLabel.filter((l) => l === "wrong").length;
const injectedExtra = EXTRA_TIMES.length;

// Performance event list that actually gets synthesized.
const perfEvents = [];
for (let i = 0; i < refNotes.length; i++) {
  if (trueLabel[i] === "missed") continue;
  const midi = trueLabel[i] === "wrong" ? wrongTo[i] : refNotes[i].midi;
  perfEvents.push({ midi, time: refNotes[i].onsetSec, dur: refNotes[i].durationSec });
}
for (let e = 0; e < EXTRA_TIMES.length; e++) {
  perfEvents.push({ midi: EXTRA_PITCHES[e], time: EXTRA_TIMES[e], dur: Q * 0.6 });
}
perfEvents.sort((a, b) => a.time - b.time);

// ---- 3. synthesize to audio (+ light room noise) ---------------------------
let samples = synth(perfEvents);
// Add white noise at ~ -28 dB so the clip is not pathologically clean. Seeded
// PRNG (mulberry32) so the fixture — and therefore the scores — are reproducible.
let seed = 0x9e3779b9;
const rand = () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const noiseAmp = 0.04;
for (let i = 0; i < samples.length; i++) samples[i] += (rand() * 2 - 1) * noiseAmp;
samples = normalizePeak(samples);
const snrDb = estimateSnrDb(samples);

// ---- 4. run the CNN --------------------------------------------------------
function makeAudioBuffer(s) {
  return { numberOfChannels: 1, length: s.length, sampleRate: SR, duration: s.length / SR, getChannelData: () => s };
}
async function startModelServer() {
  const server = createServer((req, res) => {
    try {
      const p = resolve(ROOT, "public", decodeURIComponent(req.url.replace(/^\//, "")));
      const data = readFileSync(p);
      res.writeHead(200, { "Content-Type": req.url.endsWith(".json") ? "application/json" : "application/octet-stream", "Connection": "close" });
      res.end(data);
    } catch { res.writeHead(404); res.end("not found"); }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/basic-pitch-model/model.json` };
}

const { server, url } = await startModelServer();
const { BasicPitch } = await import("@spotify/basic-pitch");
const bp = new BasicPitch(url);
const frames = [], onsets = [], contours = [];
await bp.evaluateModel(makeAudioBuffer(samples), (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); }, () => {});
server.close();

// ---- 5. grade with both methods -------------------------------------------
const capture = { frames, onsets, contours, snrDb, bpm: BPM };
const params = defaultParams(capture);
const transcribed = await decodeNotes(capture, params);
const perf = quantizeNotes(filterShortNotes(transcribed, 50, BPM), BPM);
const cmpPlain = cleanPhantomSteps(compare(refNotes, perf));
const cmpSI = scoreInformedCompare(refNotes, frames, onsets);

// ---- 6. score error-detection quality --------------------------------------
// Map each reference note to its predicted label from a method's steps.
function predictedLabels(cmp) {
  const pred = refNotes.map(() => "ok"); // ref notes with a "match" step stay ok
  let extra = 0;
  for (const s of cmp.steps) {
    if (s.type === "extra") { extra++; continue; }
    if (s.refIndex == null) continue;
    if (s.type === "missed") pred[s.refIndex] = "missed";
    else if (s.type === "wrong") pred[s.refIndex] = "wrong";
    // "match" leaves it "ok"
  }
  return { pred, extra };
}

function scoreMethod(cmp) {
  const { pred, extra } = predictedLabels(cmp);
  let missedTP = 0, wrongTP = 0, falseMissed = 0, falseWrong = 0;
  for (let i = 0; i < refNotes.length; i++) {
    const t = trueLabel[i], p = pred[i];
    if (t === "missed" && p === "missed") missedTP++;
    if (t === "wrong" && (p === "wrong" || p === "missed")) wrongTP++; // a wrong note caught as wrong OR flagged missed both alert the student
    if (t === "ok" && p === "missed") falseMissed++;
    if (t === "ok" && p === "wrong") falseWrong++;
  }
  return { missedTP, wrongTP, falseMissed, falseWrong, extra };
}

const A = scoreMethod(cmpPlain);
const B = scoreMethod(cmpSI);

const pctOf = (x, n) => n ? `${((x / n) * 100).toFixed(0)}%` : "—";
console.log(`\nDeviation fixture: ${refNotes.length} ref notes, injected ${injectedMissed} missed / ${injectedWrong} wrong / ${injectedExtra} extra. SNR ${snrDb.toFixed(1)}dB.\n`);
console.log("metric                         plain compare      score-informed");
console.log("─".repeat(64));
const row = (label, a, b) => console.log(`${label.padEnd(28)} ${String(a).padStart(14)} ${String(b).padStart(18)}`);
row("missed caught", `${A.missedTP}/${injectedMissed} (${pctOf(A.missedTP, injectedMissed)})`, `${B.missedTP}/${injectedMissed} (${pctOf(B.missedTP, injectedMissed)})`);
row("wrong caught", `${A.wrongTP}/${injectedWrong} (${pctOf(A.wrongTP, injectedWrong)})`, `${B.wrongTP}/${injectedWrong} (${pctOf(B.wrongTP, injectedWrong)})`);
row("extra detected", `${A.extra} (inj ${injectedExtra})`, `${B.extra} (inj ${injectedExtra})`);
console.log("─".repeat(64) + "  (false positives — accusing a correctly-played note)");
row("false 'missed' (ok→missed)", A.falseMissed, B.falseMissed);
row("false 'wrong' (ok→wrong)", A.falseWrong, B.falseWrong);
console.log();
