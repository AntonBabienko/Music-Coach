import type { CompareResult } from "./types";

// ---- AI summary -------------------------------------------------------------

export interface AISummary {
  /** Pitch accuracy after all filters (match / refCount × 100). */
  pitchAccuracy: number;
  /** Strict accuracy: correct pitch AND on-time (≤150ms) / refCount × 100. */
  onTimeAccuracy: number;
  /** (match + wrong) / refCount × 100. High coverage + low pitch → detection artefacts. */
  coverageAccuracy: number;
  /** "rushing" when early > late, "dragging" when late > early, etc. */
  mainIssue: "rushing" | "dragging" | "wrong_notes" | "missed_notes" | "good";
  earlyCount: number;
  lateCount: number;
  wrongCount: number;
  missedCount: number;
  /** Spurious extra notes remaining after phantom filtering. */
  extraCount: number;
  /** 1-based measure number with the most pitch errors, if any. */
  mostDifficultMeasure: number | null;
  /** Coverage: how many ref notes got any aligned perf note (0–100). */
  coveragePct: number;
  /** False when too few matches to trust timing claims. */
  timingReliable: boolean;
  /** True when chroma shows the audio matches but the detector dropped notes —
   *  the coach must treat errors as transcription limits, not player mistakes. */
  transcriptionUnreliable: boolean;
}

/**
 * Compact structured summary of a CompareResult for feeding an LLM.
 * Avoids raw arrays — the model only needs counts + the one trouble spot.
 *
 * Usage example:
 *   const summary = buildAISummary(result);
 *   const prompt = `Based on this session data, give the student brief coaching in Ukrainian:\n${JSON.stringify(summary)}`;
 */
export function buildAISummary(
  result: CompareResult,
  chromaConf?: ChromaConfidence,
): AISummary {
  const { counts, steps, refCount, timingResidualRatio } = result;
  const transcriptionUnreliable = isTranscriptionUnreliable(
    splitErrorsByChroma(steps, chromaConf),
  );

  const aligned = counts.match + counts.wrong;
  const coveragePct = refCount > 0 ? Math.round((aligned / refCount) * 100) : 0;
  const timingReliable = counts.match >= 4 && timingResidualRatio <= 0.5;

  // Dominant issue in priority order.
  let mainIssue: AISummary["mainIssue"] = "good";
  if (counts.wrong > counts.missed && counts.wrong > counts.extra) {
    mainIssue = "wrong_notes";
  } else if (counts.missed > counts.wrong) {
    mainIssue = "missed_notes";
  } else if (timingReliable && counts.early > counts.late && counts.early > 0) {
    mainIssue = "rushing";
  } else if (timingReliable && counts.late > counts.early && counts.late > 0) {
    mainIssue = "dragging";
  }

  // Worst single measure by wrong + missed count.
  const byMeasure = new Map<number, number>();
  for (const s of steps) {
    if ((s.type === "wrong" || s.type === "missed") && s.measure != null) {
      byMeasure.set(s.measure, (byMeasure.get(s.measure) ?? 0) + 1);
    }
  }
  let mostDifficultMeasure: number | null = null;
  let worst = 0;
  for (const [m, c] of byMeasure) {
    if (c > worst) { worst = c; mostDifficultMeasure = m; }
  }

  return {
    pitchAccuracy: Math.round(result.pitchAccuracy * 10) / 10,
    onTimeAccuracy: Math.round(result.onTimeAccuracy * 10) / 10,
    coverageAccuracy: Math.round(result.coverageAccuracy * 10) / 10,
    mainIssue,
    earlyCount: counts.early,
    lateCount: counts.late,
    wrongCount: counts.wrong,
    missedCount: counts.missed,
    extraCount: counts.extra,
    mostDifficultMeasure,
    coveragePct,
    timingReliable,
    transcriptionUnreliable,
  } satisfies AISummary;
}

// Qualitative coaching layer ON TOP of the note-level CompareResult.
//
// The spec asks for note-level errors (missed / wrong / late) — those are still
// computed and shown verbatim. But on real (especially audio) input, per-note
// verdicts are noisy: a single transcription miss becomes a false "you missed a
// note". So this layer aggregates the same data into a few coarse, robust
// dimensions and gates every claim on confidence — it never blames the player
// for what is likely a detection artifact.

export type Band = "strong" | "fair" | "weak" | "unknown";
export type Trend = "drag" | "rush" | "even" | "unknown";
export type TimingBand = "steady" | "slightly-off" | "unreliable";

/** measure → chroma similarity 0-1. High = sounds correct, Low = real error. */
export type ChromaConfidence = Map<number, number>;
const CHROMA_ARTIFACT = 0.72; // sim above this → error is probably transcription noise
const CHROMA_CONFIRMED = 0.48; // sim below this → error is likely a real player mistake

/** Split wrong+missed errors into player-confirmed vs transcription-artifact
 *  buckets using per-measure chroma similarity. Undefined when no chroma
 *  confidence is available. */
export function splitErrorsByChroma(
  steps: CompareResult["steps"],
  chromaConf?: ChromaConfidence,
): { confirmed: number; artifact: number } | undefined {
  if (!chromaConf || chromaConf.size === 0) return undefined;
  let confirmed = 0, artifact = 0;
  for (const s of steps) {
    if ((s.type === "wrong" || s.type === "missed") && s.measure != null) {
      const sim = chromaConf.get(s.measure);
      if (sim != null) {
        if (sim <= CHROMA_CONFIRMED) confirmed++;
        else if (sim >= CHROMA_ARTIFACT) artifact++;
      }
    }
  }
  return { confirmed, artifact };
}

/** True when chroma says the audio matches but the detector dropped notes:
 *  errors are overwhelmingly high-similarity artifacts with ~none confirmed.
 *  In this state per-note verdicts blame the transcriber, not the player. */
export function isTranscriptionUnreliable(
  split: { confirmed: number; artifact: number } | undefined,
): boolean {
  if (!split) return false;
  return split.artifact >= 5 && split.confirmed <= 1 && split.artifact >= split.confirmed * 4;
}

// ---- Recording-profile bias correction ------------------------------------

/**
 * Describes MIDI pitch ranges where the recording chain cannot reliably
 * capture notes — misses in those ranges should not penalise the player.
 */
export interface RecordingBias {
  /**
   * Notes at or below this MIDI pitch are excluded from the effective ref
   * count.  Use for dictaphone/mic low-frequency cutoff — a cheap mic
   * physically cannot reproduce E3 (164 Hz) or lower.
   */
  lowCutoffMidi?: number;
  /**
   * Notes at or above this MIDI pitch are excluded.  Use for polyphonic
   * upper-voice masking: in dense chords the top voices are swallowed by
   * the harmonic content of the lower voices and never reach the detector.
   * Only set this when the register would not appear as a solo melody line.
   */
  highCutoffMidi?: number;
}

/** Ready-made profile for cheap dictaphone recording of a polyphonic piece. */
export const DICTAPHONE_BIAS: RecordingBias = {
  lowCutoffMidi: 52, // E3 = 164 Hz — below the mic's usable frequency range
};

function countBlindZoneMisses(
  steps: CompareResult["steps"],
  bias: RecordingBias,
): number {
  let n = 0;
  for (const s of steps) {
    if (s.type !== "missed" || s.refMidi == null) continue;
    const inLow = bias.lowCutoffMidi != null && s.refMidi <= bias.lowCutoffMidi;
    const inHigh = bias.highCutoffMidi != null && s.refMidi >= bias.highCutoffMidi;
    if (inLow || inHigh) n++;
  }
  return n;
}

export interface Region {
  fromMeasure: number;
  toMeasure: number;
  errors: number;
}

export interface Assessment {
  /** One-line plain-language verdict. */
  headline: string;
  /** Share of reference notes that got *some* matching played note (0..100). */
  completenessPct: number;
  /** Of the notes that aligned, how many were the right pitch (0..100). */
  pitchPct: number;
  pitchBand: Band;
  timingBand: TimingBand;
  timingTrend: Trend;
  /** Worst contiguous run of measures by pitch errors, if any. */
  weakestRegion?: Region;
  /** True when too little matched to judge — feedback is hedged, not harsh. */
  lowConfidence: boolean;
  /** True when the chroma cross-check shows the audio matches but the detector
   *  dropped many notes — per-note grading is deferred to the qualitative read,
   *  and the player is not blamed. */
  transcriptionUnreliable?: boolean;
  /** 1–3 prioritized, qualitative practice tips. */
  tips: string[];
  /** Wrong+missed errors in measures with LOW chroma sim — likely real player mistakes. */
  confirmedErrors?: number;
  /** Wrong+missed errors in measures with HIGH chroma sim — likely transcription artifacts. */
  artifactErrors?: number;
  /** Missed notes excluded from scoring because they fall in a recording blind zone
   *  (dictaphone low-freq cutoff or polyphonic upper-voice masking). */
  blindZoneMissed?: number;
}

const MIN_ALIGNED = 4; // need at least this many aligned notes to judge anything
const MIN_COVERAGE = 0.42; // below this, assume detection dropped notes, not the player (orig 0.50, rg 0.35)

export function assess(
  result: CompareResult,
  chromaConf?: ChromaConfidence,
  recordingBias?: RecordingBias,
): Assessment {
  const { counts, steps, refCount } = result;
  const aligned = counts.match + counts.wrong;

  const blindZoneMissed = recordingBias
    ? countBlindZoneMisses(steps, recordingBias)
    : 0;
  const effRefCount = Math.max(1, refCount - blindZoneMissed);

  const coverage = effRefCount > 0 ? aligned / effRefCount : 0;
  const completenessPct = coverage * 100;
  const pitchPct = effRefCount > 0 ? (counts.match / effRefCount) * 100 : 0;

  const lowConfidence = aligned < MIN_ALIGNED || coverage < MIN_COVERAGE;

  let pitchBand: Band = "unknown";
  if (aligned >= MIN_ALIGNED) {
    pitchBand = pitchPct >= 76 ? "strong" : pitchPct >= 50 ? "fair" : "weak";
  }

  // Timing only when the time-fit is trustworthy (reuses the residual gate).
  const timingReliable =
    counts.match >= MIN_ALIGNED && result.timingResidualRatio <= 0.5;
  let timingBand: TimingBand = "unreliable";
  let timingTrend: Trend = "unknown";
  if (timingReliable) {
    const total = counts.late + counts.early;
    if (total === 0) {
      timingBand = "steady";
      timingTrend = "even";
    } else {
      const skew = Math.abs(counts.late - counts.early) / total;
      timingBand = skew < 0.44 ? "steady" : "slightly-off"; // balanced (orig 0.34, rg 0.55)
      timingTrend =
        counts.late > counts.early ? "drag" : counts.early > counts.late ? "rush" : "even";
    }
  }

  const weakestRegion = worstContiguousRegion(steps);

  // Split errors by chroma confidence when available.
  const split = splitErrorsByChroma(steps, chromaConf);
  const confirmedErrors = split?.confirmed;
  const artifactErrors = split?.artifact;

  // When the chroma cross-check says the audio actually matches — errors are
  // overwhelmingly high-similarity artifacts with ~none confirmed — the note
  // detector, not the player, is responsible (dense-polyphony recall ceiling).
  // Don't grade per-note; defer to the qualitative read, like the coverage gate.
  const transcriptionUnreliable = isTranscriptionUnreliable(split);

  const tips = buildTips({
    lowConfidence,
    transcriptionUnreliable,
    pitchBand,
    completenessPct,
    timingReliable,
    timingBand,
    timingTrend,
    weakestRegion,
  });

  const headline = buildHeadline({
    lowConfidence,
    transcriptionUnreliable,
    completenessPct,
    pitchBand,
    timingBand,
    timingTrend,
  });

  return {
    headline,
    completenessPct,
    pitchPct,
    pitchBand,
    timingBand,
    timingTrend,
    weakestRegion,
    lowConfidence,
    transcriptionUnreliable,
    tips,
    confirmedErrors,
    artifactErrors,
    blindZoneMissed: blindZoneMissed > 0 ? blindZoneMissed : undefined,
  };
}

// ---- helpers ---------------------------------------------------------------

/** Longest-error contiguous measure run: groups wrong+missed by measure, then
 *  finds the run of consecutive measures with the highest total errors. Region
 *  granularity is robust to individual misdetections in a way per-note is not. */
function worstContiguousRegion(steps: CompareResult["steps"]): Region | undefined {
  const errByMeasure = new Map<number, number>();
  for (const s of steps) {
    if ((s.type === "wrong" || s.type === "missed") && s.measure != null) {
      errByMeasure.set(s.measure, (errByMeasure.get(s.measure) ?? 0) + 1);
    }
  }
  if (errByMeasure.size === 0) return undefined;

  const measures = [...errByMeasure.keys()].sort((a, b) => a - b);
  const totalMeasures = measures[measures.length - 1] - measures[0] + 1;

  let best: Region = { fromMeasure: measures[0], toMeasure: measures[0], errors: -1 };
  let from = measures[0];
  let prev = measures[0];
  let sum = errByMeasure.get(measures[0])!;
  const flush = () => {
    const span = prev - from + 1;
    // Only report if region is localised (<= 30% of total span) and has density
    // above average — avoids returning "measures 1–N" when errors are uniform.
    const avgErrPerMeasure = [...errByMeasure.values()].reduce((a, b) => a + b, 0) / errByMeasure.size;
    const density = sum / span;
    if (sum > best.errors && span <= Math.ceil(totalMeasures * 0.3) && density >= avgErrPerMeasure * 1.5) {
      best = { fromMeasure: from, toMeasure: prev, errors: sum };
    }
  };
  for (let i = 1; i < measures.length; i++) {
    const m = measures[i];
    if (m === prev + 1) {
      sum += errByMeasure.get(m)!;
      prev = m;
    } else {
      flush();
      from = m;
      prev = m;
      sum = errByMeasure.get(m)!;
    }
  }
  flush();
  return best.errors === -1 ? undefined : best;
}

function regionLabel(r: Region): string {
  return r.fromMeasure === r.toMeasure
    ? `${r.fromMeasure}`
    : `${r.fromMeasure}–${r.toMeasure}`;
}

function buildTips(ctx: {
  lowConfidence: boolean;
  transcriptionUnreliable: boolean;
  pitchBand: Band;
  completenessPct: number;
  timingReliable: boolean;
  timingBand: TimingBand;
  timingTrend: Trend;
  weakestRegion?: Region;
}): string[] {
  const tips: string[] = [];

  if (ctx.transcriptionUnreliable) {
    tips.push(
      "The recording's harmony matches the score, but the note detector dropped many notes (dense polyphony) — per-note pitch and timing aren't reliable here, so this isn't graded against you. Use MIDI or a cleaner/sparser recording for exact note-by-note feedback."
    );
    return tips;
  }

  if (ctx.lowConfidence) {
    tips.push(
      "Too few notes matched to judge reliably — this is usually audio transcription dropping notes, not your playing. Use MIDI or a clean single-line recording for trustworthy feedback."
    );
    return tips;
  }

  if (ctx.pitchBand === "weak") {
    // Weak pitch always gets advice — pointed at the region when errors are
    // localised, otherwise a whole-piece prompt (errors spread everywhere, which
    // also covers a wrong-piece / wrong-take submission).
    tips.push(ctx.weakestRegion
      ? `Pitch needs work — drill measures ${regionLabel(ctx.weakestRegion)} slowly, hands separate if needed.`
      : "Pitch is off across the whole piece — slow right down and check each note against the score (make sure it's the right piece/take).");
  } else if (ctx.weakestRegion && ctx.weakestRegion.errors >= 3) {
    tips.push(`Most slips cluster in measures ${regionLabel(ctx.weakestRegion)} — isolate and loop that passage.`);
  }

  if (ctx.timingReliable && ctx.timingBand === "slightly-off" && ctx.timingTrend === "drag") {
    tips.push("You tend to drag — practice with a metronome and don't let long notes pull the tempo back.");
  } else if (ctx.timingReliable && ctx.timingBand === "slightly-off" && ctx.timingTrend === "rush") {
    tips.push("You tend to rush — stay with the beat instead of anticipating the next note.");
  }

  if (ctx.completenessPct < 68) { // balanced threshold (orig 85, rg 55)
    tips.push("Some notes didn't land — slow the tempo until you can catch every note, then build speed back up.");
  }

  if (tips.length === 0) {
    // Only praise when pitch is actually strong — never claim "looks good" on a
    // fair/weak run that just happened to dodge every specific tip branch.
    tips.push(ctx.pitchBand === "strong"
      ? "Solid run — pitch and timing both look good. Try the next tempo up."
      : "Pitch is partly there but inconsistent — slow down and lock in accuracy before pushing tempo.");
  }
  return tips.slice(0, 3);
}

function buildHeadline(ctx: {
  lowConfidence: boolean;
  transcriptionUnreliable: boolean;
  completenessPct: number;
  pitchBand: Band;
  timingBand: TimingBand;
  timingTrend: Trend;
}): string {
  if (ctx.transcriptionUnreliable) {
    return "Audio matches the score harmonically, but too many notes couldn't be transcribed (dense polyphony) — per-note grading isn't reliable, so this run isn't scored against you.";
  }
  if (ctx.lowConfidence) {
    return "Low-confidence analysis — too few notes matched to give reliable coaching.";
  }
  const pitchWord =
    ctx.pitchBand === "strong" ? "pitch was accurate" :
    ctx.pitchBand === "fair" ? "pitch was mostly there" :
    "pitch needs work";

  let timingWord: string;
  if (ctx.timingBand === "unreliable") timingWord = "timing wasn't assessable";
  else if (ctx.timingBand === "steady") timingWord = "timing was steady";
  else timingWord = ctx.timingTrend === "drag" ? "you dragged slightly" : "you rushed slightly";

  return `Played ${Math.round(ctx.completenessPct)}% of the piece — ${pitchWord}, ${timingWord}.`;
}
