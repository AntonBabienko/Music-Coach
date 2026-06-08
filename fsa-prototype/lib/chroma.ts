import type { NoteEvent } from "./types";
import { preprocessAudio } from "./preprocess";
import { DEFAULT_NOTE_DURATION_SEC } from "./constants";

// Fast qualitative audio comparison via chroma features + DTW.
// No ML model — uses inline FFT on raw PCM samples.
// Processing time: ~0.5s for a 3-min file vs 2-3 min for basic-pitch.

const SR = 22050;
const FFT_N = 4096;
const HOP = 2048;           // 50% overlap: 93ms per frame, better DTW alignment
const HOP_SEC = HOP / SR;
const A4 = 440;
const BIN_HZ = SR / FFT_N;

export interface ChromaResult {
  pitchSimilarity: number;               // 0–100
  tempoRatio: number;                    // detectedBPM / xmlBPM
  detectedBPM: number;
  xmlBPM: number;
  weakest?: { fromSec: number; toSec: number };
  lowConfidence: boolean;
  tips: string[];
}

// ---- FFT (radix-2 Cooley-Tukey, in-place) ----------------------------------
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < (len >> 1); j++) {
        const k = i + j, m = k + (len >> 1);
        const ur = re[k], ui = im[k];
        const vr = re[m] * cr - im[m] * ci;
        const vi = re[m] * ci + im[m] * cr;
        re[k] = ur + vr; im[k] = ui + vi;
        re[m] = ur - vr; im[m] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const HANN: Float64Array = (() => {
  const w = new Float64Array(FFT_N);
  for (let i = 0; i < FFT_N; i++)
    w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (FFT_N - 1)));
  return w;
})();

function l2(v: Float32Array): void {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s);
  if (s > 0) for (let i = 0; i < v.length; i++) v[i] /= s;
}

// Pre-compute pitch class for each FFT bin (avoids log2 per frame).
const BIN_PC: Int8Array = (() => {
  const a = new Int8Array(FFT_N >> 1);
  for (let b = 1; b < (FFT_N >> 1); b++) {
    const hz = b * BIN_HZ;
    a[b] = (hz < 27.5 || hz > 4186) ? -1 :
      ((Math.round(12 * Math.log2(hz / A4) + 69) % 12) + 12) % 12;
  }
  return a;
})();

// ---- Chroma extraction (async, yields every BATCH frames) ------------------
const CHROMA_BATCH = 128;

async function samplesToChroma(
  samples: Float32Array,
  onProgress?: (msg: string) => void
): Promise<Float32Array[]> {
  const nFrames = Math.max(1, Math.floor(samples.length / HOP));
  console.log(`[chroma] FFT: ${nFrames} frames × ${FFT_N} pts`);
  const out: Float32Array[] = [];
  const re = new Float64Array(FFT_N);
  const im = new Float64Array(FFT_N);

  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP;
    re.fill(0); im.fill(0);
    const end = Math.min(FFT_N, samples.length - off);
    for (let i = 0; i < end; i++) re[i] = samples[off + i] * HANN[i];
    fft(re, im);

    const chroma = new Float32Array(12);
    for (let b = 1; b < (FFT_N >> 1); b++) {
      const pc = BIN_PC[b];
      if (pc < 0) continue;
      chroma[pc] += Math.hypot(re[b], im[b]);
    }
    l2(chroma);
    out.push(chroma);

    // Yield to browser every BATCH frames so UI stays responsive.
    if ((f + 1) % CHROMA_BATCH === 0) {
      const pct = Math.round((f + 1) / nFrames * 100);
      console.log(`[chroma] FFT ${pct}% (frame ${f + 1}/${nFrames})`);
      onProgress?.(`Extracting chroma… ${pct}%`);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  return out;
}

// Reference chroma from parsed NoteEvent[].
// Harmonic template models dominant piano partials so reference vectors
// match the spectral shape of real piano audio instead of binary pitch class.
// [semitone offset, weight]: fundamental=1.0, P5=0.5, M3=0.25, m7=0.1
const PIANO_HARMONICS: [number, number][] = [[0, 1.0], [7, 0.5], [4, 0.25], [10, 0.1]];

function notesToChroma(notes: NoteEvent[], totalSec: number): Float32Array[] {
  const nFrames = Math.ceil(totalSec / HOP_SEC) + 1;
  const out: Float32Array[] = Array.from({ length: nFrames }, () => new Float32Array(12));
  for (const n of notes) {
    const s = Math.floor(n.onsetSec / HOP_SEC);
    const e = Math.ceil((n.onsetSec + (n.durationSec ?? DEFAULT_NOTE_DURATION_SEC)) / HOP_SEC);
    for (let f = s; f < Math.min(e, nFrames); f++) {
      for (const [semi, w] of PIANO_HARMONICS) {
        out[f][(n.midi + semi) % 12] += w;
      }
    }
  }
  for (const frame of out) l2(frame);
  return out;
}

function cosSim(a: Float32Array, b: Float32Array): number {
  let d = 0;
  for (let i = 0; i < 12; i++) d += a[i] * b[i];
  return Math.max(0, Math.min(1, d));
}

// DTW — returns cosine similarity at each ref frame along the optimal path.
function dtw(ref: Float32Array[], perf: Float32Array[]): Float32Array {
  const N = ref.length, M = perf.length;
  const D = new Float32Array(N * M);

  D[0] = 1 - cosSim(ref[0], perf[0]);
  for (let i = 1; i < N; i++) D[i * M] = D[(i - 1) * M] + 1 - cosSim(ref[i], perf[0]);
  for (let j = 1; j < M; j++) D[j] = D[j - 1] + 1 - cosSim(ref[0], perf[j]);
  for (let i = 1; i < N; i++)
    for (let j = 1; j < M; j++)
      D[i * M + j] =
        1 - cosSim(ref[i], perf[j]) +
        Math.min(D[(i - 1) * M + j], D[i * M + j - 1], D[(i - 1) * M + j - 1]);

  const sims = new Float32Array(N);
  let i = N - 1, j = M - 1;
  while (i > 0 || j > 0) {
    sims[i] = cosSim(ref[i], perf[j]);
    if (i === 0) { j--; continue; }
    if (j === 0) { i--; continue; }
    const d = D[(i - 1) * M + j], l = D[i * M + j - 1], dl = D[(i - 1) * M + j - 1];
    const best = Math.min(d, l, dl);
    if (best === dl) { i--; j--; }
    else if (best === d) i--;
    else j--;
  }
  sims[0] = cosSim(ref[0], perf[0]);
  return sims;
}

// ---- BPM detection (autocorrelation on onset strength) ---------------------
function detectBPM(samples: Float32Array): number {
  const HOP_ONSET = 512;
  const FPS = SR / HOP_ONSET;
  const nFrames = Math.floor(samples.length / HOP_ONSET);
  if (nFrames < 8) return 120;

  const onset = new Float32Array(nFrames);
  let prevE = 0;
  for (let f = 0; f < nFrames; f++) {
    const off = f * HOP_ONSET;
    let e = 0;
    const end = Math.min(HOP_ONSET, samples.length - off);
    for (let i = 0; i < end; i++) e += samples[off + i] ** 2;
    onset[f] = Math.max(0, e - prevE);
    prevE = e;
  }

  const minLag = Math.max(1, Math.round(FPS * 60 / 200));
  const maxLag = Math.round(FPS * 60 / 50);
  let bestCorr = -1, bestLag = Math.round(FPS * 60 / 120);
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0;
    const n = nFrames - lag;
    for (let i = 0; i < n; i++) c += onset[i] * onset[i + lag];
    if (c / n > bestCorr) { bestCorr = c / n; bestLag = lag; }
  }
  return Math.round(FPS * 60 / bestLag);
}

// ---- Tone.js offline render (Salamander Grand Piano → raw samples) ----------
const SALAMANDER_BASE = "https://tonejs.github.io/audio/salamander/";
const SALAMANDER_URLS: Record<string, string> = {
  A0: "A0.mp3", C1: "C1.mp3", "D#1": "Ds1.mp3", "F#1": "Fs1.mp3",
  A1: "A1.mp3", C2: "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3",
  A2: "A2.mp3", C3: "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3",
  A3: "A3.mp3", C4: "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3",
  A4: "A4.mp3", C5: "C5.mp3", "D#5": "Ds5.mp3", "F#5": "Fs5.mp3",
  A5: "A5.mp3", C6: "C6.mp3", "D#6": "Ds6.mp3", "F#6": "Fs6.mp3",
  A6: "A6.mp3", C7: "C7.mp3", "D#7": "Ds7.mp3", "F#7": "Fs7.mp3",
  A7: "A7.mp3", C8: "C8.mp3",
};

async function renderScoreOffline(
  notes: NoteEvent[],
  onProgress?: (msg: string) => void
): Promise<Float32Array> {
  onProgress?.("Loading piano samples…");
  const Tone = await import("tone");

  const lastEnd =
    notes.reduce((m, n) => Math.max(m, n.onsetSec + (n.durationSec ?? DEFAULT_NOTE_DURATION_SEC)), 0) + 2;

  // Render at native sample rate; resample to SR=22050 afterwards.
  const toneBuffer = await Tone.Offline(async () => {
    const sampler = new Tone.Sampler({
      urls: SALAMANDER_URLS,
      baseUrl: SALAMANDER_BASE,
    }).toDestination();
    await Tone.loaded();
    onProgress?.("Rendering reference audio…");
    for (const n of notes) {
      const dur = Math.max(0.05, n.durationSec ?? DEFAULT_NOTE_DURATION_SEC);
      sampler.triggerAttackRelease(
        Tone.Frequency(n.midi, "midi").toNote() as string,
        dur * 0.95,
        n.onsetSec,
        0.7
      );
    }
  }, lastEnd);

  // Resample to SR=22050 mono.
  onProgress?.("Resampling reference…");
  const native = toneBuffer.get() as AudioBuffer;
  const len = Math.max(1, Math.ceil(lastEnd * SR));
  const offline = new OfflineAudioContext(1, len, SR);
  const src = offline.createBufferSource();
  src.buffer = native;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  console.log(`[chroma] ref rendered: ${rendered.length} samples @ ${SR} Hz`);
  return rendered.getChannelData(0).slice();
}

/** Pre-render the score with Salamander samples and extract chroma.
 *  Call once after score loads; pass result to compareAudioChroma as prebuiltRefChroma. */
export async function buildRefChroma(
  notes: NoteEvent[],
  onProgress?: (msg: string) => void
): Promise<Float32Array[]> {
  const samples = await renderScoreOffline(notes, onProgress);
  onProgress?.("Extracting reference chroma…");
  return samplesToChroma(samples);
}

// ---- Audio decode -----------------------------------------------------------
// Shares the same DSP chain as the basic-pitch path (high-pass + noise gate +
// normalize) so both detectors see identical cleaned audio. The per-frame L2
// normalization downstream makes amplitude irrelevant to chroma, but the
// high-pass and gate still remove rumble bins and silence hiss that would
// otherwise pollute the chroma vectors and the BPM autocorrelation.
async function decodeToMono(buffer: ArrayBuffer): Promise<Float32Array> {
  const { samples } = await preprocessAudio(buffer, { targetSampleRate: SR });
  return samples;
}

// ---- Public API -------------------------------------------------------------

/** Extract chroma frames from a performance audio buffer (fast, no ML). */
export async function perfAudioToChroma(
  buffer: ArrayBuffer,
  onProgress?: (msg: string) => void
): Promise<Float32Array[]> {
  const samples = await decodeToMono(buffer);
  return samplesToChroma(samples, onProgress);
}

/**
 * Compute per-measure chroma similarity from pre-extracted chroma frames.
 * Uses DTW alignment, then averages similarity within each measure's time window.
 * Returns Map<measureNumber, similarity 0-1>.
 */
export function chromaSimPerMeasure(
  refNotes: NoteEvent[],
  refChroma: Float32Array[],
  perfChroma: Float32Array[]
): Map<number, number> {
  const bounds = new Map<number, { from: number; to: number }>();
  for (const n of refNotes) {
    if (n.measure == null) continue;
    const end = n.onsetSec + (n.durationSec ?? DEFAULT_NOTE_DURATION_SEC);
    const b = bounds.get(n.measure);
    if (!b) bounds.set(n.measure, { from: n.onsetSec, to: end });
    else { b.from = Math.min(b.from, n.onsetSec); b.to = Math.max(b.to, end); }
  }

  const sims = dtw(refChroma, perfChroma);

  const out = new Map<number, number>();
  for (const [m, { from, to }] of bounds) {
    const f0 = Math.max(0, Math.floor(from / HOP_SEC));
    const f1 = Math.min(sims.length - 1, Math.ceil(to / HOP_SEC));
    if (f1 < f0) continue;
    let sum = 0;
    for (let f = f0; f <= f1; f++) sum += sims[f];
    out.set(m, sum / (f1 - f0 + 1));
  }
  return out;
}

/**
 * Compute per-measure chroma similarity between a performance audio buffer and
 * a reference NoteEvent[]. Uses the template-based refChroma (fast, no Salamander
 * download). Intended to run right after basic-pitch as a confidence filter.
 */
export async function chromaConfidenceFromAudio(
  buffer: ArrayBuffer,
  refNotes: NoteEvent[],
  onProgress?: (msg: string) => void
): Promise<Map<number, number>> {
  const refEnd = refNotes.reduce(
    (m, n) => Math.max(m, n.onsetSec + (n.durationSec ?? DEFAULT_NOTE_DURATION_SEC)), 1
  );
  const refChroma = notesToChroma(refNotes, refEnd);
  const perfChroma = await perfAudioToChroma(buffer, onProgress);
  return chromaSimPerMeasure(refNotes, refChroma, perfChroma);
}

export async function compareAudioChroma(
  buffer: ArrayBuffer,
  refNotes: NoteEvent[],
  xmlBPM: number,
  onProgress?: (msg: string) => void,
  prebuiltRefChroma?: Float32Array[]
): Promise<ChromaResult> {
  onProgress?.("Decoding audio…");
  console.log("[chroma] decoding audio…");
  const samples = await decodeToMono(buffer);
  console.log(`[chroma] decoded: ${samples.length} samples (${(samples.length / SR).toFixed(1)}s)`);

  console.log("[chroma] samplesToChroma start…");
  const perfChroma = await samplesToChroma(samples, onProgress);
  console.log(`[chroma] samplesToChroma done: ${perfChroma.length} frames`);

  const refEnd = refNotes.length > 0
    ? Math.max(...refNotes.map((n) => n.onsetSec + (n.durationSec ?? DEFAULT_NOTE_DURATION_SEC)))
    : 1;
  const refChroma = prebuiltRefChroma ?? notesToChroma(refNotes, refEnd);
  console.log(`[chroma] refChroma: ${refChroma.length} frames (${refEnd.toFixed(1)}s, ${prebuiltRefChroma ? "Salamander" : "template"})`);

  onProgress?.("Comparing…");
  console.log("[chroma] DTW start…");
  await new Promise<void>((r) => setTimeout(r, 0));
  const sims = dtw(refChroma, perfChroma);
  console.log(`[chroma] DTW done: avgSim=${(sims.reduce((a, b) => a + b, 0) / sims.length).toFixed(3)}`);

  const avgSim = sims.reduce((a, b) => a + b, 0) / sims.length;
  const pitchSimilarity = Math.round(avgSim * 100);

  const audioDuration = samples.length / SR;
  const tempoRatio = refEnd > 0 ? audioDuration / refEnd : 1;
  const detectedBPM = detectBPM(samples);
  console.log(`[chroma] tempo: audioDur=${audioDuration.toFixed(1)}s, refEnd=${refEnd.toFixed(1)}s, ratio=${tempoRatio.toFixed(2)}, detectedBPM=${detectedBPM}`);

  // Weakest: 10s sliding window, only report if notably below average
  const winF = Math.max(2, Math.round(10 / HOP_SEC));
  let weakest: ChromaResult["weakest"] = undefined;
  if (sims.length > winF * 2) {
    let worstSum = Infinity, worstStart = 0;
    for (let s = 0; s + winF <= sims.length; s++) {
      let sum = 0;
      for (let k = s; k < s + winF; k++) sum += sims[k];
      if (sum < worstSum) { worstSum = sum; worstStart = s; }
    }
    const worstAvg = worstSum / winF;
    if (worstAvg < avgSim * 0.80) {
      weakest = { fromSec: worstStart * HOP_SEC, toSec: (worstStart + winF) * HOP_SEC };
    }
  }

  const lowConfidence = sims.length < 10 || avgSim < 0.05;
  const tips = buildTips({ pitchSimilarity, tempoRatio, weakest, lowConfidence });
  return { pitchSimilarity, tempoRatio, detectedBPM, xmlBPM, weakest, lowConfidence, tips };
}

function buildTips(ctx: {
  pitchSimilarity: number;
  tempoRatio: number;
  weakest?: { fromSec: number; toSec: number };
  lowConfidence: boolean;
}): string[] {
  if (ctx.lowConfidence)
    return ["Low confidence — try a cleaner recording closer to the microphone."];

  const tips: string[] = [];
  if (ctx.pitchSimilarity < 60)
    tips.push("Many wrong notes detected — slow down and work on pitch accuracy phrase by phrase.");
  else if (ctx.pitchSimilarity < 80)
    tips.push("Pitch is mostly there but some notes are off — check each phrase slowly.");

  const r = ctx.tempoRatio;
  if (r < 0.92)
    tips.push(`You played ${Math.round((1 - r) * 100)}% faster than the reference — match the reference tempo.`);
  else if (r > 1.08)
    tips.push(`You played ${Math.round((r - 1) * 100)}% slower than the reference — build tempo with a metronome.`);

  if (ctx.weakest) {
    const mm = (s: number) =>
      `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    tips.push(
      `Most slips around ${mm(ctx.weakest.fromSec)}–${mm(ctx.weakest.toSec)} — loop that passage.`
    );
  }

  if (tips.length === 0)
    tips.push("Great — pitch and tempo closely match the reference.");
  return tips.slice(0, 3);
}
