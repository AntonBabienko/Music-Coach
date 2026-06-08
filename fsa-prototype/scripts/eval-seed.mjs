// Seed eval/fixtures/ with starter (score + recording) pairs from the demo
// assets, so the harness has a corpus out of the box. Add your own bigger
// sample by dropping more `<name>.musicxml` + `<name>.{mp3,wav}` pairs in there.
//
//   node --experimental-strip-types scripts/eval-seed.mjs

import { mkdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, FIXTURE_DIR, SR, synth, normalizePeak, writeWavMono } from "./eval-common.mjs";

mkdirSync(FIXTURE_DIR, { recursive: true });
const pub = (f) => resolve(ROOT, "public", f);
const fx = (f) => resolve(FIXTURE_DIR, f);

// 1. Real, polyphonic: the hymn recording + its score (the realistic case).
if (existsSync(pub("jesus-lives.mp3")) && existsSync(pub("jesus-lives.musicxml"))) {
  copyFileSync(pub("jesus-lives.mp3"), fx("jesus-lives.mp3"));
  copyFileSync(pub("jesus-lives.musicxml"), fx("jesus-lives.musicxml"));
  console.log("✓ seeded jesus-lives (real mp3 + score)");
} else {
  console.log("· skipped jesus-lives (missing public asset)");
}

// 2. Synthetic clean scale matching public/sample.musicxml — a ~100% sanity
//    anchor. Audio is generated; the score is the existing 16-note sample.
if (existsSync(pub("sample.musicxml"))) {
  const quarter = 0.6; // tempo 100
  const scale = [60, 62, 64, 65, 67, 69, 71, 72, 72, 71, 69, 67, 65, 64, 62, 60];
  const events = scale.map((midi, i) => ({ midi, time: i * quarter, dur: 0.54 }));
  for (let i = 0; i < events.length; i++) {
    const next = i + 1 < events.length ? events[i + 1].time : Infinity;
    events[i].dur = Math.max(0.08, Math.min(0.54, next - events[i].time - 0.03));
  }
  writeWavMono(fx("scale-clean.wav"), normalizePeak(synth(events)), SR);
  copyFileSync(pub("sample.musicxml"), fx("scale-clean.musicxml"));
  console.log("✓ seeded scale-clean (synthetic wav + sample score)");
} else {
  console.log("· skipped scale-clean (missing public/sample.musicxml)");
}

console.log(`\nFixtures in ${FIXTURE_DIR}. Next: npm run eval:capture`);
