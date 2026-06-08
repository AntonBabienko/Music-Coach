import type {
  AlignStep,
  CompareCounts,
  CompareResult,
  NoteEvent,
  Timing,
} from "./types";

// DTW alignment over the two PITCH sequences (tempo-invariant), followed by a
// linear time-fit over the matched pairs.

const CHORD_WINDOW_SEC = 0.025;

/**
 * Reduce simultaneous reference notes (within CHORD_WINDOW_SEC) to the
 * highest-pitched one. Call this before compare() when the performance comes
 * from monophonic audio pitch detection and the reference has chords (e.g. a
 * two-hand piano score). Without collapsing, every bass/inner-voice note in
 * the reference counts as missed, dragging pitchAccuracy to ~20-30%.
 */
export function collapseChords(notes: NoteEvent[]): NoteEvent[] {
  if (notes.length === 0) return [];
  const result: NoteEvent[] = [];
  let best = notes[0];
  for (let i = 1; i < notes.length; i++) {
    const n = notes[i];
    if (n.onsetSec - best.onsetSec < CHORD_WINDOW_SEC) {
      if (n.midi > best.midi) best = n;
    } else {
      result.push(best);
      best = n;
    }
  }
  result.push(best);
  return result;
}

const SUB = 2.0; // substitution cost (wrong note)
const OCT = 0.4; // octave-match cost: same pitch class, different octave. Cheaper
// than SUB so the DTW prefers aligning octave-equivalent notes rather than
// treating them as missed+extra. This handles pitchy's tendency to detect the
// wrong octave on piano/choral audio (C2 for a C4 melody note, etc.).
const GAP = 1.2; // insertion/deletion cost. GAP*2 = 2.4 > SUB, so a real wrong
// note aligns as a single substitution rather than missed + extra. Equal
// pitches align for free.

// Dynamic late threshold computed per-call from the reference IOI distribution;
// see lateTreshold() below. Constant kept as the upper cap.
const LATE_THRESHOLD_MAX = 0.30; // seconds
type Move = "diag" | "up" | "left" | "none";

/**
 * Compare a performance against a reference.
 *
 * 1. DTW over pitch sequences classifies every step as match / wrong / missed
 *    / extra (tempo-invariant).
 * 2. A least-squares fit perfSec = a*refSec + b is computed over matched pairs.
 *    Slope a is the global tempo ratio (a>1 = played slower). Each matched
 *    pair's residual = perfSec - (a*refSec + b) classifies its timing.
 */
export function compare(ref: NoteEvent[], perf: NoteEvent[]): CompareResult {
  const n = ref.length;
  const m = perf.length;

  // Cost and backtrace matrices, (n+1) x (m+1).
  const D: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  );
  const from: Move[][] = Array.from({ length: n + 1 }, () =>
    new Array<Move>(m + 1).fill("none")
  );

  for (let i = 1; i <= n; i++) {
    D[i][0] = i * GAP;
    from[i][0] = "up";
  }
  for (let j = 1; j <= m; j++) {
    D[0][j] = j * GAP;
    from[0][j] = "left";
  }

  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const rMidi = ref[i - 1].midi;
      const pMidi = perf[j - 1].midi;
      const subCost =
        rMidi === pMidi ? 0 :
          rMidi % 12 === pMidi % 12 ? OCT : // same pitch class, different octave
            SUB;
      const diag = D[i - 1][j - 1] + subCost;
      const up = D[i - 1][j] + GAP; // ref note i unmatched -> missed
      const left = D[i][j - 1] + GAP; // perf note j unmatched -> extra

      let best = diag;
      let move: Move = "diag";
      if (up < best) {
        best = up;
        move = "up";
      }
      if (left < best) {
        best = left;
        move = "left";
      }
      D[i][j] = best;
      from[i][j] = move;
    }
  }

  // Backtrack from (n, m) to (0, 0).
  const steps: AlignStep[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const move = from[i][j];
    if (move === "diag") {
      const r = ref[i - 1];
      const p = perf[j - 1];
      // Exact match OR same pitch class (octave error from pitch detection).
      const equal = r.midi === p.midi || r.midi % 12 === p.midi % 12;
      steps.push({
        type: equal ? "match" : "wrong",
        refIndex: i - 1,
        perfIndex: j - 1,
        refMidi: r.midi,
        perfMidi: p.midi,
        measure: r.measure,
      });
      i--;
      j--;
    } else if (move === "up") {
      const r = ref[i - 1];
      steps.push({
        type: "missed",
        refIndex: i - 1,
        refMidi: r.midi,
        measure: r.measure,
      });
      i--;
    } else {
      const p = perf[j - 1];
      steps.push({
        type: "extra",
        perfIndex: j - 1,
        perfMidi: p.midi,
      });
      j--;
    }
  }
  steps.reverse();

  // ---- harmonic-wrong reclassification ------------------------------------
  // If a "wrong" step's played note is a perfect fifth (7 semitones) from the
  // expected note — the 3rd natural harmonic of any piano string — it is almost
  // certainly an overtone artefact rather than a real mistake. Reclassify it as
  // "match" so it contributes to pitchAccuracy and gets proper timing assigned
  // in the fit below. Octave equivalence (diff%12=0) is already handled inside
  // the backtracking `equal` check above.
  for (const s of steps) {
    if (s.type === "wrong" && s.refMidi != null && s.perfMidi != null) {
      // Reclassify upward harmonic artefacts as "match". Piano overtones go UP:
      //   H3  = +19 semi ≡ +7 mod 12  (perfect fifth)   — strongest false trigger
      //   H5  = +28 semi ≡ +4 mod 12  (major third)      — 2nd most common
      //   H7  = +34 semi ≡ +10 mod 12 (minor seventh)    — 3rd detectable harmonic
      // Notes played BELOW the expected are real wrong notes, not overtones.
      if (s.perfMidi > s.refMidi) {
        const diff = (s.perfMidi - s.refMidi) % 12;
        if (diff === 7 || diff === 4 || diff === 10) s.type = "match";
      }
    }
  }

  // ---- dynamic late threshold (scales with piece tempo) ------------------
  // At fast tempos, 0.30 s = one full beat; cap at 60 % of the median ref IOI
  // so the window stays musically proportional across tempos.
  const refOnsets = Array.from(new Set(ref.map((r) => r.onsetSec))).sort(
    (x, y) => x - y
  );
  const _iois: number[] = [];
  for (let k = 1; k < refOnsets.length; k++) {
    const d = refOnsets[k] - refOnsets[k - 1];
    if (d > 1e-6) _iois.push(d);
  }
  _iois.sort((x, y) => x - y);
  const medIOI = _iois.length ? _iois[Math.floor(_iois.length / 2)] : 0;
  const lateThreshold = medIOI > 0
    ? Math.min(LATE_THRESHOLD_MAX, medIOI * 0.60)
    : LATE_THRESHOLD_MAX;

  // ---- timing fit over matched pairs --------------------------------------
  const matched = steps.filter((s) => s.type === "match");
  // Theil-Sen estimator: median of all pairwise slopes, then median intercept.
  // Resistant to outlier matches (wrong-voice alignments, structural mismatches)
  // that would pull an OLS fit off — the main cause of "all notes show as early
  // by 1+ second" when the fit intercept lands on a bad reference region.
  const { a, b } = theilSen(
    matched.map((s) => ref[s.refIndex!].onsetSec),
    matched.map((s) => perf[s.perfIndex!].onsetSec)
  );

  let ssRes = 0;
  let ssTot = 0;
  const meanPerf =
    matched.length > 0
      ? matched.reduce((acc, s) => acc + perf[s.perfIndex!].onsetSec, 0) /
      matched.length
      : 0;
  for (const s of matched) {
    const refSec = ref[s.refIndex!].onsetSec;
    const perfSec = perf[s.perfIndex!].onsetSec;
    const residual = perfSec - (a * refSec + b);
    s.residualSec = residual;
    ssRes += residual * residual;
    ssTot += (perfSec - meanPerf) * (perfSec - meanPerf);
    let timing: Timing = "on";
    if (residual > lateThreshold) timing = "late";
    else if (residual < -lateThreshold) timing = "early";
    s.timing = timing;
  }
  // R² of the timing fit. Needs ≥3 points and non-degenerate spread to mean
  // anything; otherwise report 0 (tempo claim should be suppressed downstream).
  const timingR2 =
    matched.length >= 3 && ssTot > 1e-9
      ? Math.max(0, 1 - ssRes / ssTot)
      : 0;

  // Robust reliability scale: median |residual| relative to the median spacing
  // between reference notes. Unlike R², this catches the case where matches are
  // monotonic in time (so a line fits well, R²≈1) yet each match is off by many
  // note-positions — the signature of a structural mismatch (e.g. unexpanded
  // repeats, or pitch detection locking onto the wrong voice).
  const absResid = matched
    .map((s) => Math.abs(s.residualSec!))
    .sort((x, y) => x - y);
  const medAbsResid = absResid.length
    ? absResid[Math.floor(absResid.length / 2)]
    : 0;
  const timingResidualRatio = medIOI > 1e-6 ? medAbsResid / medIOI : 0;

  // ---- per-measure drift correction ---------------------------------------
  // "Domino effect": if an entire measure's matched notes share a large common
  // residual (e.g. all −1.03 s), it is a sync artefact — audio buffer slip or
  // onset-detection latency — not a real timing mistake by the player.
  // Fix: compute the per-measure median residual; if |median| > BIAS_THRESHOLD,
  // subtract it from every note in that measure so they revert to near-zero and
  // get re-classified as "on".  Only applied when ≥ BIAS_MIN matches exist in
  // the measure (avoids over-correcting on sparse passages).
  const BIAS_THRESHOLD = 0.20; // seconds; below this, trust individual residuals (was 0.30)
  const BIAS_MIN = 3;           // minimum matched notes per measure to correct

  const byMeasure = new Map<number, AlignStep[]>();
  for (const s of matched) {
    if (s.measure == null) continue;
    const bucket = byMeasure.get(s.measure);
    if (bucket) bucket.push(s);
    else byMeasure.set(s.measure, [s]);
  }
  for (const mSteps of byMeasure.values()) {
    if (mSteps.length < BIAS_MIN) continue;
    const sorted = mSteps.map((s) => s.residualSec!).sort((x, y) => x - y);
    const bias = sorted[Math.floor(sorted.length / 2)]; // median residual
    if (Math.abs(bias) < BIAS_THRESHOLD) continue;
    for (const s of mSteps) {
      s.residualSec = s.residualSec! - bias;
      const r = s.residualSec;
      s.timing = r > lateThreshold ? "late" : r < -lateThreshold ? "early" : "on";
    }
  }

  // ---- tallies ------------------------------------------------------------
  const counts: CompareCounts = {
    match: 0,
    wrong: 0,
    missed: 0,
    extra: 0,
    late: 0,
    early: 0,
  };
  for (const s of steps) {
    counts[s.type]++;
    if (s.timing === "late") counts.late++;
    if (s.timing === "early") counts.early++;
  }

  const pitchAccuracy = n > 0 ? (counts.match / n) * 100 : 0;
  const onTimeCount = counts.match - counts.late - counts.early;
  const onTimeAccuracy = n > 0 ? (onTimeCount / n) * 100 : 0;
  const coverageAccuracy = n > 0 ? ((counts.match + counts.wrong) / n) * 100 : 0;

  return {
    steps,
    counts,
    tempoRatio: a,
    intercept: b,
    timingR2,
    timingResidualRatio,
    pitchAccuracy,
    onTimeAccuracy,
    coverageAccuracy,
    refCount: n,
    perfCount: m,
  };
}

/**
 * Post-process a CompareResult to drop octave-phantom "extra" steps.
 *
 * When basic-pitch detects an overtone alongside a real note (e.g. F4 played,
 * F5 detected as an additional sound), DTW classifies the overtone as "extra"
 * because the reference has no matching note for it. This function removes such
 * extras: if an "extra" note shares a pitch class (same note name, different
 * octave) with any "match" within ±WINDOW steps, it is an overtone artifact.
 *
 * The step window is intentionally small (±5) so that a legitimate extra note
 * in a different passage is not silently removed.
 *
 * Counts are recomputed from the filtered step list.
 */
export function cleanPhantomSteps(result: CompareResult): CompareResult {
  // Base window: ±5 steps around each extra. Extended to ±12 for consecutive
  // extra-blocks (measure 21 pattern: basic-pitch emits 4–6 C4 extras in a row
  // with no match between them — they fall outside WINDOW=5 of the nearest match).
  const WINDOW = 12;
  const { steps } = result;

  const filtered = steps.filter((s, i) => {
    if (s.type !== "extra" || s.perfMidi == null) return true;
    const lo = Math.max(0, i - WINDOW);
    const hi = Math.min(steps.length - 1, i + WINDOW);
    for (let k = lo; k <= hi; k++) {
      const n = steps[k];
      if (n.type === "match" && n.perfMidi != null) {
        const sameClass = n.perfMidi % 12 === s.perfMidi % 12;
        const differentOctave = n.perfMidi !== s.perfMidi;
        if (sameClass && differentOctave) return false;
      }
    }
    return true;
  });

  const counts: CompareCounts = {
    match: 0, wrong: 0, missed: 0, extra: 0, late: 0, early: 0,
  };
  for (const s of filtered) {
    counts[s.type]++;
    if (s.timing === "late") counts.late++;
    if (s.timing === "early") counts.early++;
  }
  const pitchAccuracy = result.refCount > 0 ? (counts.match / result.refCount) * 100 : 0;
  const onTimeCount = counts.match - counts.late - counts.early;
  const onTimeAccuracy = result.refCount > 0 ? (onTimeCount / result.refCount) * 100 : 0;
  const coverageAccuracy = result.refCount > 0 ? ((counts.match + counts.wrong) / result.refCount) * 100 : 0;

  return { ...result, steps: filtered, counts, pitchAccuracy, onTimeAccuracy, coverageAccuracy };
}

/**
 * Theil-Sen estimator: robust linear fit y = a*x + b.
 *
 * Slope  = median of all pairwise slopes (ys[j]-ys[i])/(xs[j]-xs[i]).
 * Intercept = median of (ys[i] - a*xs[i]).
 *
 * Unlike OLS, a minority of badly-matched notes (wrong voice, repeat-expansion
 * mismatch) cannot dominate the slope — the median is insensitive to outliers.
 * O(n²) pairs; negligible for n ≤ 500 matched notes in a browser context.
 */
function theilSen(xs: number[], ys: number[]): { a: number; b: number } {
  const k = xs.length;
  if (k === 0) return { a: 1, b: 0 };
  if (k === 1) return { a: 1, b: ys[0] - xs[0] };

  const slopes: number[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const dx = xs[j] - xs[i];
      if (Math.abs(dx) > 1e-9) slopes.push((ys[j] - ys[i]) / dx);
    }
  }
  slopes.sort((p, q) => p - q);
  const a = slopes[Math.floor(slopes.length / 2)];

  const intercepts = xs.map((x, i) => ys[i] - a * x);
  intercepts.sort((p, q) => p - q);
  const b = intercepts[Math.floor(intercepts.length / 2)];
  return { a, b };
}
