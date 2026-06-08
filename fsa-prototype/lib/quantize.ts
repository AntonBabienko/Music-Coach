import type { NoteEvent } from "./types";

/**
 * Drop notes shorter than minDurMs milliseconds before they reach DTW.
 * Acoustic clicks, nail-edge key touches, and extremely short sustain artifacts
 * from basic-pitch all produce sub-50 ms events that would otherwise register
 * as spurious "extra" notes in the comparison.
 *
 * When `bpm` is provided the threshold is capped at 70 % of a 32nd-note
 * duration so that legitimately fast notes at high tempos are not discarded.
 * Example: 180 BPM → 32nd = 41.7 ms → cap = 29 ms (< default 50 ms).
 */
export function filterShortNotes(notes: NoteEvent[], minDurMs = 50, bpm?: number): NoteEvent[] {
  const effectiveMs = bpm && bpm > 0
    ? Math.min(minDurMs, (60 / bpm / 8) * 0.70 * 1000)
    : minDurMs;
  const minSec = effectiveMs / 1000;
  return notes.filter((n) => (n.durationSec ?? Infinity) >= minSec);
}

/**
 * Snap performance note onsets to the nearest musical grid position (default:
 * 16th-note grid at the reference BPM), then deduplicate any notes that land
 * on the same grid slot with the same MIDI pitch.
 *
 * Why both steps matter:
 *  - Grid snap: a pianist's fingers don't land all chord notes simultaneously;
 *    basic-pitch sees micro-delays (2–10 ms) and emits them as separate onsets.
 *    Snapping collapses those to the same time, matching the reference where all
 *    chord notes share one onset.
 *  - Deduplication: sustain-pedal resonance can trigger a second onset for the
 *    same pitch one grid-step later; keeping only the louder (higher velocity)
 *    instance removes those ghost notes before DTW sees them.
 *
 * gridDiv=16 → 16th-note grid (default).
 * gridDiv=8  → 8th-note grid (use for slow tempos or if 16ths cause over-snap).
 */
export function quantizeNotes(
  notes: NoteEvent[],
  bpm: number,
  gridDiv = 16
): NoteEvent[] {
  if (notes.length === 0 || bpm <= 0) return notes;

  // Duration of one grid unit in seconds.
  const gridSec = 60 / bpm / (gridDiv / 4);

  const snapped = notes.map((n) => ({
    ...n,
    onsetSec: Math.round(n.onsetSec / gridSec) * gridSec,
  }));

  // Keep highest-velocity note when two notes share (midi, snapped onset).
  const buckets = new Map<string, NoteEvent>();
  for (const n of snapped) {
    const key = `${n.midi}:${n.onsetSec.toFixed(6)}`;
    const existing = buckets.get(key);
    if (!existing || (n.velocity ?? 0) > (existing.velocity ?? 0)) {
      buckets.set(key, n);
    }
  }

  return Array.from(buckets.values()).sort(
    (a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi
  );
}
