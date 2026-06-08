import type {
  AlignStep,
  CompareCounts,
  CompareResult,
  NoteEvent,
  Timing,
} from "./types";

// Mirrors lib/constants.ts. Inlined so this module imports nothing at runtime
// and loads identically under Next (Turbopack) and the Node eval harness
// (--experimental-strip-types, which needs explicit extensions on real imports).
const DEFAULT_NOTE_DURATION_SEC = 0.4;

// ─────────────────────────────────────────────────────────────────────────────
// Score-informed grading.
//
// The classic compare() path transcribes audio into a note list with a single
// global threshold, then DTW-aligns two note SEQUENCES. That throws away two
// things we actually have: (1) the score, which tells us exactly which pitch
// should sound when, and (2) basic-pitch's raw per-pitch/per-frame posterior-
// grams (`frames`, `onsets`), which hold sub-threshold evidence the note
// decoder discards.
//
// This module keeps the score as a localization PRIOR only — it tells us WHERE
// and WHAT pitch to look for — and then asks the audio posteriorgram whether
// the note is actually there. A reference note is only ever marked "match" when
// there is real onset/frame energy AT ITS OWN PITCH near its (warp-aligned)
// time. We never fill a note in from the score alone, so a student's genuine
// mistakes (missed / wrong notes) survive the prior instead of being masked.
//
// Pipeline:
//   1. align score-time → audio-frame with a DTW warp over pitch activations
//      (score pianoroll vs. the `frames` posteriorgram), so rubato / tempo
//      drift no longer smears the per-note time windows.
//   2. grade each reference note from posteriorgram evidence in its window
//      (match / wrong / missed), using a LOWER local threshold than the global
//      decoder can afford — justified because we know precisely where to listen.
//   3. detect onset peaks the score does not explain → "extra" (overtone- and
//      octave-suppressed so piano harmonics are not counted as wrong notes).
// ─────────────────────────────────────────────────────────────────────────────

const MIDI_OFFSET = 21;          // posteriorgram column 0 == MIDI 21 (A0)
const N_PITCH = 88;
const SR = 22050;
const FFT_HOP = 256;
const FPS = SR / FFT_HOP;        // ≈ 86.13 frames/sec

/** Pooling factor for the alignment DTW. Full rate (~86 fps) makes the cost
 *  matrix quadratic and huge; pooling to ~14 fps keeps it tractable while still
 *  localizing each note to ~70 ms — well inside the per-note onset window. */
const POOL = 6;

/** Frames a candidate note must sustain after its onset to count as real, not a
 *  transient spike. Matches basic-pitch's minNoteFrames default. */
const SUSTAIN_FRAMES = 11;

/** Off-score gate: flagged when the aligned match rate barely beats the chance
 *  baseline (alignmentConfidence = matchRate/(chanceRate+0.05) below this). A
 *  correct take — even hard or noisy — beats chance many-fold; a different piece
 *  sits near 1. Confidence (a ratio) generalizes across SNR where an absolute
 *  match-rate floor does not, because noise inflates both rates together. */
const OFFSCORE_CONFIDENCE_MAX = 2.5;

/** Foreign-pitch offsets probed at each note's aligned time to estimate the
 *  off-score chance baseline. Tritone/fourth — dissonant enough to be rare in
 *  the actual harmony of a correct take, so they stay near-silent there. */
const NULL_SHIFTS = [-6, -5, 5, 6];

export interface ScoreInformedOptions {
  /** Onset-posterior peak above which a reference pitch counts as struck.
   *  Lower than the global decoder's onset gate because the score has already
   *  told us which pitch/time to inspect. */
  onsetThreshold?: number;
  /** Mean frame-posterior over the sustain window above which a reference pitch
   *  counts as sounding even if its onset peak was missed (legato / soft attack). */
  frameThreshold?: number;
  /** Onset-posterior peak above which an UNEXPECTED pitch is reported as an
   *  extra/wrong note. Kept higher than onsetThreshold so sub-threshold haze
   *  inflates neither false positives nor the precision denominator. */
  extraThreshold?: number;
  /** Half-width of the onset search window, in seconds (audio time). */
  onsetTolSec?: number;
  /** Half-width of the window within which an in-score pitch suppresses a
   *  "wrong"/"extra" classification. Wider than onsetTolSec to absorb warp
   *  drift on dense polyphony. */
  classifyTolSec?: number;
  /** Detect a global pitch transposition (capo, vocal key shift, concert-vs-
   *  written mismatch) between score and recording and grade relative to it,
   *  instead of flagging every note as wrong. On by default. */
  autoTranspose?: boolean;
  /** Largest |semitone| transposition autoTranspose will consider. */
  maxTransposeSemitones?: number;
  /** Diagnostic: bypass the DTW warp and map score-time → audio-time linearly
   *  (audioFrames / scoreFrames). Used to isolate warp-quality regressions. */
  linearWarp?: boolean;
}

type ThresholdOptions = Omit<ScoreInformedOptions, "linearWarp" | "autoTranspose">;

const DEFAULTS: Required<ThresholdOptions> = {
  onsetThreshold: 0.3,
  frameThreshold: 0.2,
  extraThreshold: 0.5,
  onsetTolSec: 0.12,
  classifyTolSec: 0.25,
  maxTransposeSemitones: 6,
};

type Matrix = number[][]; // [frame][pitch], length N_PITCH per row

// ---- pooling + normalization ------------------------------------------------

function l2normRow(v: Float32Array): void {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i] * v[i];
  s = Math.sqrt(s);
  if (s > 0) for (let i = 0; i < v.length; i++) v[i] /= s;
}

/** Mean-pool a posteriorgram by POOL frames and L2-normalize each pooled row. */
function poolPosteriorgram(m: Matrix): Float32Array[] {
  const nFull = m.length;
  const nPool = Math.max(1, Math.ceil(nFull / POOL));
  const out: Float32Array[] = [];
  for (let pf = 0; pf < nPool; pf++) {
    const v = new Float32Array(N_PITCH);
    const f0 = pf * POOL;
    const f1 = Math.min(nFull, f0 + POOL);
    for (let f = f0; f < f1; f++) {
      const row = m[f];
      for (let p = 0; p < N_PITCH; p++) v[p] += row[p];
    }
    const denom = f1 - f0;
    for (let p = 0; p < N_PITCH; p++) v[p] /= denom;
    l2normRow(v);
    out.push(v);
  }
  return out;
}

/** Build a pooled, L2-normalized pitch-activation matrix from score notes.
 *  Onset frames get extra weight so the DTW latches onto attacks. */
function poolScoreRoll(notes: NoteEvent[]): Float32Array[] {
  let endFrame = 1;
  for (const n of notes) {
    const e = Math.round((n.onsetSec + (n.durationSec ?? DEFAULT_NOTE_DURATION_SEC)) * FPS);
    if (e > endFrame) endFrame = e;
  }
  const nPool = Math.max(1, Math.ceil(endFrame / POOL));
  const rows: Float32Array[] = Array.from({ length: nPool }, () => new Float32Array(N_PITCH));
  for (const n of notes) {
    const p = n.midi - MIDI_OFFSET;
    if (p < 0 || p >= N_PITCH) continue;
    const s = Math.round(n.onsetSec * FPS);
    const e = Math.round((n.onsetSec + (n.durationSec ?? DEFAULT_NOTE_DURATION_SEC)) * FPS);
    const sp = Math.min(nPool - 1, Math.floor(s / POOL));
    const ep = Math.min(nPool, Math.ceil(e / POOL));
    for (let f = sp; f < ep; f++) rows[f][p] += 1;
    rows[sp][p] += 1; // onset emphasis
  }
  for (const r of rows) l2normRow(r);
  return rows;
}

// ---- DTW warp (score pooled frame → audio pooled frame) ---------------------

const MOVE_DIAG = 0, MOVE_UP = 1, MOVE_LEFT = 2;

/**
 * Open-ended DTW between the score roll and the audio posteriorgram (both
 * pooled, L2-normalized). "Open-ended" = the alignment may consume the whole
 * audio while stopping at score row `endRow` < N, leaving the score suffix
 * unaligned. This is what lets us recognize a performance that STOPPED EARLY:
 * the unplayed tail is reported as not-attempted instead of being compressed
 * onto the recording's end (which corrupts both the tail and the played part).
 *
 * Returns the per-row warp (median matched audio frame) and `endRow`, the last
 * score pooled frame the performance actually reached.
 */
function dtwWarp(ref: Float32Array[], audio: Float32Array[]): { warp: Int32Array; endRow: number } {
  const N = ref.length;
  const M = audio.length;
  const cost = (i: number, j: number) => {
    const a = ref[i], b = audio[j];
    let d = 0;
    for (let p = 0; p < N_PITCH; p++) d += a[p] * b[p];
    return 1 - d; // both L2-normalized → 1 - cosine similarity
  };

  // Rolling cost rows + a full backpointer matrix for path recovery. `lastCol`
  // keeps D[r][M-1] for every row so we can pick the best open end point.
  const back = new Uint8Array(N * M);
  const lastCol = new Float64Array(N);
  let prev = new Float64Array(M);
  let curr = new Float64Array(M);

  prev[0] = cost(0, 0);
  for (let j = 1; j < M; j++) { prev[j] = prev[j - 1] + cost(0, j); back[j] = MOVE_LEFT; }
  lastCol[0] = prev[M - 1];

  for (let i = 1; i < N; i++) {
    curr[0] = prev[0] + cost(i, 0);
    back[i * M] = MOVE_UP;
    for (let j = 1; j < M; j++) {
      const c = cost(i, j);
      const diag = prev[j - 1];
      const up = prev[j];
      const left = curr[j - 1];
      let best = diag, mv = MOVE_DIAG;
      if (up < best) { best = up; mv = MOVE_UP; }
      if (left < best) { best = left; mv = MOVE_LEFT; }
      curr[j] = c + best;
      back[i * M + j] = mv;
    }
    lastCol[i] = curr[M - 1];
    const t = prev; prev = curr; curr = t;
  }

  // Open end: the score row that best aligns to the FULL audio. Normalize by row
  // index so stopping early is only chosen when it genuinely lowers per-row cost
  // (a full-length performance lands at endRow = N-1, i.e. no truncation).
  let endRow = N - 1, bestNorm = Infinity;
  for (let r = 0; r < N; r++) {
    const norm = lastCol[r] / (r + 1);
    if (norm < bestNorm) { bestNorm = norm; endRow = r; }
  }

  // Backtrack from (endRow, M-1).
  const sum = new Float64Array(N);
  const cnt = new Int32Array(N);
  let i = endRow, j = M - 1;
  while (i > 0 || j > 0) {
    sum[i] += j; cnt[i]++;
    const mv = back[i * M + j];
    if (i === 0) j--;
    else if (j === 0) i--;
    else if (mv === MOVE_DIAG) { i--; j--; }
    else if (mv === MOVE_UP) i--;
    else j--;
  }
  sum[0] += j; cnt[0]++;

  const warp = new Int32Array(N);
  let last = 0;
  for (let r = 0; r < N; r++) {
    warp[r] = cnt[r] > 0 ? Math.round(sum[r] / cnt[r]) : last;
    last = warp[r];
  }
  return { warp, endRow };
}

// ---- evidence probes --------------------------------------------------------

/** Peak onset posterior at pitch column `p` over audio frames [f0, f1], plus
 *  the frame at which it occurred (for timing). */
function onsetPeak(onsets: Matrix, p: number, f0: number, f1: number): { val: number; frame: number } {
  let val = 0, frame = f0;
  const lo = Math.max(0, f0), hi = Math.min(onsets.length - 1, f1);
  for (let f = lo; f <= hi; f++) {
    const v = onsets[f][p];
    if (v > val) { val = v; frame = f; }
  }
  return { val, frame };
}

/** Is the onset at (frame, p) a local maximum ACROSS PITCH? A note one semitone
 *  away (the "wrong note read as right" case) leaks some onset energy into the
 *  neighbouring bin, but its own bin is stronger — so a leaked onset fails this. */
function isPitchLocalMax(onsets: Matrix, frame: number, p: number): boolean {
  if (frame < 0 || frame >= onsets.length) return false;
  const row = onsets[frame];
  const v = row[p];
  if (p > 0 && row[p - 1] > v) return false;
  if (p < N_PITCH - 1 && row[p + 1] > v) return false;
  return true;
}

/** Mean frame posterior at pitch column `p` over the sustain window. */
function frameMean(frames: Matrix, p: number, f0: number, f1: number): number {
  const lo = Math.max(0, f0), hi = Math.min(frames.length - 1, f1);
  if (hi < lo) return 0;
  let s = 0;
  for (let f = lo; f <= hi; f++) s += frames[f][p];
  return s / (hi - lo + 1);
}

const PITCH_CLASS_EQ = (a: number, b: number) => ((a - b) % 12 + 12) % 12 === 0;
// Piano overtone intervals above a fundamental (octave, octave+fifth, two
// octaves) — an unexpected peak this far above a concurrently-expected pitch is
// almost certainly a harmonic, not a played note.
const OVERTONES = [12, 19, 24];

// ---- global transposition detection -----------------------------------------

/**
 * Estimate a global semitone transposition between the score and the recording
 * by cross-correlating their pitch-class profiles. Returns the shift `s` such
 * that audio pitch ≈ score pitch + s (a capo, a vocal key change, or a
 * concert-vs-written mismatch). Without this, a whole performance in another key
 * reads as ~100% wrong notes instead of a single global observation.
 */
export function detectTranspose(refNotes: NoteEvent[], frames: Matrix, maxSemitones: number): number {
  const refPC = new Float64Array(12);
  for (const n of refNotes) refPC[((n.midi % 12) + 12) % 12] += 1;

  const audioPC = new Float64Array(12);
  for (let f = 0; f < frames.length; f++) {
    const row = frames[f];
    for (let p = 0; p < N_PITCH; p++) audioPC[(p + MIDI_OFFSET) % 12] += row[p];
  }

  const norm = (v: Float64Array) => {
    let s = 0;
    for (let i = 0; i < 12; i++) s += v[i] * v[i];
    s = Math.sqrt(s) || 1;
    for (let i = 0; i < 12; i++) v[i] /= s;
  };
  norm(refPC);
  norm(audioPC);

  let bestS = 0, bestScore = -Infinity;
  for (let s = -maxSemitones; s <= maxSemitones; s++) {
    let dot = 0;
    for (let pc = 0; pc < 12; pc++) dot += refPC[pc] * audioPC[(((pc + s) % 12) + 12) % 12];
    // Prefer the zero shift on ties so in-key performances are never nudged.
    if (dot > bestScore + 1e-9 || (Math.abs(dot - bestScore) <= 1e-9 && s === 0)) {
      bestScore = dot; bestS = s;
    }
  }
  return bestS;
}

// ---- public API -------------------------------------------------------------

/**
 * Grade a performance recording against a reference score using basic-pitch's
 * raw posteriorgrams, with the score as a localization prior. Returns the same
 * CompareResult shape as compare() so the UI, feedback and eval all work
 * unchanged.
 */
export function scoreInformedCompare(
  refNotes: NoteEvent[],
  frames: Matrix,
  onsets: Matrix,
  options: ScoreInformedOptions = {}
): CompareResult {
  // Coalesce: an explicit `undefined` in `options` must not clobber a default.
  const opt: Required<ThresholdOptions> = {
    onsetThreshold: options.onsetThreshold ?? DEFAULTS.onsetThreshold,
    frameThreshold: options.frameThreshold ?? DEFAULTS.frameThreshold,
    extraThreshold: options.extraThreshold ?? DEFAULTS.extraThreshold,
    onsetTolSec: options.onsetTolSec ?? DEFAULTS.onsetTolSec,
    classifyTolSec: options.classifyTolSec ?? DEFAULTS.classifyTolSec,
    maxTransposeSemitones: options.maxTransposeSemitones ?? DEFAULTS.maxTransposeSemitones,
  };
  const n = refNotes.length;
  const F = frames.length;

  // 0) global transposition ------------------------------------------------
  // A performance in another key (capo / vocal range / written-vs-concert) is a
  // single observation, not 1500 wrong notes. Detect the shift and grade every
  // pitch probe relative to it; `work` carries the transposed expected pitches.
  const shift = options.autoTranspose === false
    ? 0
    : detectTranspose(refNotes, frames, opt.maxTransposeSemitones);
  const work = shift === 0 ? refNotes : refNotes.map((nn) => ({ ...nn, midi: nn.midi + shift }));

  // Sort a working copy by onset so warp lookups stay monotonic.
  const ref = work
    .map((note, i) => ({ note, i }))
    .sort((a, b) => a.note.onsetSec - b.note.onsetSec || a.note.midi - b.note.midi);

  // 1) score-time → audio-frame warp ----------------------------------------
  const scoreRoll = poolScoreRoll(work);
  const audioPooled = poolPosteriorgram(frames);
  const { warp: warpPooled, endRow } = dtwWarp(scoreRoll, audioPooled);
  const refPoolLen = scoreRoll.length;
  if (options.linearWarp) {
    const A = audioPooled.length;
    for (let r = 0; r < refPoolLen; r++) {
      warpPooled[r] = Math.round((r / Math.max(1, refPoolLen - 1)) * (A - 1));
    }
  }
  // Score pooled frames past `endRow` were never reached by the performance
  // (stopped early) → those reference notes are not-attempted, not mistakes.
  const notAttemptedFrom = options.linearWarp ? refPoolLen : endRow + 1;
  if (typeof process !== "undefined" && process.env?.SI_DEBUG) {
    const A = audioPooled.length;
    let mono = 0;
    for (let r = 1; r < refPoolLen; r++) if (warpPooled[r] >= warpPooled[r - 1]) mono++;
    // Correlate warp against the naive linear map to see if DTW drifted.
    let devSum = 0;
    for (let r = 0; r < refPoolLen; r++) {
      const lin = (r / Math.max(1, refPoolLen - 1)) * (A - 1);
      devSum += Math.abs(warpPooled[r] - lin);
    }
    console.error(
      `[SI] transpose=${shift >= 0 ? "+" : ""}${shift} refPool=${refPoolLen} audioPool=${A} warp[0]=${warpPooled[0]} ` +
      `warp[end]=${warpPooled[refPoolLen - 1]} monoFrac=${(mono / (refPoolLen - 1)).toFixed(2)} ` +
      `meanDevFromLinear=${(devSum / refPoolLen).toFixed(1)} pooledFrames`
    );
  }
  const audioFromScoreFrame = (scoreFrameFull: number): number => {
    const rp = Math.max(0, Math.min(refPoolLen - 1, Math.floor(scoreFrameFull / POOL)));
    return Math.min(F - 1, warpPooled[rp] * POOL + (POOL >> 1));
  };

  const onsetTol = Math.max(1, Math.round(opt.onsetTolSec * FPS));
  // Classification tolerance is deliberately wider than the match-probe window:
  // the warp localizes a note to ~70 ms on clean material but drifts further on
  // dense, low-SNR polyphony. A real pitch landing just outside its onset window
  // must still suppress a false "wrong"/"extra", so expMask is padded by this
  // larger margin. (Match localization itself still uses the tight onsetTol.)
  const classifyTol = Math.max(onsetTol, Math.round(opt.classifyTolSec * FPS));

  // Expected-pitch occupancy mask: expMask[f*N_PITCH + p] = 1 when reference
  // pitch p is meant to be sounding at audio frame f (window-padded). This is
  // the prior that prevents two precision-killers: (a) a concurrent voice being
  // misread as a "wrong" note when another voice's pitch is momentarily missed,
  // and (b) a real (merely mislocalized) note being counted as "extra".
  const expMask = new Uint8Array(F * N_PITCH);
  const markExpected = (p: number, f0: number, f1: number) => {
    const lo = Math.max(0, f0 - classifyTol), hi = Math.min(F - 1, f1 + classifyTol);
    for (let f = lo; f <= hi; f++) expMask[f * N_PITCH + p] = 1;
  };
  const expectedNear = (p: number, frame: number) =>
    frame >= 0 && frame < F && expMask[frame * N_PITCH + p] === 1;
  // Octave/pitch-class equivalent of a real note sounding at this frame → the
  // peak is basic-pitch's octave slip of a genuine note, not a foreign pitch.
  const octaveEquivExpected = (p: number, frame: number) => {
    if (frame < 0 || frame >= F) return false;
    const pc = ((p % 12) + 12) % 12;
    const base = frame * N_PITCH;
    for (let q = pc; q < N_PITCH; q += 12) {
      if (q !== p && expMask[base + q] === 1) return true;
    }
    return false;
  };
  const isOvertone = (p: number, frame: number) => {
    if (frame < 0 || frame >= F) return false;
    const base = frame * N_PITCH;
    for (const h of OVERTONES) {
      const lower = p - h;
      if (lower >= 0 && expMask[base + lower] === 1) return true;
    }
    return false;
  };

  // ---- pass A: locate windows, fill expMask, settle matches ---------------
  type Pending = { i: number; midi: number; measure?: number; p: number; startFrame: number };
  const steps: AlignStep[] = [];
  const pending: Pending[] = [];
  let notAttempted = 0;
  // Chance baseline for off-score detection: probe FOREIGN pitches (a tritone /
  // fourth away) at the SAME aligned time as each expected note. A correct take
  // has the expected pitch present and the foreign ones absent → match ≫ chance;
  // an off-score take has them equally (im)present → match ≈ chance. Probing by
  // pitch (not by time) is essential: a time-shifted probe saturates in dense
  // polyphony — every pitch sounds somewhere — and falsely flags real choirs.
  let gradedProbed = 0, chanceHits = 0;

  for (const { note, i } of ref) {
    // Past the performance's reach (stopped early) → not a mistake; emit nothing.
    if (Math.floor(Math.round(note.onsetSec * FPS) / POOL) >= notAttemptedFrom) {
      notAttempted++;
      continue;
    }
    const p = note.midi - MIDI_OFFSET;
    if (p < 0 || p >= N_PITCH) {
      steps.push({ type: "missed", refIndex: i, refMidi: note.midi, measure: note.measure });
      continue;
    }
    const startFrame = audioFromScoreFrame(Math.round(note.onsetSec * FPS));
    const endScoreFrame = Math.round((note.onsetSec + (note.durationSec ?? DEFAULT_NOTE_DURATION_SEC)) * FPS);
    const endFrame = Math.max(startFrame + 1, audioFromScoreFrame(endScoreFrame));
    markExpected(p, startFrame, endFrame);

    // chance probe: foreign pitches at the SAME time, identical match criteria
    for (const sh of NULL_SHIFTS) {
      const q = p + sh;
      if (q < 0 || q >= N_PITCH) continue;
      const qpk = onsetPeak(onsets, q, startFrame - onsetTol, startFrame + onsetTol);
      const hit = (qpk.val >= opt.onsetThreshold && isPitchLocalMax(onsets, qpk.frame, q)) ||
        frameMean(frames, q, startFrame, endFrame) >= opt.frameThreshold;
      if (hit) chanceHits++;
      gradedProbed++;
    }

    const peak = onsetPeak(onsets, p, startFrame - onsetTol, startFrame + onsetTol);
    // A real attack fires an onset peak that is a local maximum ACROSS PITCH. A
    // wrong note played a semitone away only leaks partial onset energy into this
    // bin (its own bin is stronger) → fails this test → the expected note is not
    // falsely matched, and the wrong note is caught downstream. Measured on the
    // deviation corpus this is the main lift in clean-audio error recall, with
    // negligible cost to dense-polyphony recall on the real fixtures.
    const onsetOk = peak.val >= opt.onsetThreshold && isPitchLocalMax(onsets, peak.frame, p);
    // Legato / soft-attack fallback: sustained frame energy at the expected pitch.
    const sustainOk = frameMean(frames, p, startFrame, endFrame) >= opt.frameThreshold;

    if (onsetOk || sustainOk) {
      steps.push({
        type: "match",
        refIndex: i, perfIndex: i,
        refMidi: note.midi, perfMidi: note.midi,
        measure: note.measure,
        residualSec: (peak.frame - startFrame) / FPS,
      });
      continue;
    }
    pending.push({ i, midi: note.midi, measure: note.measure, p, startFrame });
  }

  // ---- pass B: classify unmatched ref notes (expMask now complete) --------
  // A "wrong" note requires a FOREIGN pitch (one the score never expects around
  // this time) struck where the expected pitch is silent. Concurrent in-score
  // pitches are excluded, so other SATB voices are never mistaken for mistakes.
  for (const pn of pending) {
    let bestP = -1, bestV = opt.onsetThreshold, bestFrame = pn.startFrame;
    for (let q = 0; q < N_PITCH; q++) {
      if (q === pn.p || expectedNear(q, pn.startFrame)) continue;
      if (PITCH_CLASS_EQ(q + MIDI_OFFSET, pn.midi)) continue; // octave slip handled below
      const pk = onsetPeak(onsets, q, pn.startFrame - onsetTol, pn.startFrame + onsetTol);
      // Require the foreign pitch to actually SUSTAIN like a note, not just spike
      // — a bare onset transient in noisy audio is not a played wrong note.
      if (pk.val > bestV && frameMean(frames, q, pk.frame, pk.frame + SUSTAIN_FRAMES) >= opt.frameThreshold) {
        bestV = pk.val; bestP = q; bestFrame = pk.frame;
      }
    }
    if (bestP >= 0) {
      // This foreign pitch IS the wrong note — claim it so the extra pass does
      // not also report the same audio event as an unexplained extra.
      markExpected(bestP, bestFrame, bestFrame);
      steps.push({
        type: "wrong",
        refIndex: pn.i, perfIndex: pn.i,
        refMidi: pn.midi, perfMidi: bestP + MIDI_OFFSET,
        measure: pn.measure,
      });
    } else {
      steps.push({ type: "missed", refIndex: pn.i, refMidi: pn.midi, measure: pn.measure });
    }
  }

  // ---- pass C: extra = onset peaks the score cannot explain ----------------
  // Suppressed: the note's own (possibly mislocalized) expected pitch, octave
  // slips of a real note, and piano overtones of a concurrently-expected pitch.
  // After collecting candidates, a second greedy pass removes overtones of already-
  // accepted extra peaks (stronger onset wins) so that harmonics of a played extra
  // note aren't counted as separate extra events.
  type ExtraCandidate = { midi: number; frame: number; v: number };
  const extraCandidates: ExtraCandidate[] = [];
  for (let p = 0; p < N_PITCH; p++) {
    for (let f = 1; f < F - 1; f++) {
      const v = onsets[f][p];
      if (v < opt.extraThreshold) continue;
      if (onsets[f - 1][p] >= v || onsets[f + 1][p] > v) continue; // local-max attack
      // Mirror the note decoder: a real note sustains for several frames after
      // its onset. This rejects the transient onset spikes that flood dense,
      // low-SNR audio and would otherwise inflate the false-positive count.
      if (frameMean(frames, p, f, f + SUSTAIN_FRAMES) < opt.frameThreshold) continue;
      if (expectedNear(p, f) || octaveEquivExpected(p, f) || isOvertone(p, f)) continue;
      extraCandidates.push({ midi: p + MIDI_OFFSET, frame: f, v });
    }
  }
  // Greedy overtone dedup: accept candidates in descending onset strength order.
  // A candidate that is a known harmonic interval (+12/+19/+24 semitones) above
  // an already-accepted extra within classifyTol frames is the same physical
  // string/key resonating — suppress it so one played extra counts as one event.
  extraCandidates.sort((a, b) => b.v - a.v);
  const acceptedExtras: ExtraCandidate[] = [];
  for (const cand of extraCandidates) {
    const isOvertoneOfAccepted = acceptedExtras.some((acc) => {
      if (Math.abs(cand.frame - acc.frame) > classifyTol) return false;
      for (const h of OVERTONES) {
        if (cand.midi === acc.midi + h) return true;
      }
      return false;
    });
    if (!isOvertoneOfAccepted) acceptedExtras.push(cand);
  }
  for (const { midi } of acceptedExtras) {
    steps.push({ type: "extra", perfMidi: midi });
  }

  // 4) timing classification over matched notes -----------------------------
  // Residuals are already relative to the warp, so they isolate per-note rush/
  // drag rather than global tempo. Use a fixed, musically reasonable gate.
  const LATE_THRESHOLD = 0.18;
  for (const s of steps) {
    if (s.type !== "match" || s.residualSec == null) continue;
    let timing: Timing = "on";
    if (s.residualSec > LATE_THRESHOLD) timing = "late";
    else if (s.residualSec < -LATE_THRESHOLD) timing = "early";
    s.timing = timing;
  }

  // Order steps by reference position (extras appended afterwards) so the UI's
  // step list reads roughly left-to-right.
  steps.sort((a, b) => {
    const ai = a.refIndex ?? Number.MAX_SAFE_INTEGER;
    const bi = b.refIndex ?? Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });

  // ---- tallies ------------------------------------------------------------
  const counts: CompareCounts = { match: 0, wrong: 0, missed: 0, extra: 0, late: 0, early: 0 };
  for (const s of steps) {
    counts[s.type]++;
    if (s.timing === "late") counts.late++;
    if (s.timing === "early") counts.early++;
  }

  const m = counts.match + counts.wrong + counts.extra; // detected events
  // Not-attempted notes (performance stopped early) are excluded from the
  // denominator: scores reflect what the player actually reached, not an
  // unfinished take read as a wall of missed notes.
  const graded = Math.max(0, n - notAttempted);
  const pitchAccuracy = graded > 0 ? (counts.match / graded) * 100 : 0;
  const onTimeCount = counts.match - counts.late - counts.early;
  const onTimeAccuracy = graded > 0 ? (onTimeCount / graded) * 100 : 0;
  const coverageAccuracy = graded > 0 ? ((counts.match + counts.wrong) / graded) * 100 : 0;

  // ---- off-score detection ------------------------------------------------
  // Compare the aligned match rate to the chance baseline. A correct take —
  // even noisy or hard to transcribe — matches far better than chance once
  // aligned+transposed; a different piece barely beats it. The +0.05 floor keeps
  // sparse audio (low chance) from inflating the ratio. Guard on size so a few
  // notes can't trip it.
  const matchRate = graded > 0 ? counts.match / graded : 0;
  const chanceRate = gradedProbed > 0 ? chanceHits / gradedProbed : 0;
  const alignmentConfidence = matchRate / (chanceRate + 0.05);
  const offScore = graded >= 8 && alignmentConfidence < OFFSCORE_CONFIDENCE_MAX;

  return {
    steps,
    counts,
    tempoRatio: 1,
    intercept: 0,
    timingR2: 0,
    timingResidualRatio: 0,
    pitchAccuracy,
    onTimeAccuracy,
    coverageAccuracy,
    refCount: graded,
    perfCount: m,
    offScore,
    alignmentConfidence,
    transposeSemitones: shift,
    notAttempted,
  };
}
