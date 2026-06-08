import { getAudioContextClass } from "./audioContext";

// Shared audio pre-processing for every transcription path (basic-pitch + chroma).
//
// Raw mic / file audio goes straight into the detectors today, so room rumble,
// silence hiss and inconsistent levels all become phantom notes or missed
// notes. This module inserts a single, deterministic DSP chain BEFORE any
// detector sees the audio:
//
//   decode → resample (mono, target SR) → high-pass 70 Hz   (offline graph)
//          → noise-floor / SNR analysis → soft noise gate → peak normalize
//
// It also reports the measured signal-to-noise ratio so the caller can pick
// detection thresholds that match the recording quality (see thresholdsForSnr).
//
// The DSP runs in an OfflineAudioContext for the filter+resample, then in the
// sample domain for the gate+normalize (envelope work is easier on a flat
// Float32Array than in the graph). Everything is pure aside from the unavoidable
// Web Audio decode, so it is safe to call from any path.

export interface PreprocessOptions {
  /** Output sample rate. basic-pitch and chroma both want 22050. */
  targetSampleRate?: number;
  /** High-pass corner in Hz (kills HVAC / desk rumble / DC). Default 70. */
  highPassHz?: number;
  /** Disable the noise gate (e.g. for already-clean studio input). */
  gate?: boolean;
  /** Disable peak normalization. */
  normalize?: boolean;
}

export interface PreprocessMetrics {
  /** 10th-percentile frame RMS in dBFS — the noise floor estimate. */
  noiseFloorDb: number;
  /** 95th-percentile frame RMS in dBFS — representative signal level. */
  signalDb: number;
  /** signalDb − noiseFloorDb. High = clean recording, low = noisy room. */
  snrDb: number;
  /** Fraction of frames the gate attenuated (0..1) — sanity/debug. */
  gatedFraction: number;
}

export interface PreprocessResult {
  /** Cleaned mono samples at `sampleRate`. */
  samples: Float32Array;
  sampleRate: number;
  metrics: PreprocessMetrics;
}

const TARGET_SR = 22050;
const FRAME_SEC = 0.02; // 20 ms RMS analysis frame
const EPS = 1e-9;

const toDb = (x: number) => 20 * Math.log10(Math.max(EPS, x));

// ---- detection thresholds from measured SNR --------------------------------

export interface DetectThresholds {
  onsetThreshold: number;
  frameThreshold: number;
  velocityThreshold: number;
}

/**
 * Map a recording's measured SNR to basic-pitch thresholds.
 *
 * Clean input (high SNR) → lower thresholds, trust the model, catch quiet
 * notes. Noisy input (low SNR) → raise thresholds and the velocity gate so room
 * noise and overtones don't become phantom notes. Interpolated smoothly between
 * a CLEAN and a NOISY anchor so there are no cliff edges between recordings.
 */
export function thresholdsForSnr(snrDb: number): DetectThresholds {
  const CLEAN = { snr: 30, onset: 0.4, frame: 0.25, vel: 0.1 };
  // Verified on the eval harness against full multi-part ground truth
  // (jesus-lives, all 1412 notes): this anchor sits on the F1≈69% optimum with a
  // good precision/recall balance. Raising the thresholds only trades recall for
  // precision along the same F1 line, so further gains need structural dedup
  // (octave/harmonic ghosts), not stricter thresholds. See `npm run eval`.
  const NOISY = { snr: 10, onset: 0.6, frame: 0.4, vel: 0.18 };
  // t = 0 at NOISY anchor, 1 at CLEAN anchor, clamped.
  const t = Math.max(0, Math.min(1, (snrDb - NOISY.snr) / (CLEAN.snr - NOISY.snr)));
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return {
    onsetThreshold: +lerp(NOISY.onset, CLEAN.onset).toFixed(3),
    frameThreshold: +lerp(NOISY.frame, CLEAN.frame).toFixed(3),
    velocityThreshold: +lerp(NOISY.vel, CLEAN.vel).toFixed(3),
  };
}

// ---- main ------------------------------------------------------------------

/** Decode, resample to mono target SR, high-pass, gate, and normalize. */
export async function preprocessAudio(
  buffer: ArrayBuffer,
  opts: PreprocessOptions = {},
): Promise<PreprocessResult> {
  const sampleRate = opts.targetSampleRate ?? TARGET_SR;
  const highPassHz = opts.highPassHz ?? 70;

  // --- decode (native rate) ---
  const decodeCtx = new (getAudioContextClass())();
  let decoded: AudioBuffer;
  try {
    decoded = await decodeCtx.decodeAudioData(buffer.slice(0));
  } finally {
    void decodeCtx.close();
  }

  // --- resample to mono + high-pass in one offline render ---
  const len = Math.max(1, Math.ceil(decoded.duration * sampleRate));
  const offline = new OfflineAudioContext(1, len, sampleRate);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  const hp = offline.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = highPassHz;
  hp.Q.value = 0.707; // Butterworth, no resonant bump at the corner
  src.connect(hp).connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  const samples = rendered.getChannelData(0).slice();

  // --- noise-floor / SNR analysis ---
  const { metrics, frameRms, frameLen } = analyze(samples, sampleRate);

  // --- soft noise gate (frame envelope → per-sample gain) ---
  let gatedFraction = 0;
  if (opts.gate !== false && metrics.snrDb > 3) {
    gatedFraction = applyGate(samples, frameRms, frameLen, metrics);
  }

  // --- peak normalization ---
  if (opts.normalize !== false) {
    normalizePeak(samples, 0.97);
  }

  return {
    samples,
    sampleRate,
    metrics: { ...metrics, gatedFraction },
  };
}

/** Wrap raw mono samples in an AudioBuffer (basic-pitch's evaluateModel wants one). */
export function samplesToAudioBuffer(samples: Float32Array, sampleRate: number): AudioBuffer {
  const ctx = new OfflineAudioContext(1, samples.length, sampleRate);
  const buf = ctx.createBuffer(1, samples.length, sampleRate);
  // TS 6's Float32Array is generic over its backing buffer; copyToChannel wants
  // an ArrayBuffer-backed view, so narrow the (always ArrayBuffer-backed) samples.
  buf.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
  return buf;
}

// ---- helpers ---------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i];
}

function analyze(
  samples: Float32Array,
  sampleRate: number,
): { metrics: Omit<PreprocessMetrics, "gatedFraction">; frameRms: Float32Array; frameLen: number } {
  const frameLen = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const nFrames = Math.max(1, Math.floor(samples.length / frameLen));
  const frameRms = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    const off = f * frameLen;
    let s = 0;
    for (let i = 0; i < frameLen; i++) { const v = samples[off + i]; s += v * v; }
    frameRms[f] = Math.sqrt(s / frameLen);
  }

  const sorted = [...frameRms].sort((a, b) => a - b);
  const noiseFloor = percentile(sorted, 0.1);
  const signal = percentile(sorted, 0.95);
  const noiseFloorDb = toDb(noiseFloor);
  const signalDb = toDb(signal);

  return {
    metrics: { noiseFloorDb, signalDb, snrDb: signalDb - noiseFloorDb },
    frameRms,
    frameLen,
  };
}

/**
 * Hysteresis gate at frame granularity, smoothed with attack/release, then
 * applied per-sample with linear gain interpolation to avoid zipper noise.
 * Returns the fraction of frames left below full gain.
 */
function applyGate(
  samples: Float32Array,
  frameRms: Float32Array,
  frameLen: number,
  metrics: Omit<PreprocessMetrics, "gatedFraction">,
): number {
  const noiseLin = Math.pow(10, metrics.noiseFloorDb / 20);
  const openThresh = noiseLin * 3.0;   // ~ +9.5 dB above the floor: gate opens
  const closeThresh = noiseLin * 1.8;  // ~ +5 dB: gate closes (hysteresis)
  const GAIN_FLOOR = 0.06;             // ~ -24 dB residual, not a hard zero
  const ATTACK = 0.6;  // fast open (per-frame smoothing coeff toward target)
  const RELEASE = 0.15; // slow close, so note tails aren't chopped

  const n = frameRms.length;
  const gains = new Float32Array(n);
  let open = false;
  let g = GAIN_FLOOR;
  let gatedFrames = 0;
  for (let f = 0; f < n; f++) {
    const r = frameRms[f];
    if (open) { if (r < closeThresh) open = false; }
    else { if (r > openThresh) open = true; }
    const target = open ? 1 : GAIN_FLOOR;
    const coeff = target > g ? ATTACK : RELEASE;
    g += (target - g) * coeff;
    gains[f] = g;
    if (g < 0.999) gatedFrames++;
  }

  // Apply per-sample with linear interpolation between adjacent frame gains.
  for (let f = 0; f < n; f++) {
    const g0 = gains[f];
    const g1 = f + 1 < n ? gains[f + 1] : gains[f];
    const off = f * frameLen;
    for (let i = 0; i < frameLen; i++) {
      const t = i / frameLen;
      samples[off + i] *= g0 + (g1 - g0) * t;
    }
  }
  // Tail beyond the last full frame keeps the last gain.
  for (let i = n * frameLen; i < samples.length; i++) samples[i] *= gains[n - 1];

  return gatedFrames / n;
}

function normalizePeak(samples: Float32Array, target: number): void {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const a = Math.abs(samples[i]);
    if (a > peak) peak = a;
  }
  if (peak < 1e-4) return; // essentially silent — don't amplify noise
  const gain = target / peak;
  for (let i = 0; i < samples.length; i++) samples[i] *= gain;
}
