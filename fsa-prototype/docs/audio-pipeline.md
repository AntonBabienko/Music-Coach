# Audio pipeline — technical reference

This document covers the physics of comparing live audio to a MusicXML score,
the problems that make naive comparison fail, and how each problem is mitigated
in this codebase.

---

## Why comparing audio to a score is hard

### 1. Acoustic soup — harmonic overlap

Every piano note produces a **fundamental** (e.g. 440 Hz for A4) plus a series
of **overtones** at 880 Hz, 1 320 Hz, 1 760 Hz, … When a chord sounds, overtones
from different strings overlap. A pitch detector scanning the spectrum can
mistake an overtone of C4 (e.g. the 3rd partial at ~784 Hz ≈ G5) for a real G5.

**Mitigation — monophonic path (`lib/audio.ts`)**
- `clarityThreshold = 0.78`: pitchy's confidence metric. Frames where multiple
  overtones compete produce a lower clarity score and are rejected as silence.
- `minFreq = 200 Hz` (`AUDIO_MIN_FREQ`): eliminates bass fundamentals below G3
  that pitchy locks onto on polyphonic piano audio (the bass strings have the
  strongest fundamental energy).

**Mitigation — polyphonic path (`lib/basicPitch.ts`)**
- Spotify basic-pitch uses a neural model trained to separate simultaneous
  pitches from their harmonics. Harmonic confusion is largely handled at the
  model level.

---

### 2. Sustain-pedal ghost notes

The right pedal lifts dampers, letting strings ring after the key is released.
In MusicXML the note duration is exact; in audio the note decays over several
seconds into the next measures. The detector continues to "hear" the old note
long after the score says it ended.

**Mitigation — monophonic path**
- `mergeGaps(120 ms)`: same-pitch fragments separated by ≤120 ms (typical
  pedal dip below the clarity threshold) are merged into one note event.
- The clarity gate itself suppresses very soft resonance below the threshold.

**Mitigation — polyphonic path (quantize + deduplication)**
- `quantizeNotes()` in `lib/quantize.ts`: after snapping onsets to the
  16th-note grid, two detections of the same MIDI pitch that land on the same
  grid slot are collapsed to one (keeping the louder). Sustain-pedal echoes
  usually re-trigger one or two grid steps later and are thus deduplicated
  against the original onset.

---

### 3. Human timing — rubato and chord arpeggiation

A live pianist **never** plays with millisecond precision:

- **Rubato / expressive timing**: notes arrive 20–80 ms early or late relative
  to the written beat. The score has exact grid positions; the performance does
  not.
- **Chord arpeggiation**: the fingers of one hand do not land simultaneously.
  A three-note chord may arrive as three onsets spread over 5–15 ms. basic-pitch
  detects each finger separately as its own note onset, while MusicXML has all
  three at the same time position.

**Mitigation — DTW (all paths)**
- Dynamic Time Warping in `lib/compare.ts` aligns the **pitch sequences**
  without fixing their time positions. This absorbs global and local tempo
  variation (rubato, tempo drift) automatically.

**Mitigation — grid quantization (`lib/quantize.ts`)**
- Before DTW, polyphonic audio output is snapped to the nearest 16th-note grid
  at the reference BPM. The chord C4+2 ms / E4+5 ms / G4+9 ms all snap to the
  same grid slot, matching the reference where all three are simultaneous.
- `gridDiv = 16` (default). For very slow pieces or heavily rubato playing,
  pass `gridDiv = 8` for looser snapping.

---

### 4. Reverberation and onset smearing

Room acoustics and deliberate reverb effects cause every note's attack to be
smeared across several milliseconds. The exact moment of key contact (onset) is
buried in the reverb tail of the previous note.

**Mitigation**
- basic-pitch is trained on real-world recordings including reverb; its onset
  model is more robust than autocorrelation-based trackers.
- The `±150 ms` late/early threshold in `compare.ts` (`LATE_THRESHOLD`) is
  large enough to absorb typical onset smear without misclassifying correctly
  timed notes as late.
- The **timing residual ratio gate** (`timingResidualRatio ≤ 0.5`) suppresses
  timing claims entirely when the tempo fit is structurally wrong — avoiding
  confident-but-false "you played 200% slower" messages.

---

## Accuracy expectations

| Input type                    | Typical pitchAccuracy | Notes                                      |
| ----------------------------- | --------------------- | ------------------------------------------ |
| MIDI / score self-test        | 100%                  | Deterministic baseline                     |
| Clean single-voice audio      | 70–90%                | Monophonic pitchy path                     |
| Polyphonic piano (basic-pitch)| 60–85%                | Depends on chord density and sustain pedal |
| SATB choral / orchestral      | 40–65%                | Multiple simultaneous voices, high overlap |

85–92% on complex polyphonic audio is considered a technical success and matches
commercial-product benchmarks. The remainder is smoothed by the tolerance logic
(`LATE_THRESHOLD`, grid quantization, octave tolerance OCT=0.4 in DTW) so the
UI does not penalise players for detector physics.

---

## Reliability gate — `timingResidualRatio`

`R²` of the tempo fit (perfSec = a·refSec + b) stays near 1 even when matched
notes are monotonic but structurally offset by many note positions (e.g. when
unexpanded repeats double the reference length, or pitch detection locks onto
the wrong voice). **R² is therefore not used** as the reliability signal.

Instead, `timingResidualRatio = median|residual| / median(refIOI)` is computed:
- ≈ 0: each matched note sits close to the tempo line → fit is trustworthy.
- >> 1: matched notes deviate by multiple note spacings → fit is noise.

The gate `timingResidualRatio ≤ 0.5` is applied in `lib/feedback.ts` and
`lib/assessment.ts` before any tempo or timing claim is shown to the user.

---

## Two audio paths at a glance

| | Chroma (`lib/chroma.ts`) | Polyphonic (`lib/basicPitch.ts`) |
|---|---|---|
| Speed | ~0.5 s | 30–120 s (model inference) |
| Output | `ChromaResult` — similarity 0–100, tempo ratio, weakest segment | `NoteEvent[]` → full DTW compare |
| Note-level verdict | No | Yes (wrong / missed / extra per note) |
| Polyphony | Full (FFT chroma is inherently polyphonic) | Full (neural model) |
| Use when | Quick sanity check, long recordings | Detailed coaching, short–medium pieces |
