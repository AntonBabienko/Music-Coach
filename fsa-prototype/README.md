# Music Coach — Core Prototype

A minimal technical demo of the **core music-comparison pipeline**: load a
reference score, display it, hear it, then load a recorded performance and get
note-level + timing feedback. The focus is the **pipeline and its stability**,
not design.

Both inputs accept multiple formats, all converging onto shared comparison logic:

- **Score**: MusicXML directly, **or** an image/PDF run through a built-in OMR
  step that emits MusicXML.
- **Performance**: a `.mid` file directly, **or** audio via two paths:
  - **Chroma** (`compareAudioChroma`) — fast qualitative match (~0.5 s), no note list.
  - **Polyphonic** (`audioToNotesPoly`, Spotify basic-pitch) — full note-level
    comparison including wrong/missed/extra, pre-quantized before DTW.

## How to run

```bash
npm install
npm run gen-assets   # writes the demo .mid, .wav and .svg into public/
npm run dev          # open http://localhost:3000
```

## E2E tests

```bash
cd fsa-prototype                  # must run from the project root
npx playwright install chromium   # first time only
npm run test:e2e                  # runs 24 tests (~45s, headless Chromium)
npm run test:e2e:ui               # interactive Playwright UI
```

Tests run through the real browser (no mocks). The exact note-level counts are
asserted against the deterministic synthetic pair (`public/sample.musicxml` +
the generated `public/sample-performance.mid`), driven via the file inputs:

| Test | Asserts |
|---|---|
| Page load | title, all sections present |
| MusicXML upload | 16 notes parsed, 100 BPM in the score heading, SVG rendered by OSMD |
| Keyboard | keys rendered after score load |
| MIDI compare | 14 match / 1 wrong / 1 missed / 0 extra / 1 late / 0 early, 87.5% |
| MIDI table | 16 rows; wrong row = E4→D#4; missed row = A4; late row is a match |
| MIDI feedback | practice text rendered in the feedback list |
| Perfect MIDI | 16 match / 0 errors, 100% |
| Hymn demo | `Load demo score (hymn)` parses + renders; `Use score (100% test)` → 100% |
| Custom MusicXML | uploaded `tetrachord.musicxml` → 4 notes, 120 BPM |
| Audio upload | `performance.wav` transcribed via basic-pitch → Compare enabled |
| Playback | ▶ Play → Playing/Stop state machine |
| State reset | loading a new score/performance clears the results panel |
| Error handling | invalid `.mid` → error in status, score stays loaded, no crash |

Then on the page:

1. **Load demo score (hymn)** — parses `public/jesus-lives.musicxml` and OSMD renders it.
   You can also **Upload .musicxml** or **Upload PDF / MXL / фото** (image/PDF goes
   through the Audiveris OMR route — see the OMR note below).
2. **▶ Play** — plays the reference with Tone.js + Salamander piano samples and highlights the keyboard.
3. Provide a performance — **Use score (100% test)** (deterministic self-compare),
   **Load demo performance (etalon mp3)** (transcribes the hymn recording with
   basic-pitch), **Upload .mid**, **Upload audio**, or **⏺ Record** from the mic.
4. **Compare** — runs DTW + timing fit and shows the results table, coaching summary, and feedback.

> **OMR note:** the live image/PDF path posts to `/api/omr`, which shells out to a
> local [Audiveris](https://github.com/Audiveris/audiveris) install (Java). It
> needs Audiveris present (configurable via `AUDIVERIS_APP_DIR` / `AUDIVERIS_JAVA_EXE`)
> and is **not** exercised by the e2e suite. The `.mxl`/`.musicxml`/`.xml`
> branches of the same route work without Java.

> `npm run gen-assets` is needed before the demo buttons work, because the demo
> `.mid` / `.wav` / `.svg` are generated rather than committed. `npm run build`
> does **not** generate them. (Individual scripts: `gen-midi`, `gen-audio`,
> `gen-image`.)

## Pipeline

```
SCORE
  MusicXML ───────────parse──────────┐
  image / PDF ──OMR──▶ MusicXML ──parse──▶ NoteEvent[] ──▶ display (OSMD)
                                                        ├──▶ virtual keyboard
                                                        └──▶ playback (Tone.js + Salamander)

PERFORMANCE
  MIDI (.mid) ────────────────────────────────▶ NoteEvent[]
  audio ──basic-pitch (polyphonic, TF.js)─────▶ NoteEvent[] ──quantize (16th grid)──▶ NoteEvent[]
  audio ──chroma (fast, FFT + DTW) ───────────▶ ChromaResult (no note list)

reference NoteEvent[] + performance NoteEvent[]
  ──collapseChords (mono path only)──▶
  ──DTW over pitch──▶ AlignStep[] (match/wrong/missed/extra)
  ──least-squares time fit──▶ late/early/on + tempoRatio
  ──assess()──▶ coaching summary (completeness / pitch / timing bands)
  ──buildFeedback()──▶ plain-text tips
```

Two design choices keep this stable: (1) every score input converges on
**MusicXML** and every performance input converges on a **`NoteEvent[]`**, so the
display, parser and comparison are shared, not duplicated; (2) the OMR and audio
**cores are pure functions** (`pixels → notes`, `samples → notes`) with the
browser-only bits (canvas, Web Audio, pdf.js) as thin wrappers — so the hard
parts are unit-tested in Node.

Source map:

| Stage                        | File                           |
| ---------------------------- | ------------------------------ |
| MusicXML parse + repeats     | `lib/musicxml.ts`              |
| MIDI parse                   | `lib/midi.ts`                  |
| OMR (image→score)            | `lib/omr.ts`                   |
| Audio→notes (monophonic)     | `lib/audio.ts`                 |
| Audio→notes (polyphonic)     | `lib/basicPitch.ts`            |
| Note decoder worker          | `lib/noteDecoder.worker.ts`    |
| Grid quantization            | `lib/quantize.ts`              |
| DTW + timing fit             | `lib/compare.ts`               |
| Qualitative coaching layer   | `lib/assessment.ts`            |
| Rule-based feedback          | `lib/feedback.ts`              |
| Chroma comparison (fast)     | `lib/chroma.ts`                |
| Score render (OSMD)          | `components/ScoreView.tsx`     |
| Keyboard                     | `components/PianoKeyboard.tsx` |
| Note-level results           | `components/ResultsPanel.tsx`  |
| Chroma results               | `components/ChromaPanel.tsx`   |
| Orchestration                | `app/page.tsx`                 |

### Algorithm details

- **Pitch → MIDI**: `12 * (octave + 1) + semitone + alter` (C4 = 60, A4 = 69).
  The parser tracks `<divisions>`, tempo from `<sound tempo>`, and a running
  position in divisions; it handles `<chord/>`, `<rest>`, and `<backup>`/`<forward>`.
- **DTW costs**: substitution `SUB = 2.0`, gap `GAP = 1.2`. Because
  `2*GAP = 2.4 > SUB`, a genuinely wrong note aligns as a single **substitution**
  rather than a `missed + extra` pair, and equal pitches align for free.
- **Timing**: a least-squares fit `perfSec = a*refSec + b` over the matched
  pairs. The slope `a` is the global tempo ratio (`a > 1` = played slower). A
  residual `|perfSec - (a*refSec + b)| > 0.15s` is flagged `late` (positive) or
  `early` (negative).
- **OMR (`lib/omr.ts`)**: from an RGBA bitmap — detect staff-line rows (rows that
  are dark across the width), derive line spacing, remove those rows, then take a
  vertical projection of the remaining ink; contiguous columns of ink are
  noteheads. Each notehead's ink centroid maps to a treble-clef staff slot →
  pitch. Detected notes are emitted as MusicXML so the rest of the pipeline is
  unchanged. **Constraints (v1):** clean single treble staff, monophonic, plain
  noteheads (no stems/beams/ledger lines/accidentals), 4/4 quarter notes. Real
  OMR needs a trained model + a validation step (see below).
- **Audio→notes monophonic (`lib/audio.ts`)**: per-frame pitch via the McLeod
  method (`pitchy`), gated by clarity threshold 0.78; 5-frame median smoothing;
  `mergeGaps(120 ms)` reassembles sustain-pedal fragments; `refineOctave()`
  corrects sub-harmonic locks; `minFreq=200 Hz` excludes bass below G3.
  Best results on single-voice recordings.
- **Audio→notes polyphonic (`lib/basicPitch.ts`)**: Spotify basic-pitch
  (Apache-2.0, TensorFlow.js, fully in-browser). Decodes to mono 22 050 Hz,
  runs neural onset/frame/contour model, decodes notes in a Web Worker.
  Handles piano chords and sustain; does NOT import `@tensorflow/tfjs` at the
  top level (basic-pitch bundles its own TF copy — a second copy causes kernel
  registration conflicts).
- **Grid quantization (`lib/quantize.ts`)**: applied to polyphonic audio output
  before DTW. Snaps note onsets to the nearest 16th-note grid at the reference
  BPM, then deduplicates same-pitch notes at the same grid slot (sustain ghost
  notes). Fixes chord micro-arpeggiation (2–10 ms finger offsets misread as
  sequential notes) and reduces ghost re-triggers from sustain pedal resonance.

## Improving the analysis (eval harness)

Tuning the audio→notes pipeline through the browser is slow (the basic-pitch CNN
runs ~10 s per clip in headless Chromium). The harness in `scripts/` splits that
into a slow capture and a fast tuning loop, because the CNN output is
deterministic for a given input:

```bash
npm run eval:seed             # populate eval/fixtures/ from the demo assets
npm run eval:capture          # SLOW (CNN, ~scales-with-length): cache tensors → eval/captures/
                              #   (skips already-captured fixtures; EVAL_FORCE=1 to redo)
npm run eval                  # FAST (<1s): score the post-CNN pipeline vs golden
npm run eval -- onsetThreshold=0.8 velocityThreshold=0.5   # override params for a sweep
npm run eval -- --save-golden # snapshot current scores as the regression baseline
npm run eval:reground         # re-derive ground truth from fixtures (after a parser change),
                              #   keeping cached tensors — no slow re-capture
npm run eval:calibrate        # score ↔ etalon recording → transcription ceiling
npm run eval:cross            # cross-comparison matrix: does it tell pieces apart?
```

**File-driven corpus (no hardcoding).** Drop a `<name>.musicxml` + matching
`<name>.{mp3,wav,m4a,ogg,flac}` pair into `eval/fixtures/` and it is picked up
automatically — the score is the ground truth, its `<sound tempo>` the bpm. mp3
is decoded in Node via `audio-decode`. `eval:seed` lays down a starter pair (the
hymn recording + score) plus a synthetic clean scale.

**Why it is fast.** The basic-pitch CNN output is deterministic, so `eval:capture`
runs it once and caches `frames/onsets/contours`. `eval` then re-runs only the
**tunable** stages against the cache — the exact decode from
`lib/noteDecoder.worker.ts` (basic-pitch's `outputToNotesPoly` /
`addPitchBendsToNoteEvents` / `noteFramesToTime`), then `quantizeNotes` /
`filterShortNotes` / `compare` / `cleanPhantomSteps` imported straight from
`lib/`. A threshold or DTW-cost change is scored in under a second.

**Metric.** The headline is **tempo-invariant**, derived from the DTW alignment
(real recordings drift from the score's nominal tempo, so absolute-onset matching
is meaningless): `recall` = score notes found, `precision` = fraction of detected
notes that are real (the rest are `extra` false positives), and their F1. `eval`
exits non-zero if any fixture's F1 drops >0.02 below `eval/golden.json`, so it
doubles as a regression gate. Cached tensors are gitignored; `golden.json` is
committed.

**What this caught.** The harness first exposed a *ground-truth* bug, not a model
bug: the hymn MusicXML has **two parts** (276 + 1136 notes) and the truth was
only counting the first, so the recording's real second-voice notes looked like
~599 false positives (apparent precision 20%). `loadScore` now merges **all**
parts (`npm run eval:reground` re-derives truth without re-capturing). Against the
true 1412 notes the pipeline scores **F1 69% (precision 71% / recall 67%, 23 true
extras)** — solid for dense two-part polyphony. A threshold sweep showed F1
**plateaus at ~69%**: stricter onset/velocity only trade recall for precision
along the same line, so the legacy SNR anchor is already near-optimal.

Two structural ideas were then tried on the harness and **shelved** because the
numbers said so, not by guess: (1) harmonic/octave ghost dedup (`ghostRatio`,
left in but default-off) — no gain, because extras are already few (23) and it
also clips genuine inter-voice octaves; (2) a polyphonic absolute-time note-match
metric — *worse* (F1 ~10%), because the recording's timing is globally offset
from the score's nominal tempo, which is exactly why the tempo-invariant DTW is
the right tool. The remaining ceiling is the model's **recall on dense
polyphony** (304 missed) — that needs a stronger transcription model or per-voice
separation, not more post-processing.

It then caught two **parser** bugs (not model bugs) in `lib/musicxml.ts`:
(1) MusicXML writes the tempo marking only in the top part, but the parser
tracked tempo per-part from a 120 qpm default, so lower voices drifted out of
sync (one fixture's second part ended 45 s early) — now a single initial tempo is
resolved for the whole score; (2) tied notes were emitted as separate re-attacks
instead of one sustained note — ties are now merged (extend duration, no new
onset), which both fixes playback and lifted jesus-lives recall 70→75%. Harness
span-vs-audio and F1 checks confirmed both fixes. The parser also falls back to a
textual tempo word (Allegro / Andante / Modéré …) when a score carries no numeric
tempo, instead of silently defaulting to 120 qpm.

> Lesson baked in: always validate the ground truth before tuning to it. Caveat:
> still few real recordings — add more `mp3+musicxml` fixtures and re-validate.
> Pre-CNN DSP changes need a re-capture; everything after the CNN is the fast loop.

### Discrimination (does it tell pieces apart?)

`npm run eval:cross` builds an *audio × score* matrix: each recording's
transcription compared against **every** fixture's score. The diagonal (same
piece) should read MATCH, every off-diagonal (different pieces) MISMATCH. Result
on the current corpus: **15/16 cells correct** — all 12 cross-piece pairs are
correctly rejected. Crucially, *pitch accuracy alone does not discriminate* (a
recording can hit 100% of a short scale's pitches by chance); the reliable signal
is the **timing residual ratio** — it stays ~0 on the right score and jumps to
3–29× on the wrong one, which is the same gate the app uses to flag a wrong
score. The one miss is a self-match on the most repetitive piece (two ×5
sections), where offline DTW aligns across repeat boundaries — a comparison-method
limit (→ online/segmented DTW), not a parse or transcription error.

### Calibration

`npm run eval:calibrate` compares a score against the transcription of its **own
etalon recording**. Since polyphonic transcription can't hit 100%, that run is
the *ceiling*: for the full two-part hymn it caps at **pitch 70% / coverage 79% /
on-time 59%** (transcribing both dense voices is hard — that is exactly why a
ceiling is needed). Student performances are then graded relative to this ceiling
(`lib/calibrate.ts` `normalizeAgainstBaseline`), not a fictional 100%. The ceiling
is written to `eval/calibration.json`.

## Why DTW

Performances vary in tempo, so raw timestamps cannot be compared directly — the
same note can land at a very different absolute time. DTW aligns the two **pitch
sequences** in a tempo-invariant way, producing a correct note-to-note
correspondence first. Only *after* that alignment do we look at timing, via the
linear fit, so tempo drift and local rubato don't masquerade as wrong notes.

## Feedback → LLM (production note)

The feedback in `lib/feedback.ts` is **deterministic** (fixed thresholds, no
model). In production this same structured `CompareResult` (counts, the
worst measure, the tempo ratio, per-note residuals) becomes the prompt context
for an LLM coaching layer that turns the numbers into natural, personalized
practice guidance — the prototype keeps it rule-based so the core stays
inspectable and reproducible.

## Scaling to long-piece position tracking

This prototype uses **offline DTW** because the recordings are short and fully
available up front. For tracking position inside a long piece in real time, the
approach generalizes to **online DTW** (incremental alignment over a sliding
window as audio/MIDI streams in) paired with a **confidence metric** on the
current alignment. When confidence drops — a repeat, a skip, a vamp — the system
triggers **global relocalization** (re-search the whole score for the best match)
and carries **multiple hypotheses** about the current position until the
evidence collapses them to one. The offline core here is the same cost model and
backtracking, just bounded to a window and run continuously.

## Scope & honest limits

The score (image/PDF→OMR) and performance (audio→pitch) paths are implemented
and unit-tested, but **deliberately constrained** so the core stays stable and
its behaviour is attributable to the algorithm rather than a flaky import:

- **OMR** handles a clean, single, monophonic treble staff with plain noteheads
  (no stems/beams/ledger lines/accidentals). It is a classical image-processing
  detector, not a trained model. Production OMR (e.g. a CNN/transformer model)
  must be paired with a human validation step before the result is trusted —
  that validation UI is out of scope here.
- **Audio→notes (mono)** is intentionally monophonic via `pitchy`; use the
  **poly / basic-pitch** path for piano recordings with chords or sustain pedal.
- **PDF** is rasterized (first page) via pdf.js and fed to the same detector; the
  bundled demo uses the SVG image path, which is the tested one.

Genuinely out of scope (v1), with reasons:

- **Real-time score-following** — see the scaling section; this v1 is offline.
- **Media library / copyright handling** — not relevant to the core algorithm.
- **Auth / database** — no users or persistence are needed for a single-session demo.
- **Design / styling polish** — the brief asks to verify the pipeline, not the UI.

## Tech stack

Next.js 16 (App Router, Turbopack) · TypeScript · React 19 · opensheetmusicdisplay
(lazy, client-only) · tone (Salamander Grand Piano samples) · @tonejs/midi ·
fast-xml-parser · pitchy (monophonic pitch detection) ·
@spotify/basic-pitch (polyphonic, TF.js, Apache-2.0) · pdfjs-dist (PDF raster).
All UI is in a single client component; OSMD, Tone, pdf.js and basic-pitch are
imported lazily, and the OMR/audio cores are pure, so nothing audio/DOM-bound
runs on the server.
 