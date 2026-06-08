// Shared helpers for the audio-analysis eval harness.
//
// The slow part (basic-pitch CNN) is deterministic for a given input, so it is
// run once by eval-capture.mjs and cached. Everything here operates on the
// cached frames/onsets/contours tensors so the tuning loop stays sub-second.
//
// The post-CNN decode mirrors lib/noteDecoder.worker.ts exactly (it calls the
// same basic-pitch functions the worker inlines), and quantize/compare are
// imported straight from lib/ so the harness measures the real pipeline.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { resolve, dirname, basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

import decodeAudio from "audio-decode";
import { quantizeNotes, filterShortNotes } from "../lib/quantize.ts";
import { compare, collapseChords, cleanPhantomSteps } from "../lib/compare.ts";
import { scoreInformedCompare } from "../lib/scoreInformed.ts";
import { parseMusicXML } from "../lib/musicxml.ts";

// Inlined verbatim from lib/preprocess.ts (importing it pulls the browser-only
// audioContext module). Keep in sync if the app's SNR→threshold mapping changes.
function thresholdsForSnr(snrDb) {
  const CLEAN = { snr: 30, onset: 0.4, frame: 0.25, vel: 0.1 };
  const NOISY = { snr: 10, onset: 0.6, frame: 0.4, vel: 0.18 };
  const t = Math.max(0, Math.min(1, (snrDb - NOISY.snr) / (CLEAN.snr - NOISY.snr)));
  const lerp = (a, b) => a + (b - a) * t;
  return {
    onsetThreshold: +lerp(NOISY.onset, CLEAN.onset).toFixed(3),
    frameThreshold: +lerp(NOISY.frame, CLEAN.frame).toFixed(3),
    velocityThreshold: +lerp(NOISY.vel, CLEAN.vel).toFixed(3),
  };
}

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(__dirname, "..");
export const FIXTURE_DIR = resolve(ROOT, "eval", "fixtures");
export const CAPTURE_DIR = resolve(ROOT, "eval", "captures");
export const GOLDEN_PATH = resolve(ROOT, "eval", "golden.json");

const AUDIO_EXTS = [".mp3", ".wav", ".m4a", ".ogg", ".flac"];

export const SR = 22050;
const midiToFreq = (m) => 440 * Math.pow(2, (m - 69) / 12);

// ---- audio I/O --------------------------------------------------------------

/** Parse a 16-bit PCM mono .wav into { samples: Float32Array, sampleRate }. */
export function readWavMono(path) {
  const b = readFileSync(path);
  const sampleRate = b.readUInt32LE(24);
  const bits = b.readUInt16LE(34);
  if (bits !== 16) throw new Error(`expected 16-bit wav, got ${bits}-bit`);
  let off = 12;
  while (off < b.length) {
    const id = b.toString("ascii", off, off + 4);
    const size = b.readUInt32LE(off + 4);
    if (id === "data") {
      const n = size / 2;
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = b.readInt16LE(off + 8 + i * 2) / 32768;
      return { samples: out, sampleRate };
    }
    off += 8 + size;
  }
  throw new Error("no data chunk in wav");
}

export function resampleLinear(samples, srIn, srOut) {
  if (srIn === srOut) return samples;
  const ratio = srOut / srIn;
  const n = Math.floor(samples.length * ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i / ratio;
    const i0 = Math.floor(x);
    const i1 = Math.min(i0 + 1, samples.length - 1);
    out[i] = samples[i0] + (samples[i1] - samples[i0]) * (x - i0);
  }
  return out;
}

/** Write a Float32 mono buffer as a 16-bit PCM .wav. */
export function writeWavMono(path, samples, sr = SR) {
  const n = samples.length;
  const out = Buffer.alloc(44 + n * 2);
  out.write("RIFF", 0); out.writeUInt32LE(36 + n * 2, 4); out.write("WAVE", 8);
  out.write("fmt ", 12); out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(1, 22);
  out.writeUInt32LE(sr, 24); out.writeUInt32LE(sr * 2, 28); out.writeUInt16LE(2, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36); out.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  writeFileSync(path, out);
}

/**
 * Decode any supported audio file (mp3/wav/m4a/ogg/flac) to a mono Float32
 * buffer resampled to SR. Mirrors the browser's decode→mono→resample so the
 * CNN sees the same kind of input the app feeds it.
 */
export async function decodeAudioFile(path) {
  const decode = decodeAudio.default ?? decodeAudio;
  const { channelData, sampleRate } = await decode(readFileSync(path));
  let mono = channelData[0];
  if (channelData.length > 1) {
    mono = new Float32Array(channelData[0].length);
    for (let c = 0; c < channelData.length; c++) {
      const ch = channelData[c];
      for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / channelData.length;
    }
  }
  return resampleLinear(mono, sampleRate, SR);
}

/**
 * Parse a score's MusicXML into { notes, bpm }. The audio contains EVERY part of
 * the piece, so ground truth merges all parts (not just the first) — otherwise
 * notes from other voices get miscounted as false-positive "extra" detections.
 */
export function loadScore(xmlPath) {
  const parsed = parseMusicXML(readFileSync(xmlPath, "utf-8"));
  const notes = parsed.parts.length > 0
    ? parsed.parts.flatMap((p) => p.notes).sort((a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi)
    : parsed.notes;
  return { notes, bpm: parsed.tempo };
}

/**
 * Discover fixtures in eval/fixtures/: any `<name>.musicxml` that has a matching
 * `<name>.<audio>` file. The corpus is whatever is in the folder — drop in a
 * score + recording pair and it is picked up, no code change.
 */
export function discoverFixtures(dir = FIXTURE_DIR) {
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir);
  const byName = new Map();
  for (const f of files) {
    const name = basename(f, extname(f));
    const ext = extname(f).toLowerCase();
    const entry = byName.get(name) ?? {};
    if (ext === ".musicxml" || ext === ".xml") entry.xmlPath = join(dir, f);
    else if (AUDIO_EXTS.includes(ext)) entry.audioPath = join(dir, f);
    byName.set(name, entry);
  }
  return [...byName.entries()]
    .filter(([, e]) => e.xmlPath && e.audioPath)
    .map(([name, e]) => ({ name, ...e }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Synthesize a list of {midi,time,dur} events into mono sine samples at SR. */
export function synth(events, sr = SR) {
  const totalSec = Math.max(...events.map((e) => e.time + e.dur)) + 0.1;
  const total = Math.ceil(totalSec * sr);
  const buf = new Float32Array(total);
  const fade = Math.floor(0.005 * sr);
  for (const e of events) {
    const f = midiToFreq(e.midi);
    const start = Math.floor(e.time * sr);
    const len = Math.floor(e.dur * sr);
    for (let n = 0; n < len; n++) {
      let amp = 0.6;
      if (n < fade) amp *= n / fade;
      else if (n > len - fade) amp *= (len - n) / fade;
      buf[start + n] += amp * Math.sin((2 * Math.PI * f * n) / sr);
    }
  }
  return buf;
}

/** Peak-normalize in place to `peak`. */
export function normalizePeak(samples, peak = 0.97) {
  let max = 0;
  for (const s of samples) max = Math.max(max, Math.abs(s));
  if (max > 0) {
    const g = peak / max;
    for (let i = 0; i < samples.length; i++) samples[i] *= g;
  }
  return samples;
}

/** Cheap SNR estimate mirroring lib/preprocess.ts analyze(): 20 ms RMS frames,
 *  10th-percentile floor vs 95th-percentile signal, in dB. */
export function estimateSnrDb(samples, sr = SR) {
  const frameLen = Math.max(1, Math.round(sr * 0.02));
  const rms = [];
  for (let i = 0; i + frameLen <= samples.length; i += frameLen) {
    let s = 0;
    for (let j = 0; j < frameLen; j++) s += samples[i + j] ** 2;
    rms.push(Math.sqrt(s / frameLen));
  }
  if (rms.length === 0) return 30;
  rms.sort((a, b) => a - b);
  const pct = (p) => rms[Math.min(rms.length - 1, Math.max(0, Math.round(p * (rms.length - 1))))];
  const toDb = (x) => 20 * Math.log10(Math.max(1e-9, x));
  return toDb(pct(0.95)) - toDb(pct(0.1));
}

// ---- capture I/O ------------------------------------------------------------

export function writeCapture(name, capture) {
  mkdirSync(CAPTURE_DIR, { recursive: true });
  // Round tensors to 4 dp — well below any threshold (~0.3) and ~halves size.
  const round = (m) => m.map((row) => row.map((v) => Math.round(v * 1e4) / 1e4));
  const out = {
    ...capture,
    frames: round(capture.frames),
    onsets: round(capture.onsets),
    contours: round(capture.contours),
  };
  writeFileSync(resolve(CAPTURE_DIR, `${name}.json`), JSON.stringify(out));
}

export function readCapture(name) {
  return JSON.parse(readFileSync(resolve(CAPTURE_DIR, `${name}.json`), "utf-8"));
}

// ---- the tunable pipeline (fast) -------------------------------------------

/**
 * Decode notes from cached CNN tensors, exactly as lib/noteDecoder.worker.ts
 * does, then apply the same velocity gate as lib/basicPitch.ts.
 */
export async function decodeNotes(capture, params) {
  const { outputToNotesPoly, addPitchBendsToNoteEvents, noteFramesToTime } =
    await import("@spotify/basic-pitch");
  const { frames, onsets, contours } = capture;
  const raw = outputToNotesPoly(
    frames, onsets,
    params.onsetThreshold, params.frameThreshold, params.minNoteFrames,
    false, null, null, false
  );
  const timed = noteFramesToTime(addPitchBendsToNoteEvents(contours, raw));
  return timed
    .map((ev) => ({
      midi: ev.pitchMidi,
      onsetSec: ev.startTimeSeconds,
      durationSec: ev.durationSeconds,
      velocity: ev.amplitude,
    }))
    .filter((n) => (n.velocity ?? 1) >= params.velocityThreshold)
    .sort((a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi);
}

/** Default params = the app's SNR-adaptive thresholds for this capture. */
export function defaultParams(capture, overrides = {}) {
  const t = thresholdsForSnr(capture.snrDb);
  return {
    onsetThreshold: t.onsetThreshold,
    frameThreshold: t.frameThreshold,
    velocityThreshold: t.velocityThreshold,
    minNoteFrames: 11,
    ghostRatio: 0, // 0 = off; >0 drops harmonic ghosts quieter than ratio×fundamental
    ...overrides,
  };
}

/**
 * Remove harmonic-ghost notes: basic-pitch reports an overtone of a struck note
 * as its own note an octave (or octave+fifth / two octaves) above, at the SAME
 * onset but lower amplitude. A real octave between voices has comparable
 * amplitude, so only drop the upper note when it is quieter than
 * `ratio × fundamental velocity` — preserving genuine octaves (recall) while
 * cutting overtone false positives (precision).
 *
 * Operates on quantized notes (onsets already snapped, so a struck note and its
 * overtone share an exact onset slot).
 */
export function dropHarmonicGhosts(notes, ratio = 0.6, intervals = [12, 19, 24]) {
  const bySlot = new Map();
  for (const n of notes) {
    const key = n.onsetSec.toFixed(6);
    (bySlot.get(key) ?? bySlot.set(key, []).get(key)).push(n);
  }
  const drop = new Set();
  for (const group of bySlot.values()) {
    for (const hi of group) {
      const hv = hi.velocity ?? 1;
      for (const lo of group) {
        if (lo === hi) continue;
        if (!intervals.includes(hi.midi - lo.midi)) continue;
        const lv = lo.velocity ?? 1;
        if (hv < ratio * lv) { drop.add(hi); break; }
      }
    }
  }
  return notes.filter((n) => !drop.has(n));
}

/** Run decode → quantize/filter → compare for one capture; return metrics. */
export async function runPipeline(capture, overrides = {}) {
  const params = defaultParams(capture, overrides);
  const transcribed = await decodeNotes(capture, params);

  const bpm = capture.bpm;
  const quantized = quantizeNotes(filterShortNotes(transcribed, 50, bpm), bpm);
  const perf = params.ghostRatio > 0
    ? dropHarmonicGhosts(quantized, params.ghostRatio)
    : quantized;

  // Transcription fidelity vs the notes actually present in the audio, matched
  // on ABSOLUTE onset time. Only meaningful when the ground-truth times line up
  // with the recording (synthetic clips) — for real recordings the score times
  // come from a nominal bpm and drift, so use scoreMatch (below) instead.
  const fidelity = noteMatchMetrics(capture.played, perf, 0.15);

  // App-level grade. Default = the DTW note-sequence compare() the UI runs.
  // With scoreInformed=1, grade directly off the cached posteriorgrams using the
  // score as a localization prior (lib/scoreInformed.ts).
  const ref = capture.ref ?? capture.played;
  const cmp = overrides.scoreInformed
    ? scoreInformedCompare(ref, capture.frames, capture.onsets, {
        onsetThreshold: overrides.onsetThreshold,
        frameThreshold: overrides.frameThreshold,
        extraThreshold: overrides.extraThreshold,
        onsetTolSec: overrides.onsetTolSec,
        classifyTolSec: overrides.classifyTolSec,
        linearWarp: !!overrides.linearWarp,
      })
    : cleanPhantomSteps(compare(ref, perf));

  // Tempo-invariant analysis quality, derived from the DTW alignment so it works
  // for real recordings: recall = score notes found, precision = fraction of
  // detected notes that are real (the rest are "extra" false positives).
  const scoreMatch = scoreMatchMetrics(cmp);

  return { params, transcribed, perf, fidelity, cmp, scoreMatch };
}

// ---- metrics ----------------------------------------------------------------

/**
 * Greedy note-level precision/recall/F1 between a ground-truth note list and a
 * detected note list. A detection matches a truth note when the pitch is equal
 * and the onset is within `tolSec`. Each is used at most once.
 */
export function noteMatchMetrics(truth, detected, tolSec = 0.15) {
  const t = [...truth].sort((a, b) => a.onsetSec - b.onsetSec);
  const d = [...detected].sort((a, b) => a.onsetSec - b.onsetSec);
  const usedD = new Array(d.length).fill(false);
  let tp = 0;
  let onsetErrSum = 0;
  for (const tn of t) {
    let best = -1;
    let bestErr = Infinity;
    for (let i = 0; i < d.length; i++) {
      if (usedD[i] || d[i].midi !== tn.midi) continue;
      const err = Math.abs(d[i].onsetSec - tn.onsetSec);
      if (err <= tolSec && err < bestErr) { best = i; bestErr = err; }
    }
    if (best >= 0) { usedD[best] = true; tp++; onsetErrSum += bestErr; }
  }
  const fp = d.length - tp;
  const fn = t.length - tp;
  const precision = d.length ? tp / d.length : 0;
  const recall = t.length ? tp / t.length : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    truth: t.length, detected: d.length, tp, fp, fn,
    precision, recall, f1,
    onsetMaeMs: tp ? (onsetErrSum / tp) * 1000 : 0,
  };
}

/**
 * Tempo-invariant analysis quality from a DTW CompareResult:
 *   recall    = matched score notes / score notes   (did we find the real notes)
 *   precision = matched score notes / detected notes (how clean — rest are extra)
 * Robust to expressive timing because DTW already aligned the sequences.
 */
export function scoreMatchMetrics(cmp) {
  const match = cmp.counts.match;
  const precision = cmp.perfCount ? match / cmp.perfCount : 0;
  const recall = cmp.refCount ? match / cmp.refCount : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    refCount: cmp.refCount, perfCount: cmp.perfCount,
    match, wrong: cmp.counts.wrong, extra: cmp.counts.extra,
    precision, recall, f1,
  };
}

export const pct = (x) => `${(x * 100).toFixed(1)}%`;
export const goldenExists = () => existsSync(GOLDEN_PATH);
