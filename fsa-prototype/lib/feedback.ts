import type { CompareResult } from "./types";

/**
 * Turn a CompareResult into short, deterministic practice feedback.
 *
 * No LLM is used in the prototype: the rules below are fixed thresholds. In
 * production this same structured result becomes the prompt context for an LLM
 * coaching layer (see README).
 */
// When matched notes deviate from the tempo line by more than half a note
// spacing (median), the time-fit is structurally wrong and tempoRatio is a
// fitting artifact — suppress every tempo/timing claim rather than report a
// confident-but-false number like "252% slower". Note R² is NOT used here: it
// stays near 1 even in that case because matches remain monotonic in time.
const TIMING_MAX_RESID_RATIO = 0.5;
const TIMING_MIN_MATCHES = 4;

export function buildFeedback(result: CompareResult): string[] {
  const { counts, tempoRatio, timingResidualRatio, pitchAccuracy, steps } = result;
  const lines: string[] = [];

  const timingReliable =
    counts.match >= TIMING_MIN_MATCHES &&
    timingResidualRatio <= TIMING_MAX_RESID_RATIO;

  lines.push(`Pitch accuracy: ${pitchAccuracy.toFixed(1)}% (${counts.match}/${result.refCount} notes correct).`);

  lines.push(
    `Errors — wrong: ${counts.wrong}, missed: ${counts.missed}, extra: ${counts.extra}, late: ${counts.late}, early: ${counts.early}.`
  );

  // Measure with the most pitch errors (wrong + missed).
  const byMeasure = new Map<number, number>();
  for (const s of steps) {
    if ((s.type === "wrong" || s.type === "missed") && s.measure != null) {
      byMeasure.set(s.measure, (byMeasure.get(s.measure) ?? 0) + 1);
    }
  }
  let worstMeasure = -1;
  let worstCount = 0;
  for (const [measure, c] of byMeasure) {
    if (c > worstCount) {
      worstCount = c;
      worstMeasure = measure;
    }
  }
  if (worstMeasure >= 0) {
    lines.push(
      `Focus on measure ${worstMeasure}: it has the most pitch errors (${worstCount}).`
    );
  } else if (counts.wrong + counts.missed === 0) {
    lines.push("No pitch errors — every reference note was played correctly.");
  }

  // Tempo and timing claims only when the time-fit is actually reliable.
  // A low R² means too few notes were detected at the right pitch to line up
  // the performance in time, so any tempo/drag number would be noise.
  if (!timingReliable) {
    lines.push(
      "Tempo/timing: not enough cleanly matched notes to judge tempo or timing reliably — improve pitch accuracy first."
    );
    return lines;
  }

  // Tempo note from the global slope a.
  if (tempoRatio > 1.15) {
    lines.push(
      `Tempo: you played about ${Math.round((tempoRatio - 1) * 100)}% slower than the reference overall.`
    );
  } else if (tempoRatio < 0.87) {
    lines.push(
      `Tempo: you played about ${Math.round((1 - tempoRatio) * 100)}% faster than the reference overall.`
    );
  } else {
    lines.push("Tempo: your overall pace closely matched the reference.");
  }

  // Drag / rush hint — only when the skew is pronounced enough to mention.
  // Matches the 0.44 threshold used in assessment.ts timingBand.
  const timingTotal = counts.late + counts.early;
  const skew = timingTotal > 0 ? Math.abs(counts.late - counts.early) / timingTotal : 0;
  if (skew >= 0.44 && counts.late > counts.early) {
    lines.push("Timing hint: you tend to drag (notes land late) — practice with a metronome.");
  } else if (skew >= 0.44 && counts.early > counts.late) {
    lines.push("Timing hint: you tend to rush (notes land early) — hold back slightly and stay with the beat.");
  } else {
    lines.push("Timing hint: your note timing was steady throughout.");
  }

  return lines;
}
