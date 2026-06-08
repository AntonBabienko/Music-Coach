// SLOW step (~10s/clip): run the basic-pitch CNN once per fixture and cache the
// raw frames/onsets/contours tensors to eval/captures/. Re-run when the audio
// corpus changes; day-to-day tuning uses the fast `npm run eval`.
//
//   node --experimental-strip-types scripts/eval-capture.mjs
//
// The corpus is whatever lives in eval/fixtures/ as `<name>.musicxml` +
// `<name>.<audio>` pairs (mp3/wav/m4a/ogg/flac) — drop files in, no code change.
// Seed a starter corpus from the demo assets with `npm run eval:seed`.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "node:http";
import {
  SR, ROOT, CAPTURE_DIR, discoverFixtures, decodeAudioFile, loadScore,
  estimateSnrDb, writeCapture,
} from "./eval-common.mjs";

// Skip fixtures already captured unless EVAL_FORCE=1 (the CNN is the slow part).
const force = process.env.EVAL_FORCE === "1";

function makeAudioBuffer(samples) {
  return {
    numberOfChannels: 1,
    length: samples.length,
    sampleRate: SR,
    duration: samples.length / SR,
    getChannelData: () => samples,
  };
}

async function startModelServer() {
  const server = createServer((req, res) => {
    try {
      const p = resolve(ROOT, "public", decodeURIComponent(req.url.replace(/^\//, "")));
      const data = readFileSync(p);
      res.writeHead(200, {
        "Content-Type": req.url.endsWith(".json") ? "application/json" : "application/octet-stream",
        "Connection": "close", // avoid keep-alive socket reuse → ECONNRESET
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}/basic-pitch-model/model.json` };
}

async function runCnn(bp, samples) {
  const frames = [], onsets = [], contours = [];
  await bp.evaluateModel(
    makeAudioBuffer(samples),
    (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
    () => {}
  );
  return { frames, onsets, contours };
}

// ---- main -------------------------------------------------------------------

const all = discoverFixtures();
if (all.length === 0) {
  console.error("No fixtures in eval/fixtures/. Seed some with:  npm run eval:seed");
  console.error("Or drop in <name>.musicxml + <name>.{mp3,wav,m4a,ogg} pairs.");
  process.exit(1);
}
const fixtures = force
  ? all
  : all.filter((f) => !existsSync(resolve(CAPTURE_DIR, `${f.name}.json`)));
const skipped = all.length - fixtures.length;
if (fixtures.length === 0) {
  console.log(`All ${all.length} fixtures already captured (EVAL_FORCE=1 to redo).`);
  process.exit(0);
}

const { server, url } = await startModelServer();
console.log(`model server: ${url}`);
console.log(`capturing: ${fixtures.map((f) => f.name).join(", ")}${skipped ? `  (skipped ${skipped} already cached)` : ""}\n`);

const { BasicPitch } = await import("@spotify/basic-pitch");
const bp = new BasicPitch(url); // load the model once, reuse across fixtures
try {
  for (const fx of fixtures) {
    const t0 = Date.now();
    let samples, score;
    try {
      samples = await decodeAudioFile(fx.audioPath);
      score = loadScore(fx.xmlPath);
    } catch (e) {
      console.log(`✗ ${fx.name.padEnd(16)} skipped: ${e.message}`);
      continue;
    }
    const snrDb = estimateSnrDb(samples);
    const { frames, onsets, contours } = await runCnn(bp, samples);
    writeCapture(fx.name, {
      sampleRate: SR, bpm: score.bpm, snrDb,
      // Ground truth = the score; for a faithful performance this is what the
      // audio should contain. (Add a richer per-note truth later if needed.)
      played: score.notes, ref: score.notes,
      frames, onsets, contours,
    });
    console.log(
      `✓ ${fx.name.padEnd(16)} ${(samples.length / SR).toFixed(1)}s ` +
      `bpm=${score.bpm} notes=${score.notes.length} SNR=${snrDb.toFixed(1)}dB ` +
      `frames=${frames.length} (${Date.now() - t0}ms)`
    );
  }
} finally {
  server.close();
}
console.log(`\nCaptured → eval/captures/. Run: npm run eval`);
