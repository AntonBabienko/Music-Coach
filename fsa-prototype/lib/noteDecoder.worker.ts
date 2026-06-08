// Web Worker: pure-JS note decoding from basic-pitch probability arrays.
// Functions inlined from @spotify/basic-pitch/cjs/toMidi.js — no TF.js,
// no DOM APIs, safe to run in any worker context.

// ---- constants ---------------------------------------------------------------
const MIDI_OFFSET = 21;
const AUDIO_SAMPLE_RATE = 22050;
const FFT_HOP = 256;
const ANNOTATIONS_FPS = Math.floor(AUDIO_SAMPLE_RATE / FFT_HOP);
const ANNOT_N_FRAMES = ANNOTATIONS_FPS * 2;
const AUDIO_N_SAMPLES = AUDIO_SAMPLE_RATE * 2 - FFT_HOP;
const WINDOW_OFFSET =
  (FFT_HOP / AUDIO_SAMPLE_RATE) *
    (ANNOT_N_FRAMES - AUDIO_N_SAMPLES / FFT_HOP) +
  0.0018;
const MAX_FREQ_IDX = 87;
const CONTOURS_BINS_PER_SEMITONE = 3;
const ANNOTATIONS_BASE_FREQUENCY = 27.5;
const ANNOTATIONS_N_SEMITONES = 88;
const N_FREQ_BINS_CONTOURS = ANNOTATIONS_N_SEMITONES * CONTOURS_BINS_PER_SEMITONE;

// ---- helpers (verbatim from toMidi.js) ---------------------------------------
function argMax(arr: number[]): number | null {
  return arr.length === 0
    ? null
    : arr.reduce(
        (maxIndex, currentValue, index) =>
          arr[maxIndex] > currentValue ? maxIndex : index,
        -1
      );
}
const argMaxAxis1 = (arr: number[][]): (number | null)[] => arr.map((row) => argMax(row));

function whereGreaterThanAxis1(
  arr2d: number[][],
  threshold: number
): [number[], number[]] {
  const outputX: number[] = [];
  const outputY: number[] = [];
  for (let i = 0; i < arr2d.length; i++) {
    for (let j = 0; j < arr2d[i].length; j++) {
      if (arr2d[i][j] > threshold) {
        outputX.push(i);
        outputY.push(j);
      }
    }
  }
  return [outputX, outputY];
}

function meanStdDev(array: number[][]): [number, number] {
  const [sum, sumSquared, count] = array.reduce<[number, number, number]>(
    (prev, row) => {
      const [rowSum, rowSumsSquared, rowCount] = row.reduce<
        [number, number, number]
      >((p, value) => [p[0] + value, p[1] + value * value, p[2] + 1], [
        0, 0, 0,
      ]);
      return [prev[0] + rowSum, prev[1] + rowSumsSquared, prev[2] + rowCount];
    },
    [0, 0, 0]
  );
  const mean = sum / count;
  const std = Math.sqrt((1 / (count - 1)) * (sumSquared - (sum * sum) / count));
  return [mean, std];
}

function globalMax(array: number[][]): number {
  let max = 0;
  for (let i = 0; i < array.length; i++) {
    for (let j = 0; j < array[i].length; j++) {
      if (array[i][j] > max) max = array[i][j];
    }
  }
  return max;
}

function min3dForAxis0(array: number[][][]): number[][] {
  const minArray = array[0].map((v) => v.slice());
  for (let x = 1; x < array.length; ++x) {
    for (let y = 0; y < array[0].length; ++y) {
      for (let z = 0; z < array[0][0].length; ++z) {
        minArray[y][z] = Math.min(minArray[y][z], array[x][y][z]);
      }
    }
  }
  return minArray;
}

function max3dForAxis0(array: number[][][]): number[][] {
  const maxArray = array[0].map((v) => v.slice());
  for (let x = 1; x < array.length; ++x) {
    for (let y = 0; y < array[0].length; ++y) {
      for (let z = 0; z < array[0][0].length; ++z) {
        maxArray[y][z] = Math.max(maxArray[y][z], array[x][y][z]);
      }
    }
  }
  return maxArray;
}

function argRelMax(array: number[][], order = 1): [number, number][] {
  const result: [number, number][] = [];
  for (let col = 0; col < array[0].length; ++col) {
    for (let row = 0; row < array.length; ++row) {
      let isRelMax = true;
      for (
        let comparisonRow = Math.max(0, row - order);
        isRelMax && comparisonRow <= Math.min(array.length - 1, row + order);
        ++comparisonRow
      ) {
        if (comparisonRow !== row) {
          isRelMax = isRelMax && array[row][col] > array[comparisonRow][col];
        }
      }
      if (isRelMax) result.push([row, col]);
    }
  }
  return result;
}

function constrainFrequency(
  onsets: number[][],
  frames: number[][],
  maxFreq: number | null,
  minFreq: number | null
) {
  const hzToMidi = (hz: number) =>
    12 * (Math.log2(hz) - Math.log2(440.0)) + 69;
  if (maxFreq) {
    const maxFreqIdx = hzToMidi(maxFreq) - MIDI_OFFSET;
    for (let i = 0; i < onsets.length; i++) onsets[i].fill(0, maxFreqIdx);
    for (let i = 0; i < frames.length; i++) frames[i].fill(0, maxFreqIdx);
  }
  if (minFreq) {
    const minFreqIdx = hzToMidi(minFreq) - MIDI_OFFSET;
    for (let i = 0; i < onsets.length; i++) onsets[i].fill(0, 0, minFreqIdx);
    for (let i = 0; i < frames.length; i++) frames[i].fill(0, 0, minFreqIdx);
  }
}

function getInferredOnsets(
  onsets: number[][],
  frames: number[][],
  nDiff = 2
): number[][] {
  const diffs = Array.from(Array(nDiff).keys())
    .map((n) => n + 1)
    .map((n) => {
      const framesAppended = Array(n)
        .fill(Array(frames[0].length).fill(0))
        .concat(frames);
      const nPlus = framesAppended.slice(n);
      const minusN = framesAppended.slice(0, -n);
      return nPlus.map((row: number[], r: number) =>
        row.map((v: number, c: number) => v - minusN[r][c])
      );
    });
  let frameDiff = min3dForAxis0(diffs);
  frameDiff = frameDiff.map((row) => row.map((v) => Math.max(v, 0)));
  frameDiff = frameDiff.map((row, r) => (r < nDiff ? row.fill(0) : row));
  const onsetMax = globalMax(onsets);
  const frameDiffMax = globalMax(frameDiff);
  frameDiff = frameDiff.map((row) =>
    row.map((v) => (onsetMax * v) / frameDiffMax)
  );
  return max3dForAxis0([onsets, frameDiff]);
}

interface NoteFrames {
  startFrame: number;
  durationFrames: number;
  pitchMidi: number;
  amplitude: number;
  pitchBends?: (number | null)[];
}

function outputToNotesPolyLocal(
  frames: number[][],
  onsets: number[][],
  onsetThresh = 0.5,
  frameThresh = 0.3,
  minNoteLen = 5,
  inferOnsets = false,
  maxFreq: number | null = null,
  minFreq: number | null = null,
  melodiaTrick = false, // disabled: O(notes×frames) loop froze the tab on long audio
  energyTolerance = 11
): NoteFrames[] {
  let inferredFrameThresh = frameThresh;
  if (inferredFrameThresh === null) {
    const [mean, std] = meanStdDev(frames);
    inferredFrameThresh = mean + std;
  }
  const nFrames = frames.length;
  constrainFrequency(onsets, frames, maxFreq, minFreq);
  let inferredOnsets = onsets;
  if (inferOnsets) inferredOnsets = getInferredOnsets(onsets, frames);

  const peakThresholdMatrix = inferredOnsets.map((o) => o.map(() => 0));
  argRelMax(inferredOnsets).forEach(([row, col]) => {
    peakThresholdMatrix[row][col] = inferredOnsets[row][col];
  });
  const [noteStarts, freqIdxs] = whereGreaterThanAxis1(
    peakThresholdMatrix,
    onsetThresh
  );
  noteStarts.reverse();
  freqIdxs.reverse();
  const remainingEnergy = frames.map((frame) => frame.slice());
  const noteEvents: NoteFrames[] = noteStarts
    .map((noteStartIdx, idx) => {
      const freqIdx = freqIdxs[idx];
      if (noteStartIdx >= nFrames - 1) return null;
      let i = noteStartIdx + 1;
      let k = 0;
      while (i < nFrames - 1 && k < energyTolerance) {
        if (remainingEnergy[i][freqIdx] < inferredFrameThresh) k += 1;
        else k = 0;
        i += 1;
      }
      i -= k;
      if (i - noteStartIdx <= minNoteLen) return null;
      for (let j = noteStartIdx; j < i; ++j) {
        remainingEnergy[j][freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) remainingEnergy[j][freqIdx + 1] = 0;
        if (freqIdx > 0) remainingEnergy[j][freqIdx - 1] = 0;
      }
      const amplitude =
        frames.slice(noteStartIdx, i).reduce((prev, row) => prev + row[freqIdx], 0) /
        (i - noteStartIdx);
      return { startFrame: noteStartIdx, durationFrames: i - noteStartIdx, pitchMidi: freqIdx + MIDI_OFFSET, amplitude };
    })
    .filter((n): n is NoteFrames => n !== null);

  if (melodiaTrick) {
    while (globalMax(remainingEnergy) > inferredFrameThresh) {
      const [iMid, freqIdx] = remainingEnergy.reduce<[number, number]>(
        (prevCoord, currRow, rowIdx) => {
          const colMaxIdx = argMax(currRow) ?? 0;
          return currRow[colMaxIdx] > remainingEnergy[prevCoord[0]][prevCoord[1]]
            ? [rowIdx, colMaxIdx]
            : prevCoord;
        },
        [0, 0]
      );
      remainingEnergy[iMid][freqIdx] = 0;
      let i = iMid + 1;
      let k = 0;
      while (i < nFrames - 1 && k < energyTolerance) {
        if (remainingEnergy[i][freqIdx] < inferredFrameThresh) k += 1;
        else k = 0;
        remainingEnergy[i][freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) remainingEnergy[i][freqIdx + 1] = 0;
        if (freqIdx > 0) remainingEnergy[i][freqIdx - 1] = 0;
        i += 1;
      }
      const iEnd = i - 1 - k;
      i = iMid - 1;
      k = 0;
      while (i > 0 && k < energyTolerance) {
        if (remainingEnergy[i][freqIdx] < inferredFrameThresh) k += 1;
        else k = 0;
        remainingEnergy[i][freqIdx] = 0;
        if (freqIdx < MAX_FREQ_IDX) remainingEnergy[i][freqIdx + 1] = 0;
        if (freqIdx > 0) remainingEnergy[i][freqIdx - 1] = 0;
        i -= 1;
      }
      const iStart = i + 1 + k;
      const amplitude =
        frames.slice(iStart, iEnd).reduce((sum, row) => sum + row[freqIdx], 0) /
        (iEnd - iStart);
      if (iEnd - iStart > minNoteLen)
        noteEvents.push({ startFrame: iStart, durationFrames: iEnd - iStart, pitchMidi: freqIdx + MIDI_OFFSET, amplitude });
    }
  }
  return noteEvents;
}

const midiToHz = (midi: number) => 440.0 * 2.0 ** ((midi - 69.0) / 12.0);
const midiPitchToContourBin = (pitchMidi: number) =>
  12.0 * CONTOURS_BINS_PER_SEMITONE * Math.log2(midiToHz(pitchMidi) / ANNOTATIONS_BASE_FREQUENCY);
const gaussian = (M: number, std: number) =>
  Array.from(Array(M).keys()).map((n) =>
    Math.exp(((-1 * (n - (M - 1) / 2) ** 2) / (2 * std ** 2)))
  );
const modelFrameToTime = (frame: number) =>
  (frame * FFT_HOP) / AUDIO_SAMPLE_RATE -
  WINDOW_OFFSET * Math.floor(frame / ANNOT_N_FRAMES);

function addPitchBendsLocal(contours: number[][], notes: NoteFrames[], nBinsTolerance = 25): NoteFrames[] {
  const windowLength = nBinsTolerance * 2 + 1;
  const freqGaussian = gaussian(windowLength, 5);
  return notes.map((note) => {
    const freqIdx = Math.floor(Math.round(midiPitchToContourBin(note.pitchMidi)));
    const freqStartIdx = Math.max(freqIdx - nBinsTolerance, 0);
    const freqEndIdx = Math.min(N_FREQ_BINS_CONTOURS, freqIdx + nBinsTolerance + 1);
    const freqGaussianSubMatrix = freqGaussian.slice(
      Math.max(0, nBinsTolerance - freqIdx),
      windowLength - Math.max(0, freqIdx - (N_FREQ_BINS_CONTOURS - nBinsTolerance - 1))
    );
    const pitchBendSubmatrix = contours
      .slice(note.startFrame, note.startFrame + note.durationFrames)
      .map((d) =>
        d.slice(freqStartIdx, freqEndIdx).map((v, col) => v * freqGaussianSubMatrix[col])
      );
    const pbShift = nBinsTolerance - Math.max(0, nBinsTolerance - freqIdx);
    const bends = argMaxAxis1(pitchBendSubmatrix).map((v) => (v ?? 0) - pbShift);
    return { ...note, pitchBends: bends };
  });
}

function noteFramesToTimeLocal(notes: NoteFrames[]) {
  return notes.map((note) => ({
    pitchMidi: note.pitchMidi,
    amplitude: note.amplitude,
    pitchBends: note.pitchBends,
    startTimeSeconds: modelFrameToTime(note.startFrame),
    durationSeconds:
      modelFrameToTime(note.startFrame + note.durationFrames) -
      modelFrameToTime(note.startFrame),
  }));
}

// ---- worker entry ------------------------------------------------------------
import type { NoteEvent } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = self as any;

ctx.onmessage = (e: MessageEvent) => {
  const { frames, onsets, contours, opts } = e.data as {
    frames: number[][];
    onsets: number[][];
    contours: number[][];
    opts: { onsetThreshold: number; frameThreshold: number; minNoteFrames: number; melodiaTrick?: boolean };
  };
  try {
    const rawNotes = outputToNotesPolyLocal(
      frames, onsets, opts.onsetThreshold, opts.frameThreshold, opts.minNoteFrames,
      false, null, null, opts.melodiaTrick ?? true
    );
    const withBends = addPitchBendsLocal(contours, rawNotes);
    const timed = noteFramesToTimeLocal(withBends);

    const notes: NoteEvent[] = timed
      .map((ev) => ({
        midi: ev.pitchMidi,
        onsetSec: ev.startTimeSeconds,
        durationSec: ev.durationSeconds,
        velocity: ev.amplitude,
      }))
      .sort((a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi);

    ctx.postMessage({ type: "done", notes });
  } catch (err) {
    ctx.postMessage({ type: "error", message: (err as Error).message });
  }
};
