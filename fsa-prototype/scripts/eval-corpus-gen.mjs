// SLOW step: generate the stratified deviation corpus and cache basic-pitch
// tensors for each clip. Re-run when corpus-common.mjs changes.
//
//   node --experimental-strip-types scripts/eval-corpus-gen.mjs
//
// Grid: {base} × {variant} × {SNR}. clean/errors cover the full SNR sweep (the
// two headline curves); stopped-early/transpose are probed at a clean and a
// noisy point. Day-to-day analysis uses the fast `eval-corpus.mjs` on the cache.

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { SR, ROOT, estimateSnrDb } from "./eval-common.mjs";
import {
  BASES, VARIANTS, BPM, injectErrors, synthRich, addNoise, highPass, normalizePeak,
} from "./corpus-common.mjs";

const CORPUS_DIR = resolve(ROOT, "eval", "corpus");
const SNR_FULL = [40, 22, 14, 8];     // clean / errors → full sweep
const SNR_PROBE = [40, 14];           // stopped-early / transpose → 2 points
const force = process.env.EVAL_FORCE === "1";

// ---- model server + CNN (same shape as eval-capture.mjs) --------------------
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
async function runCnn(bp, samples) {
  const frames = [], onsets = [], contours = [];
  await bp.evaluateModel(makeAudioBuffer(samples), (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); }, () => {});
  return { frames, onsets, contours };
}
const round = (m) => m.map((row) => row.map((v) => Math.round(v * 1e4) / 1e4));

// ---- build the job list -----------------------------------------------------
const jobs = [];
for (const base of Object.keys(BASES)) {
  for (const variant of VARIANTS) {
    const snrs = (variant === "clean" || variant === "errors") ? SNR_FULL : SNR_PROBE;
    for (const snr of snrs) jobs.push({ base, variant, snr });
  }
}

mkdirSync(CORPUS_DIR, { recursive: true });
const pending = force ? jobs : jobs.filter((j) => !existsSync(resolve(CORPUS_DIR, `${j.base}__${j.variant}__snr${j.snr}.json`)));
if (pending.length === 0) {
  console.log(`All ${jobs.length} corpus clips already generated (EVAL_FORCE=1 to redo).`);
  process.exit(0);
}

const { server, url } = await startModelServer();
const { BasicPitch } = await import("@spotify/basic-pitch");
const bp = new BasicPitch(url);
console.log(`generating ${pending.length}/${jobs.length} clips → eval/corpus/\n`);
try {
  for (const job of pending) {
    const t0 = Date.now();
    const ref = BASES[job.base]();
    const seedStr = `${job.base}|${job.variant}|${job.snr}`;
    const { perfEvents, labels } = injectErrors(ref, job.variant, seedStr);

    let samples = synthRich(perfEvents);
    samples = addNoise(samples, job.snr, seedStr);
    // A mild high-pass on the noisier clips simulates a cheap mic; keeps the
    // corpus from being unrealistically full-band.
    if (job.snr <= 14) samples = highPass(samples, 180);
    samples = normalizePeak(samples);

    const snrDb = estimateSnrDb(samples);
    const { frames, onsets, contours } = await runCnn(bp, samples);

    writeFileSync(
      resolve(CORPUS_DIR, `${job.base}__${job.variant}__snr${job.snr}.json`),
      JSON.stringify({
        meta: job, bpm: BPM, snrDb, ref, labels,
        frames: round(frames), onsets: round(onsets), contours: round(contours),
      })
    );
    console.log(`✓ ${job.base}__${job.variant}__snr${job.snr}`.padEnd(40) +
      ` notes=${ref.length} measSNR=${snrDb.toFixed(1)}dB frames=${frames.length} (${Date.now() - t0}ms)`);
  }
} finally {
  server.close();
}
console.log(`\nDone → eval/corpus/. Analyze: node --experimental-strip-types scripts/eval-corpus.mjs`);
