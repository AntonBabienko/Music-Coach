import { PitchDetector } from "pitchy";
import type { NoteEvent } from "./types";
import { getAudioContextClass } from "./audioContext";

// Audio performance input: monophonic pitch tracking + note segmentation.
//
// The core is a PURE function `samplesToNotes` over raw Float32 samples, so it
// can be unit-tested in Node without a browser. The browser-only Web Audio
// decode step is a thin wrapper on top (`audioToNotes`).
//
// Scope (v1): monophonic only. Polyphonic transcription is a separate hard
// problem and is intentionally out of scope (see README).

/** Default frequency bounds used by the pitch detector.
 *  Export these so the comparison layer can filter the reference to the same
 *  detectable range, preventing bass notes below minFreq from showing as
 *  "missed" when comparing against audio. */
export const AUDIO_MIN_FREQ = 200; // Hz ≈ G3
export const AUDIO_MAX_FREQ = 2000; // Hz ≈ B6

export interface AudioToNotesOptions {
  frameSize?: number;
  hopSize?: number;
  /** pitchy "clarity" 0..1; frames below this are treated as silence. */
  clarityThreshold?: number;
  /** Discard segments shorter than this (filters transient glitches). */
  minNoteDurationSec?: number;
  minFreq?: number;
  maxFreq?: number;
  /** Correct sub-octave (octave-too-low) detections by checking the half-period
   *  periodicity. On by default; set false to get pitchy's raw output. */
  octaveCorrect?: boolean;
  /** A half-period whose NSDF is at least this fraction of the full-period NSDF
   *  is treated as evidence the detected pitch is a sub-octave and is doubled.
   *  Higher = more conservative (fewer corrections). */
  octaveRatio?: number;
}

export function freqToMidi(freq: number): number {
  return Math.round(69 + 12 * Math.log2(freq / 440));
}

// ---- helpers ---------------------------------------------------------------

/** 5-frame median smoothing: removes up to 2-frame pitch outliers at note edges
 *  while keeping silence boundaries crisp (only smooths fully-voiced windows). */
function medianSmooth(values: (number | null)[]): (number | null)[] {
  if (values.length < 5) return values.slice();
  const out = values.slice();
  for (let i = 2; i < values.length - 2; i++) {
    const win = [values[i - 2], values[i - 1], values[i], values[i + 1], values[i + 2]];
    if (win.every((v) => v != null)) {
      const sorted = (win as number[]).slice().sort((a, b) => a - b);
      out[i] = sorted[2]; // median of 5
    }
  }
  return out;
}

/**
 * Merge consecutive note events of the same MIDI pitch separated by a gap
 * shorter than maxGapSec. Piano sustain often drops below the clarity threshold
 * for 1–3 frames, fragmenting one note into several; this reassembles them.
 */
function mergeGaps(notes: NoteEvent[], maxGapSec = 0.08): NoteEvent[] {
  if (notes.length === 0) return [];
  const out: NoteEvent[] = [{ ...notes[0] }];
  for (let i = 1; i < notes.length; i++) {
    const prev = out[out.length - 1];
    const curr = notes[i];
    const prevEnd = prev.onsetSec + (prev.durationSec ?? 0);
    if (curr.midi === prev.midi && curr.onsetSec - prevEnd <= maxGapSec) {
      prev.durationSec = curr.onsetSec + (curr.durationSec ?? 0) - prev.onsetSec;
    } else {
      out.push({ ...curr });
    }
  }
  return out;
}

/**
 * Normalized square-difference periodicity (NSDF) of `frame` at integer `lag`,
 * in [-1, 1]. 1 = perfectly periodic at that lag. This is the same measure
 * pitchy's MPM uses internally; we recompute it here only at the lags we care
 * about (the detected period and its half) to detect octave errors.
 */
function nsdfAtLag(frame: Float32Array, lag: number): number {
  if (lag < 1 || lag >= frame.length) return 0;
  let acf = 0;
  let norm = 0;
  for (let i = 0; i + lag < frame.length; i++) {
    acf += frame[i] * frame[i + lag];
    norm += frame[i] * frame[i] + frame[i + lag] * frame[i + lag];
  }
  return norm > 0 ? (2 * acf) / norm : 0;
}

/**
 * Octave-error correction for monophonic pitch tracking.
 *
 * pitchy (and autocorrelation pitch trackers in general) frequently lock onto a
 * sub-harmonic on rich, polyphonic, or choral audio — reporting A3 (220 Hz) for
 * an A4 (440 Hz) melody note, because the signal is *also* periodic at the
 * doubled period. We detect this: if the NSDF at the half-period is nearly as
 * strong as at the full period, the true fundamental is an octave up. Double
 * while that holds and the result stays within `maxFreq` (catches the
 * occasional two-octave error too).
 */
function refineOctave(
  frame: Float32Array,
  sampleRate: number,
  freq: number,
  maxFreq: number,
  ratio: number
): number {
  let f = freq;
  for (let guard = 0; guard < 3; guard++) {
    const doubled = f * 2;
    if (doubled > maxFreq) break;
    const lag = Math.round(sampleRate / f);
    const halfLag = Math.round(sampleRate / doubled);
    if (halfLag < 1) break;
    const full = nsdfAtLag(frame, lag);
    const half = nsdfAtLag(frame, halfLag);
    if (full > 0 && half >= ratio * full) {
      f = doubled;
    } else {
      break;
    }
  }
  return f;
}

// ---- main export -----------------------------------------------------------

/**
 * Pure core: detect a monophonic pitch per analysis frame, then merge
 * consecutive frames of equal MIDI pitch into note events.
 */
export function samplesToNotes(
  samples: Float32Array,
  sampleRate: number,
  opts: AudioToNotesOptions = {}
): NoteEvent[] {
  const frameSize = opts.frameSize ?? 2048;
  const hopSize = opts.hopSize ?? 512;
  const clarityThreshold = opts.clarityThreshold ?? 0.78;
  const minNoteDur = opts.minNoteDurationSec ?? 0.06;
  // 200 Hz ≈ G3: filters bass fundamentals below the melody range, which pitchy
  // tends to lock onto in polyphonic piano audio (bass has the strongest fundamental).
  const minFreq = opts.minFreq ?? AUDIO_MIN_FREQ;
  const maxFreq = opts.maxFreq ?? AUDIO_MAX_FREQ;
  const octaveCorrect = opts.octaveCorrect ?? true;
  const octaveRatio = opts.octaveRatio ?? 0.8;

  const detector = PitchDetector.forFloat32Array(frameSize);
  detector.minVolumeDecibels = -1000; // don't gate on loudness; clarity gates instead

  // 1. Per-frame pitch (or null for unvoiced / unclear frames).
  const frameMidi: (number | null)[] = [];
  const frameTime: number[] = [];
  for (let start = 0; start + frameSize <= samples.length; start += hopSize) {
    const frame = samples.subarray(start, start + frameSize);
    const [pitch, clarity] = detector.findPitch(frame, sampleRate);
    frameTime.push(start / sampleRate);
    if (clarity >= clarityThreshold && pitch >= minFreq && pitch <= maxFreq) {
      const corrected = octaveCorrect
        ? refineOctave(frame, sampleRate, pitch, maxFreq, octaveRatio)
        : pitch;
      frameMidi.push(freqToMidi(corrected));
    } else {
      frameMidi.push(null);
    }
  }

  // 2. Median-of-5 smoothing removes up to 2-frame pitch outliers.
  const smoothed = medianSmooth(frameMidi);

  // 3. Segment runs of equal pitch into notes.
  const notes: NoteEvent[] = [];
  const frameDur = hopSize / sampleRate;
  let cur: number | null = null;
  let segStart = 0;

  const flush = (endTime: number) => {
    if (cur != null) {
      const dur = endTime - segStart;
      if (dur >= minNoteDur) {
        notes.push({ midi: cur, onsetSec: segStart, durationSec: dur });
      }
    }
  };

  for (let i = 0; i < smoothed.length; i++) {
    if (smoothed[i] !== cur) {
      flush(frameTime[i]);
      cur = smoothed[i];
      segStart = frameTime[i];
    }
  }
  const lastTime = frameTime.length ? frameTime[frameTime.length - 1] + frameDur : 0;
  flush(lastTime);

  // 4. Merge same-pitch fragments separated by short gaps (piano sustain drops).
  const merged = mergeGaps(notes, 0.12);
  merged.sort((a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi);
  return merged;
}

/** Browser-only: decode an audio file (wav/mp3/…) to mono Float32 samples.
 *  All channels are averaged so a stereo recording doesn't lose the right channel. */
export async function decodeAudioFile(
  buffer: ArrayBuffer
): Promise<{ samples: Float32Array; sampleRate: number }> {
  const Ctx = getAudioContextClass();
  const ctx = new Ctx();
  try {
    const audioBuf = await ctx.decodeAudioData(buffer.slice(0));
    const len = audioBuf.length;
    const nCh = audioBuf.numberOfChannels;
    if (nCh === 1) {
      return { samples: new Float32Array(audioBuf.getChannelData(0)), sampleRate: audioBuf.sampleRate };
    }
    const mono = new Float32Array(len);
    for (let ch = 0; ch < nCh; ch++) {
      const chData = audioBuf.getChannelData(ch);
      for (let i = 0; i < len; i++) mono[i] += chData[i];
    }
    for (let i = 0; i < len; i++) mono[i] /= nCh;
    return { samples: mono, sampleRate: audioBuf.sampleRate };
  } finally {
    void ctx.close();
  }
}

/** Browser convenience: audio file → note events. */
export async function audioToNotes(
  buffer: ArrayBuffer,
  opts?: AudioToNotesOptions
): Promise<NoteEvent[]> {
  const { samples, sampleRate } = await decodeAudioFile(buffer);
  return samplesToNotes(samples, sampleRate, opts);
}
