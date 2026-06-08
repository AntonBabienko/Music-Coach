import type { CompareResult } from "./types";

export interface NormalizedScores {
  pitchNorm: number;
  coverageNorm: number;
  onTimeNorm: number;
  /** Measures where the reference audio itself had ≥ NOISY_THRESHOLD errors. */
  noisyMeasures: Set<number>;
}

const NOISY_THRESHOLD = 5;

export function normalizeAgainstBaseline(
  result: CompareResult,
  baseline: CompareResult
): NormalizedScores {
  const cap = (v: number) => Math.min(100, Math.max(0, v));

  const pitchNorm = baseline.pitchAccuracy > 0
    ? cap((result.pitchAccuracy / baseline.pitchAccuracy) * 100)
    : result.pitchAccuracy;
  const coverageNorm = baseline.coverageAccuracy > 0
    ? cap((result.coverageAccuracy / baseline.coverageAccuracy) * 100)
    : result.coverageAccuracy;
  const onTimeNorm = baseline.onTimeAccuracy > 0
    ? cap((result.onTimeAccuracy / baseline.onTimeAccuracy) * 100)
    : result.onTimeAccuracy;

  const byMeasure = new Map<number, number>();
  for (const s of baseline.steps) {
    if ((s.type === "missed" || s.type === "wrong") && s.measure != null) {
      byMeasure.set(s.measure, (byMeasure.get(s.measure) ?? 0) + 1);
    }
  }
  const noisyMeasures = new Set<number>();
  for (const [m, count] of byMeasure) {
    if (count >= NOISY_THRESHOLD) noisyMeasures.add(m);
  }

  return { pitchNorm, coverageNorm, onTimeNorm, noisyMeasures };
}
