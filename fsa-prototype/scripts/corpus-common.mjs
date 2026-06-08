// Shared generation logic for the stratified deviation corpus.
//
// The point of the corpus is to measure the two curves that actually matter for
// a coach, as functions of recording quality:
//   1. FALSE-ACCUSATION rate — how often a correctly-played note is flagged as a
//      mistake. Must stay ≈0 even on bad audio (the cardinal sin: losing trust).
//   2. ERROR-DETECTION recall — how many genuinely-wrong notes we catch. Allowed
//      to degrade gracefully as SNR drops (better to say "unsure" than to lie).
//
// Each generated clip carries a per-reference-note ground-truth label, so both
// curves are computable. Generation is fully deterministic (seeded PRNG) so the
// corpus — and every score derived from it — is reproducible.

import { SR } from "./eval-common.mjs";

// ---- deterministic PRNG (mulberry32) ----------------------------------------
export function rng(seedStr) {
  let h = 1779033703 ^ seedStr.length;
  for (let i = 0; i < seedStr.length; i++) {
    h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let seed = h >>> 0;
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---- base scores ------------------------------------------------------------
// Kept deliberately simple (clean monophonic + simple triads) so a detected
// error attributes to exactly one reference note — the corpus measures grading,
// not basic-pitch's polyphonic-transcription ceiling (that is what the real
// fixtures in eval/ already cover).
const BPM = 120;
const Q = 60 / BPM;

function monoMelody() {
  // Two octaves of C-major, mild rhythmic variety.
  const degrees = [0, 2, 4, 5, 7, 9, 11];
  const pitches = [];
  for (let oct = 4; oct <= 5; oct++) for (const d of degrees) pitches.push(12 * (oct + 1) + d);
  pitches.push(84);
  const both = [...pitches, ...pitches.slice(0, -1).reverse()];
  let t = 0;
  return both.map((midi, i) => {
    const dur = (i % 4 === 3 ? 2 : 1) * Q; // every 4th note a half-note
    const n = { midi, onsetSec: t, durationSec: dur * 0.92, measure: Math.floor(t / (4 * Q)) + 1 };
    t += dur;
    return n;
  });
}

function triadProgression() {
  // I–V–vi–IV in C, three voices per chord, two bars each.
  const chords = [[60, 64, 67], [67, 71, 74], [69, 72, 76], [65, 69, 72]];
  const notes = [];
  let t = 0;
  for (let rep = 0; rep < 3; rep++) {
    for (const ch of chords) {
      for (const midi of ch) notes.push({ midi, onsetSec: t, durationSec: 2 * Q * 0.95, measure: Math.floor(t / (4 * Q)) + 1 });
      t += 2 * Q;
    }
  }
  return notes.sort((a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi);
}

export const BASES = {
  "mono-melody": monoMelody,
  "triads": triadProgression,
};

// ---- error injection --------------------------------------------------------
// Returns { perfEvents, labels } where labels.trueLabel[i] ∈
// {"ok","missed","wrong","not-attempted"} per reference note, plus extra/transpose
// metadata. perfEvents is the note list actually synthesized.

function refToEvent(n, midiOverride) {
  return { midi: midiOverride ?? n.midi, time: n.onsetSec, dur: n.durationSec, vel: 0.8 };
}

export function injectErrors(ref, variant, seedStr) {
  const r = rng(seedStr);
  const trueLabel = ref.map(() => "ok");
  const wrongTo = ref.map(() => null);
  let globalTranspose = 0;
  const perfEvents = [];
  const extra = [];

  const pick = (frac) => r() < frac;

  if (variant === "off-score") {
    // The player performs a COMPLETELY DIFFERENT piece — a seeded chromatic-ish
    // walk in a foreign register/rhythm, unrelated to the score. No reference
    // note is "ok": the whole take should be flagged off-score, not graded.
    let t = 0, midi = 50 + Math.floor(r() * 6);
    const span = ref[ref.length - 1].onsetSec + ref[ref.length - 1].durationSec;
    while (t < span) {
      midi += [-3, -1, 1, 2, 4, 7][Math.floor(r() * 6)]; // foreign intervals
      if (midi < 45) midi += 12; if (midi > 84) midi -= 12;
      const dur = (0.5 + r()) * Q;
      perfEvents.push({ midi, time: t, dur: dur * 0.9, vel: 0.8 });
      t += dur;
    }
    for (let i = 0; i < ref.length; i++) trueLabel[i] = "off-score";
    perfEvents.sort((a, b) => a.time - b.time || a.midi - b.midi);
    return { perfEvents, labels: { trueLabel, wrongTo, extra, globalTranspose, offScore: true } };
  }

  if (variant === "transpose") {
    globalTranspose = 2; // whole step up — a valid re-keying, every note still "ok"
    for (const n of ref) perfEvents.push(refToEvent(n, n.midi + globalTranspose));
  } else if (variant === "stopped-early") {
    const cutoff = Math.floor(ref.length * 0.6);
    for (let i = 0; i < ref.length; i++) {
      if (i < cutoff) perfEvents.push(refToEvent(ref[i]));
      else trueLabel[i] = "not-attempted";
    }
  } else if (variant === "clean") {
    for (const n of ref) perfEvents.push(refToEvent(n));
  } else if (variant === "errors") {
    // Mixed realistic slip set: ~12% missed, ~12% wrong, a few extras.
    for (let i = 0; i < ref.length; i++) {
      if (pick(0.12)) { trueLabel[i] = "missed"; continue; }
      if (pick(0.14)) {
        const semis = (r() < 0.5 ? 1 : 2) * (r() < 0.5 ? -1 : 1);
        trueLabel[i] = "wrong"; wrongTo[i] = ref[i].midi + semis;
        perfEvents.push(refToEvent(ref[i], wrongTo[i]));
        continue;
      }
      perfEvents.push(refToEvent(ref[i]));
    }
    const nExtra = Math.max(2, Math.round(ref.length * 0.06));
    const span = ref[ref.length - 1].onsetSec;
    for (let e = 0; e < nExtra; e++) {
      const time = r() * span;
      const midi = 55 + Math.floor(r() * 24);
      extra.push({ time, midi });
      perfEvents.push({ midi, time, dur: Q * 0.6, vel: 0.7 });
    }
  } else {
    throw new Error(`unknown variant: ${variant}`);
  }

  perfEvents.sort((a, b) => a.time - b.time || a.midi - b.midi);
  return { perfEvents, labels: { trueLabel, wrongTo, extra, globalTranspose } };
}

export const VARIANTS = ["clean", "errors", "stopped-early", "transpose", "off-score"];

// ---- synthesis (additive harmonics) -----------------------------------------
// Richer than a bare sine so basic-pitch sees instrument-like partials; sums
// naturally for chords.
export function synthRich(events, sr = SR) {
  const end = events.reduce((m, e) => Math.max(m, e.time + e.dur), 0) + 0.3;
  const buf = new Float32Array(Math.ceil(end * sr));
  const harmonics = [[1, 1.0], [2, 0.45], [3, 0.22], [4, 0.10]];
  for (const e of events) {
    const f0 = 440 * 2 ** ((e.midi - 69) / 12);
    const start = Math.floor(e.time * sr);
    const len = Math.floor(e.dur * sr);
    const atk = Math.max(1, Math.floor(0.008 * sr));
    const rel = Math.max(1, Math.floor(0.07 * sr));
    const vel = e.vel ?? 0.8;
    for (let n = 0; n < len; n++) {
      let amp = vel;
      if (n < atk) amp *= n / atk;
      else if (n > len - rel) amp *= Math.max(0, (len - n) / rel);
      amp *= Math.exp(-1.2 * n / sr); // gentle decay
      let s = 0;
      const ph = (2 * Math.PI * f0 * n) / sr;
      for (const [h, hw] of harmonics) s += hw * Math.sin(ph * h);
      buf[start + n] += amp * s;
    }
  }
  return buf;
}

// ---- degradation ------------------------------------------------------------
function rmsOf(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / samples.length);
}

/** Add white noise targeting a nominal SNR (dB), seeded for reproducibility. */
export function addNoise(samples, snrDb, seedStr) {
  const r = rng(seedStr + ":noise");
  const sig = rmsOf(samples) || 1e-6;
  const noiseRms = sig / 10 ** (snrDb / 20);
  // uniform noise has RMS = amp/√3, so amp = noiseRms*√3
  const amp = noiseRms * Math.sqrt(3);
  const out = samples.slice();
  for (let i = 0; i < out.length; i++) out[i] += (r() * 2 - 1) * amp;
  return out;
}

/** One-pole high-pass — simulates a phone/dictaphone low-frequency roll-off. */
export function highPass(samples, fc = 200, sr = SR) {
  const dt = 1 / sr;
  const rc = 1 / (2 * Math.PI * fc);
  const a = rc / (rc + dt);
  const out = new Float32Array(samples.length);
  let prevIn = 0, prevOut = 0;
  for (let i = 0; i < samples.length; i++) {
    out[i] = a * (prevOut + samples[i] - prevIn);
    prevIn = samples[i]; prevOut = out[i];
  }
  return out;
}

export function normalizePeak(samples, peak = 0.97) {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max > 0) { const g = peak / max; for (let i = 0; i < samples.length; i++) samples[i] *= g; }
  return samples;
}

export { BPM, Q };
