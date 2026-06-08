import type { NoteEvent } from "./types";
import { preprocessAudio, samplesToAudioBuffer, thresholdsForSnr } from "./preprocess";

// Polyphonic audio → notes via Spotify's basic-pitch (Apache-2.0, free, runs
// fully in-browser on TensorFlow.js — no server, no API key).
//
// TF.js evaluateModel runs on the main thread (needs WebGL/DOM) and yields
// between chunks — progress 0→100% is visible. The post-processing step
// (outputToNotesPoly etc.) is pure JS but synchronous; we yield briefly before
// it so the browser can repaint the status message before the brief freeze.

/** Public URL of the TF.js model (copied into public/basic-pitch-model/). */
export const BASIC_PITCH_MODEL_URL = "/basic-pitch-model/model.json";

/** basic-pitch requires mono audio at exactly this rate. */
const TARGET_SAMPLE_RATE = 22050;

export interface BasicPitchOptions {
  onsetThreshold?: number;
  frameThreshold?: number;
  minNoteFrames?: number;
  /** Drop notes with amplitude below this (0–1). Filters overtones and pedal
   *  re-triggers which basic-pitch detects at low amplitude. Default: 0.12. */
  velocityThreshold?: number;
  /** When true (default), any threshold left undefined is derived from the
   *  recording's measured SNR (see thresholdsForSnr). Set false to use the
   *  fixed legacy defaults instead. */
  adaptiveThresholds?: boolean;
  onProgress?: (pct: number) => void;
  onPostProcess?: () => void;
  signal?: AbortSignal;
}

/** Notes plus the raw per-pitch/per-frame posteriorgrams the CNN produced, so a
 *  caller can run score-informed grading (lib/scoreInformed.ts) without re-running
 *  the model. `frames`/`onsets` are [frame][88], pitch column 0 = MIDI 21. */
export interface PolyTranscription {
  notes: NoteEvent[];
  frames: number[][];
  onsets: number[][];
}

/**
 * Transcribe a polyphonic recording into note events.
 * Returns the decoded notes (sorted by onset then pitch, velocity = amplitude)
 * alongside the raw `frames`/`onsets` posteriorgrams for score-informed grading.
 */
export async function audioToNotesPoly(
  buffer: ArrayBuffer,
  opts: BasicPitchOptions = {}
): Promise<PolyTranscription> {
  // basic-pitch bundles its own @tensorflow/tfjs. Do NOT import tfjs ourselves —
  // a second copy re-registers every webgl kernel → "already registered" spam.
  const { BasicPitch } = await import("@spotify/basic-pitch");

  const { samples, sampleRate, metrics } = await preprocessAudio(buffer, {
    targetSampleRate: TARGET_SAMPLE_RATE,
  });
  const audioBuffer = samplesToAudioBuffer(samples, sampleRate);

  // SNR-adaptive thresholds: clean recordings get lower thresholds (catch quiet
  // notes), noisy ones get higher (suppress phantoms). Any threshold the caller
  // passes explicitly still wins. Disable with adaptiveThresholds:false.
  const adaptive = opts.adaptiveThresholds === false
    ? { onsetThreshold: 0.5, frameThreshold: 0.3, velocityThreshold: 0.12 }
    : thresholdsForSnr(metrics.snrDb);
  console.log(
    `[basic-pitch] preprocess: noiseFloor=${metrics.noiseFloorDb.toFixed(1)}dB ` +
    `signal=${metrics.signalDb.toFixed(1)}dB SNR=${metrics.snrDb.toFixed(1)}dB ` +
    `gated=${(metrics.gatedFraction * 100).toFixed(0)}% → ` +
    `onset=${adaptive.onsetThreshold} frame=${adaptive.frameThreshold} vel=${adaptive.velocityThreshold}`
  );

  console.log("[basic-pitch] evaluateModel start, duration:", audioBuffer.duration.toFixed(1), "s");
  const basicPitch = new BasicPitch(BASIC_PITCH_MODEL_URL);
  const frames: number[][] = [];
  const onsets: number[][] = [];
  const contours: number[][] = [];

  await basicPitch.evaluateModel(
    audioBuffer,
    (f: number[][], o: number[][], c: number[][]) => {
      frames.push(...f);
      onsets.push(...o);
      contours.push(...c);
    },
    (pct: number) => {
      if (opts.signal?.aborted) throw new Error("cancelled");
      console.log(`[basic-pitch] ${Math.round(pct * 100)}%`);
      opts.onProgress?.(pct);
    }
  );

  console.log(`[basic-pitch] evaluateModel done — frames=${frames.length}`);

  opts.onPostProcess?.();

  const onsetThreshold = opts.onsetThreshold ?? adaptive.onsetThreshold;
  const frameThreshold = opts.frameThreshold ?? adaptive.frameThreshold;
  const minNoteFrames = opts.minNoteFrames ?? 11;
  const velThreshold = opts.velocityThreshold ?? adaptive.velocityThreshold;

  // Off-load pure-JS note decoding to a worker (no TF.js in that worker —
  // functions are inlined from toMidi.js, so no import hang).
  console.log("[basic-pitch] sending to noteDecoder worker…");
  return new Promise<PolyTranscription>((resolve, reject) => {
    const worker = new Worker(
      new URL("./noteDecoder.worker.ts", import.meta.url),
      { type: "module" }
    );
    worker.onmessage = (e: MessageEvent) => {
      const msg = e.data as
        | { type: "done"; notes: NoteEvent[] }
        | { type: "error"; message: string };
      if (msg.type === "done") {
        const filtered = msg.notes.filter((n) => (n.velocity ?? 1) >= velThreshold);
        console.log(`[basic-pitch] worker done — ${msg.notes.length} notes, after velocity gate (≥${velThreshold}): ${filtered.length}`);
        worker.terminate();
        resolve({ notes: filtered, frames, onsets });
      } else {
        console.error("[basic-pitch] worker error:", msg.message);
        worker.terminate();
        reject(new Error(msg.message));
      }
    };
    worker.onerror = (ev) => {
      console.error("[basic-pitch] worker onerror:", ev);
      worker.terminate();
      reject(new Error(ev.message ?? "noteDecoder worker failed"));
    };
    worker.postMessage({ frames, onsets, contours, opts: { onsetThreshold, frameThreshold, minNoteFrames, melodiaTrick: false } });
  });
}
