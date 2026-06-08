// Shared data model for the music comparison pipeline.

/** A single sounded note, used for both the reference (parsed from MusicXML)
 *  and the performance (parsed from a .mid file). */
export interface NoteEvent {
  /** MIDI pitch number (C4 = 60, A4 = 69). */
  midi: number;
  /** Onset time in seconds from the start of the piece. */
  onsetSec: number;
  /** Duration in seconds (optional; reference notes may omit it). */
  durationSec?: number;
  /** Velocity 0..1 (performance only). */
  velocity?: number;
  /** 1-based measure number (reference only). */
  measure?: number;
}

export type StepType = "match" | "wrong" | "missed" | "extra";
export type Timing = "on" | "late" | "early";

/** One aligned step produced by DTW backtracking. */
export interface AlignStep {
  type: StepType;
  refIndex?: number;
  perfIndex?: number;
  refMidi?: number;
  perfMidi?: number;
  measure?: number;
  /** Timing classification, only present on `match` steps. */
  timing?: Timing;
  /** perfSec - (a*refSec + b), only present on `match` steps. */
  residualSec?: number;
}

export interface CompareCounts {
  match: number;
  wrong: number;
  missed: number;
  extra: number;
  late: number;
  early: number;
}

export interface CompareResult {
  steps: AlignStep[];
  counts: CompareCounts;
  /** Least-squares slope a in perfSec = a*refSec + b. a>1 = played slower. */
  tempoRatio: number;
  /** Least-squares intercept b. */
  intercept: number;
  /** Coefficient of determination (R²) of the perfSec≈a*refSec+b fit over
   *  matched pairs, 0..1. Reported for display; note it can stay high even when
   *  the fit is semantically wrong (matches monotonic in time but off by many
   *  note positions), so the reliability gate uses timingResidualRatio instead. */
  timingR2: number;
  /** Median |timing residual| of matched notes divided by the median reference
   *  inter-onset interval. ~0 = matches sit on the tempo line; >>1 = matched
   *  notes deviate by many note-positions, so tempoRatio is not trustworthy. */
  timingResidualRatio: number;
  /** (match steps of any timing) / referenceNoteCount, as a percentage 0..100.
   *  Includes late and early matches — measures pitch correctness only. */
  pitchAccuracy: number;
  /** (match steps with timing="on") / referenceNoteCount, as a percentage 0..100.
   *  The strict metric: correct pitch AND correct timing.
   *  Late/early matches count as pitch-correct but timing-penalised (not included here). */
  onTimeAccuracy: number;
  /** (match + wrong) / referenceNoteCount, as a percentage 0..100.
   *  How many reference notes received ANY aligned perf note — even a wrong pitch.
   *  High coverage + low pitchAccuracy → pitch detection artefacts, not missed notes. */
  coverageAccuracy: number;
  refCount: number;
  perfCount: number;
  /** Score-informed only: the performance does not match the score at all
   *  (different piece / improvisation / the player is lost). When true, the
   *  per-note breakdown is not meaningful and the UI should say so rather than
   *  list hundreds of "mistakes". */
  offScore?: boolean;
  /** Score-informed only: aligned match rate divided by a chance baseline
   *  (foreign pitches probed at each note's aligned time). ~1 = no better than
   *  chance (off-score); high = the score genuinely explains the audio. */
  alignmentConfidence?: number;
  /** Score-informed only: detected global transposition in semitones (capo /
   *  vocal key / written-vs-concert). 0 = in the score's key. */
  transposeSemitones?: number;
  /** Score-informed only: reference notes the performance never reached because
   *  it stopped early. Excluded from the accuracy denominators (not mistakes). */
  notAttempted?: number;
}
