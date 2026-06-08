import type { NoteEvent } from "./types";
import { getAudioContextClass } from "./audioContext";

// Fast monophonic pitch detection using pitchy (McLeod Pitch Method).
// Processes 30s audio in ~200ms vs basic-pitch's 3-10 minutes.
// Trade-off: monophonic only — detects dominant pitch per frame.
// For polyphonic piano (chords), only the loudest pitch is captured.

const TARGET_SR = 22050;
const FRAME_SIZE = 2048;  // ~93ms
const HOP_SIZE = 512;     // ~23ms hop
const CLARITY_MIN = 0.85; // below this = silence/noise
const MIN_NOTE_SEC = 0.08;
const YIELD_EVERY = 100;  // frames between UI yields

function freqToMidi(freq: number): number {
  return Math.round(12 * Math.log2(freq / 440) + 69);
}

async function decodeToMono(buffer: ArrayBuffer): Promise<Float32Array> {
  const ctx = new (getAudioContextClass())();
  let decoded: AudioBuffer;
  try {
    decoded = await ctx.decodeAudioData(buffer.slice(0));
  } finally {
    void ctx.close();
  }
  const length = Math.ceil(decoded.duration * TARGET_SR);
  const offline = new OfflineAudioContext(1, Math.max(1, length), TARGET_SR);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

export interface FastPitchOptions {
  onProgress?: (pct: number) => void;
  signal?: AbortSignal;
}

export async function audioToNotesMono(
  buffer: ArrayBuffer,
  opts: FastPitchOptions = {}
): Promise<NoteEvent[]> {
  const { PitchDetector } = await import("pitchy");

  opts.onProgress?.(0);
  const samples = await decodeToMono(buffer);
  const numFrames = Math.max(0, Math.floor((samples.length - FRAME_SIZE) / HOP_SIZE));

  const detector = PitchDetector.forFloat32Array(FRAME_SIZE);
  const frame = new Float32Array(FRAME_SIZE);
  const midiSeq: (number | null)[] = [];

  for (let fi = 0; fi < numFrames; fi++) {
    if (opts.signal?.aborted) throw new Error("cancelled");

    frame.set(samples.subarray(fi * HOP_SIZE, fi * HOP_SIZE + FRAME_SIZE));
    const [pitch, clarity] = detector.findPitch(frame, TARGET_SR);

    if (clarity >= CLARITY_MIN && pitch > 60 && pitch < 4200) {
      const midi = freqToMidi(pitch);
      midiSeq.push(midi >= 21 && midi <= 108 ? midi : null);
    } else {
      midiSeq.push(null);
    }

    if (fi % YIELD_EVERY === 0) {
      opts.onProgress?.((fi + 1) / numFrames);
      await new Promise<void>((r) => setTimeout(r, 0));
    }
  }
  opts.onProgress?.(1);

  // Median smooth over ±2 frames to suppress single-frame glitches.
  const smoothed: (number | null)[] = midiSeq.map((_, fi) => {
    const win: number[] = [];
    for (let d = -2; d <= 2; d++) {
      const v = midiSeq[fi + d];
      if (v !== null && v !== undefined) win.push(v);
    }
    if (win.length === 0) return null;
    win.sort((a, b) => a - b);
    return win[Math.floor(win.length / 2)];
  });

  // Segment into note events by MIDI change or silence gap.
  const notes: NoteEvent[] = [];
  let runStart = 0;
  let runMidi = smoothed[0];

  for (let fi = 1; fi <= smoothed.length; fi++) {
    const midi = fi < smoothed.length ? smoothed[fi] : null;
    if (midi !== runMidi) {
      if (runMidi !== null) {
        const onsetSec = (runStart * HOP_SIZE) / TARGET_SR;
        const durationSec = ((fi - runStart) * HOP_SIZE) / TARGET_SR;
        if (durationSec >= MIN_NOTE_SEC) {
          notes.push({ midi: runMidi, onsetSec, durationSec });
        }
      }
      runStart = fi;
      runMidi = midi;
    }
  }

  return notes;
}
