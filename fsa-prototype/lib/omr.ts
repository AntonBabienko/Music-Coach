import type { NoteEvent } from "./types";

// Optical Music Recognition (OMR) for the SCORE input path:
//   image/PDF pixels -> note events -> MusicXML (so OSMD still renders it).
//
// The core `detectScore` is a PURE function over an RGBA bitmap, unit-testable
// in Node. Browser-only rasterization (canvas / pdf.js) is a thin wrapper.
//
// Scope (v1) — intentionally constrained for a stable core:
//   * single treble-clef staff, monophonic
//   * clean engraved noteheads (no stems/beams/ledger lines/accidentals)
//   * fixed 4/4, quarter notes (4 notes per measure)
// Real-world OMR needs a trained model plus a human validation step; that is
// out of scope here (see README). The detector reads pixels, so it works on any
// image matching these constraints, not just the bundled demo.

const LETTERS = "CDEFGAB";
const SEMITONE: Record<string, number> = {
  C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
};

export interface Bitmap {
  data: Uint8ClampedArray | number[]; // RGBA
  width: number;
  height: number;
}

export interface DetectedScore {
  notes: NoteEvent[];
  musicXml: string;
  /** True when the source score likely contains accidentals that OMR cannot detect.
   *  Caller should warn the user to verify pitches manually. */
  hasAccidentalWarning: boolean;
}

/** Map a vertical staff slot to a MIDI pitch.
 *  diatonicBase: bottom-line diatonic index (treble E4=30, bass G2=18). */
function slotToMidi(slot: number, diatonicBase = 30): number {
  const diatonicAbs = diatonicBase + slot;
  const octave = Math.floor(diatonicAbs / 7);
  const letter = LETTERS[((diatonicAbs % 7) + 7) % 7];
  return 12 * (octave + 1) + SEMITONE[letter];
}

function midiToStepOctave(midi: number): { step: string; octave: number } {
  // v1 produces only naturals; pick the natural letter for this pitch class.
  const pc = ((midi % 12) + 12) % 12;
  const letter =
    Object.keys(SEMITONE).find((k) => SEMITONE[k] === pc) ??
    // nearest natural below for any accidental (shouldn't occur in v1)
    "C";
  const octave = Math.floor(midi / 12) - 1;
  return { step: letter, octave };
}

// ---- local adaptive threshold (integral-image, O(n)) -----------------------

function buildIntegral(data: Uint8ClampedArray | number[], width: number, height: number): Float64Array {
  // integral[y*(width+1)+x] = sum of luminances for rect [0,0]..[x-1,y-1]
  const I = new Float64Array((width + 1) * (height + 1));
  const W = width + 1;
  for (let y = 0; y < height; y++) {
    let rowSum = 0;
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      rowSum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      I[(y + 1) * W + (x + 1)] = rowSum + I[y * W + (x + 1)];
    }
  }
  return I;
}

function makeAdaptiveDark(
  data: Uint8ClampedArray | number[],
  width: number,
  height: number,
  blockR: number,   // neighbourhood radius in pixels
  factor: number,   // dark if lum < localMean * factor
): (x: number, y: number) => boolean {
  const I = buildIntegral(data, width, height);
  const W = width + 1;
  return (x, y) => {
    const px = (y * width + x) * 4;
    if (data[px + 3] !== undefined && (data[px + 3] as number) < 16) return false;
    const x0 = Math.max(0, x - blockR), x1 = Math.min(width - 1, x + blockR);
    const y0 = Math.max(0, y - blockR), y1 = Math.min(height - 1, y + blockR);
    const area = (x1 - x0 + 1) * (y1 - y0 + 1);
    const sum = I[(y1 + 1) * W + (x1 + 1)] - I[y0 * W + (x1 + 1)]
              - I[(y1 + 1) * W + x0] + I[y0 * W + x0];
    const lum = 0.299 * data[px] + 0.587 * data[px + 1] + 0.114 * data[px + 2];
    return lum < (sum / area) * factor;
  };
}

// ---- staff / note detection ------------------------------------------------

/**
 * Detect notes in a bitmap and emit MusicXML.
 *
 * v2 improvements over v1:
 *  - Local adaptive threshold (integral image) handles uneven lighting in photos.
 *  - Barline / stem rejection by aspect ratio (height >> width → not a notehead).
 *  - Auto leftSkip: scans for the first barline after a minimum header zone and
 *    skips everything before it (handles variable key-sig / time-sig widths).
 *  - Whole-note detection: hollow + short interval height → whole note (4 beats).
 *  - Multi-staff: isolates the topmost staff automatically even when multiple
 *    staves are present (grand staff, etc.).
 */
export function detectScore(img: Bitmap, tempo = 100): DetectedScore {
  const { width, height } = img;
  const data = img.data;
  const t0 = performance.now();
  console.log(`[OMR] image ${width}×${height}`);

  // Block radius for adaptive threshold: ~1/8 of estimated staff spacing,
  // clamped so it's always at least 16px for thin/dense images.
  // We use a fixed 32px pass first; once we know spacing we could refine,
  // but 32px works well for both 200 dpi scans and 72 dpi screenshots.
  const dark = makeAdaptiveDark(data, width, height, 32, 0.85);

  // 1. Staff-line rows --------------------------------------------------------
  const rowDark = new Int32Array(height);
  for (let y = 0; y < height; y++) {
    let c = 0;
    for (let x = 0; x < width; x++) if (dark(x, y)) c++;
    rowDark[y] = c;
  }
  // A row is a staff line if it is dark across ≥ 25% of the image width.
  // Lower threshold (was 30%) catches partial staff lines in cropped images.
  const lineRowThresh = width * 0.25;
  const isLineRow = Array.from({ length: height }, (_, y) => rowDark[y] > lineRowThresh);

  // Cluster consecutive line-rows into staff lines.
  const lineCenters: number[] = [];
  let runStart = -1;
  for (let y = 0; y <= height; y++) {
    const on = y < height && isLineRow[y];
    if (on && runStart < 0) runStart = y;
    if (!on && runStart >= 0) { lineCenters.push((runStart + y - 1) / 2); runStart = -1; }
  }
  console.log(`[OMR] raw lines: ${lineCenters.length} ${(performance.now() - t0).toFixed(0)}ms`);
  if (lineCenters.length < 2) throw new Error(`OMR: only ${lineCenters.length} staff line(s) detected — need a cleaner image.`);

  // Isolate the topmost staff: cut off when gap > 2× the median within-staff gap.
  const sorted = [...lineCenters].sort((a, b) => a - b);
  const gaps = sorted.slice(1).map((y, i) => y - sorted[i]);
  const medGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 10;
  const staff: number[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] - sorted[i - 1] > medGap * 2) break;
    staff.push(sorted[i]);
  }

  const staffSorted = [...staff].sort((a, b) => a - b);
  const lineGaps: number[] = staffSorted.slice(1).map((y, i) => y - staffSorted[i]);
  lineGaps.sort((a, b) => a - b);
  const spacing = lineGaps[Math.floor(lineGaps.length / 2)] ?? medGap;
  const halfSlot = spacing / 2;
  const yBottom = staffSorted[staffSorted.length - 1];

  const staffTop    = Math.max(0,         Math.floor(staffSorted[0]  - spacing * 2.5));
  const staffBottom = Math.min(height - 1, Math.ceil(yBottom         + spacing * 2.5));
  const staffHeight = staffBottom - staffTop;

  console.log(`[OMR] staff: ${staff.length} lines, spacing=${spacing.toFixed(1)} staffTop=${staffTop} staffBottom=${staffBottom}`);

  // Note zone: restrict to at most 1×spacing above the top staff line so that
  // beams (which live 1.5–3 spacings above for stems-up notes) are excluded
  // from the column projection. Without this, a wide beam makes the row-ink
  // threshold so high that individual notehead peaks fall below it.
  const noteZoneTop = Math.max(staffTop, Math.round(staffSorted[0] - spacing * 1.0));

  // 2. Column projection (staff-line rows excluded, beam zone excluded) --------
  const colDark = new Int32Array(width);
  for (let x = 0; x < width; x++) {
    let c = 0;
    for (let y = noteZoneTop; y <= staffBottom; y++) {
      if (!isLineRow[y] && dark(x, y)) c++;
    }
    colDark[x] = c;
  }

  // 3. Detect all column intervals (ink blobs) --------------------------------
  const colThresh   = Math.max(2, spacing * 0.20); // lowered: catches narrow notehead edges
  const minNoteW    = Math.max(2, spacing * 0.30);
  type Iv = { x0: number; x1: number };
  function collectIntervals(fromX: number): Iv[] {
    const ivs: Iv[] = [];
    let s = -1;
    for (let x = fromX; x <= width; x++) {
      const on = x < width && colDark[x] >= colThresh;
      if (on && s < 0) s = x;
      if (!on && s >= 0) { if (x - s >= minNoteW) ivs.push({ x0: s, x1: x - 1 }); s = -1; }
    }
    return ivs;
  }

  // 4. Auto-detect header end -------------------------------------------------
  // The header (clef + key sig + time sig) ends at the first barline after a
  // minimum zone. A barline is a narrow interval (width ≤ spacing*0.35) that is
  // tall (dark height > staffHeight * 0.6).
  const minHeaderZone = Math.round(spacing * 2.5); // clef alone is ~2.5 spacings
  const allIvs = collectIntervals(minHeaderZone);

  function ivDarkHeight(iv: Iv): number {
    let top = staffBottom, bot = staffTop;
    for (let y = staffTop; y <= staffBottom; y++) {
      if (isLineRow[y]) continue;
      for (let x = iv.x0; x <= iv.x1; x++) {
        if (dark(x, y)) { top = Math.min(top, y); bot = Math.max(bot, y); break; }
      }
    }
    return bot >= top ? bot - top + 1 : 0;
  }

  function isBarline(iv: Iv): boolean {
    const w = iv.x1 - iv.x0 + 1;
    if (w > spacing * 0.4) return false;          // too wide
    return ivDarkHeight(iv) > staffHeight * 0.55; // tall enough
  }

  // Find first barline → everything up to and including it is the header.
  let leftSkip = minHeaderZone;
  for (const iv of allIvs) {
    if (isBarline(iv)) { leftSkip = iv.x1 + 1; break; }
    // Stop search after a reasonable header width (8 spacings).
    if (iv.x0 > spacing * 8) break;
  }
  console.log(`[OMR] leftSkip=${leftSkip} (${(performance.now() - t0).toFixed(0)}ms)`);

  // 4b. Key-signature accidental detection ------------------------------------
  // Count small dark blobs in the header zone (between clef end and first barline).
  // A key signature places 1–7 sharp or flat symbols there; each is a narrow blob
  // (width < spacing*0.6) that is NOT a barline. If we find ≥1, warn the user that
  // OMR cannot read accidentals and pitches may be wrong.
  const headerIvs = allIvs.filter((iv) => iv.x1 < leftSkip);
  const keyAccidentalBlobs = headerIvs.filter((iv) => {
    const w = iv.x1 - iv.x0 + 1;
    return w < spacing * 0.6 && !isBarline(iv) && ivDarkHeight(iv) > spacing * 0.5;
  });
  const hasAccidentalWarning = keyAccidentalBlobs.length >= 1;
  if (hasAccidentalWarning) {
    console.log(`[OMR] key signature detected (${keyAccidentalBlobs.length} accidental blob(s)) — pitches may be wrong`);
  }

  // 5. Notehead detection in the note zone ------------------------------------
  const noteIvs = collectIntervals(leftSkip);
  const diatonicBase = 30; // treble clef E4 bottom line
  const clefSign = "G", clefLine = 2;

  const detected: { x: number; midi: number; beats: number }[] = [];
  const bucketLen = staffBottom - staffTop + 1;

  for (const iv of noteIvs) {
    const ivW = iv.x1 - iv.x0 + 1;

    // Row-ink histogram within this interval.
    const rowInk = new Int32Array(bucketLen);
    let maxInk = 0;
    for (let y = staffTop; y <= staffBottom; y++) {
      if (isLineRow[y]) continue;
      let c = 0;
      for (let x = iv.x0; x <= iv.x1; x++) if (dark(x, y)) c++;
      rowInk[y - staffTop] = c;
      if (c > maxInk) maxInk = c;
    }
    if (maxInk < 2) continue;

    // Reject barlines: tall + narrow.
    const darkH = ivDarkHeight(iv);
    if (ivW <= spacing * 0.4 && darkH > staffHeight * 0.5) continue;

    // Reject pure stems: height > 2× spacing AND width < 0.3× spacing.
    if (darkH > spacing * 2 && ivW < spacing * 0.3) continue;

    const inkThresh = Math.max(2, maxInk * 0.35);
    const cx = (iv.x0 + iv.x1) / 2;

    // Cluster rows with enough ink into individual noteheads.
    type Cluster = { sumY: number; sumW: number; inkRows: number };
    const clusters: Cluster[] = [];
    let cur: Cluster | null = null;
    let lastY = -999;
    for (let b = 0; b < bucketLen; b++) {
      if (rowInk[b] < inkThresh) continue;
      const y = b + staffTop;
      if (!cur || y - lastY > halfSlot * 1.2) {
        cur = { sumY: 0, sumW: 0, inkRows: 0 };
        clusters.push(cur);
      }
      cur.sumY += y * rowInk[b];
      cur.sumW += rowInk[b];
      cur.inkRows++;
      lastY = y;
    }

    for (const cl of clusters) {
      if (cl.inkRows < 2) continue; // single row = noise
      const cy = cl.sumY / cl.sumW;
      const slot = Math.round((yBottom - cy) / halfSlot);
      const midi = slotToMidi(slot, diatonicBase);
      if (midi < 36 || midi > 96) continue; // sanity: C2..C7

      // Duration classification:
      //   filled center → quarter (1 beat)
      //   hollow + tall interval (has stem) → half (2 beats)
      //   hollow + short interval (no stem) → whole (4 beats)
      const r = Math.round(halfSlot * 0.55);
      let darkPx = 0, totalPx = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const px = Math.round(cx) + dx, py = Math.round(cy) + dy;
          if (px < 0 || px >= width || py < staffTop || py > staffBottom) continue;
          if (isLineRow[py]) continue;
          totalPx++;
          if (dark(px, py)) darkPx++;
        }
      }
      const fillRatio = totalPx > 0 ? darkPx / totalPx : 1;
      const filled = fillRatio > 0.4;
      const hasStem = darkH > spacing * 1.8;
      const beats = filled ? 1 : hasStem ? 2 : 4;

      detected.push({ x: cx, midi, beats });
    }
  }

  detected.sort((a, b) => a.x - b.x);
  console.log(`[OMR] detected ${detected.length} noteheads ${(performance.now() - t0).toFixed(0)}ms`);

  if (detected.length === 0) throw new Error("OMR: no noteheads found. Try a higher-contrast image with a visible staff.");

  // 6. Build NoteEvent[] ------------------------------------------------------
  const quarter = 60 / tempo;
  let onset = 0;
  const notes: NoteEvent[] = detected.map((d) => {
    const dur = d.beats * quarter;
    const note: NoteEvent = { midi: d.midi, onsetSec: onset, durationSec: dur, measure: Math.floor(onset / (quarter * 4)) + 1 };
    onset += dur;
    return note;
  });

  return { notes, musicXml: notesToMusicXml(notes, tempo, clefSign, clefLine), hasAccidentalWarning };
}

/** MusicXML emitter: 4/4, divisions=1, supports quarter and half notes. */
export function notesToMusicXml(
  notes: NoteEvent[],
  tempo: number,
  clefSign = "G",
  clefLine = 2,
): string {
  const quarter = 60 / tempo;
  // Group notes by measure number (already set by detectScore).
  const byMeasure = new Map<number, NoteEvent[]>();
  for (const n of notes) {
    const m = n.measure ?? 1;
    if (!byMeasure.has(m)) byMeasure.set(m, []);
    byMeasure.get(m)!.push(n);
  }
  const measureNums = [...byMeasure.keys()].sort((a, b) => a - b);
  const measures: string[] = measureNums.map((m, idx) => {
    const slice = byMeasure.get(m)!;
    const noteXml = slice
      .map((n) => {
        const { step, octave } = midiToStepOctave(n.midi);
        const beats = n.durationSec ? Math.round(n.durationSec / quarter) : 1;
        const dur = beats >= 4 ? 4 : beats >= 2 ? 2 : 1;
        const type = beats >= 4 ? "whole" : beats >= 2 ? "half" : "quarter";
        return `      <note>
        <pitch><step>${step}</step><octave>${octave}</octave></pitch>
        <duration>${dur}</duration>
        <type>${type}</type>
      </note>`;
      })
      .join("\n");
    const attrs =
      idx === 0
        ? `      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>${clefSign}</sign><line>${clefLine}</line></clef>
      </attributes>
      <sound tempo="${tempo}"/>\n`
        : "";
    return `    <measure number="${m}">\n${attrs}${noteXml}\n    </measure>`;
  });

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list>
    <score-part id="P1"><part-name>OMR</part-name></score-part>
  </part-list>
  <part id="P1">
${measures.join("\n")}
  </part>
</score-partwise>
`;
}

// ---- browser-only rasterization wrappers -----------------------------------

// Target width for OMR processing. Images smaller than MIN are upscaled (up to
// 2× max); images larger than MAX are downscaled. Larger = better pitch accuracy
// (spacing grows proportionally) but more memory and CPU.
const MIN_SCAN_WIDTH = 1800;
const MAX_SCAN_WIDTH = 2400;

/** Draw an HTMLImageElement / bitmap source to a canvas and read RGBA pixels.
 *  Upscales images narrower than MIN_SCAN_WIDTH (up to 2×) and downscales
 *  images wider than MAX_SCAN_WIDTH. */
function canvasToBitmap(
  source: CanvasImageSource,
  srcWidth: number,
  srcHeight: number
): Bitmap {
  // Scale up small images to improve spacing resolution; cap upscale at 2×.
  const scaleUp = Math.min(2, MIN_SCAN_WIDTH / srcWidth);
  const scaleDown = Math.min(1, MAX_SCAN_WIDTH / srcWidth);
  const scale = Math.max(scaleUp, scaleDown);
  const width = Math.round(srcWidth * scale);
  const height = Math.round(srcHeight * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff"; // flatten transparency onto white
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  return { data, width, height };
}

async function imageBlobToBitmap(blob: Blob): Promise<Bitmap> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Failed to load image."));
      el.src = url;
    });
    const w = img.naturalWidth || 600;
    const h = img.naturalHeight || 200;
    return canvasToBitmap(img, w, h);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function pdfToBitmap(buffer: ArrayBuffer): Promise<Bitmap> {
  const pdfjs = await import("pdfjs-dist");
  // Use a CDN URL for the worker so it resolves correctly in all bundlers
  // (import.meta.url points to the Next.js bundle chunk, not the worker file).
  pdfjs.GlobalWorkerOptions.workerSrc = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;

  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise;
  const page = await doc.getPage(1);
  // Render PDF at MIN_SCAN_WIDTH so staff spacing is large enough for accuracy.
  const baseViewport = page.getViewport({ scale: 1 });
  const pdfScale = MIN_SCAN_WIDTH / baseViewport.width;
  const viewport = page.getViewport({ scale: pdfScale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport }).promise;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { data, width: canvas.width, height: canvas.height };
}

/** Browser convenience: an uploaded image or PDF file → detected score. */
export async function fileToScore(file: File, tempo = 100): Promise<DetectedScore> {
  const isPdf =
    file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf");
  const bitmap = isPdf
    ? await pdfToBitmap(await file.arrayBuffer())
    : await imageBlobToBitmap(file);
  return detectScore(bitmap, tempo);
}

/** Browser convenience: fetch an image URL (e.g. the demo SVG) → detected score. */
export async function imageUrlToScore(url: string, tempo = 100): Promise<DetectedScore> {
  const blob = await (await fetch(url)).blob();
  return detectScore(await imageBlobToBitmap(blob), tempo);
}

/**
 * Recalculate onsetSec/durationSec for already-detected notes at a new tempo.
 * Use this when the user changes the BPM slider after OMR — avoids re-running detection.
 */
export function rescaleOmrTempo(notes: NoteEvent[], oldTempo: number, newTempo: number): NoteEvent[] {
  if (oldTempo <= 0 || newTempo <= 0 || oldTempo === newTempo) return notes;
  const ratio = oldTempo / newTempo;
  return notes.map((n) => ({
    ...n,
    onsetSec: n.onsetSec * ratio,
    durationSec: n.durationSec != null ? n.durationSec * ratio : undefined,
  }));
}
