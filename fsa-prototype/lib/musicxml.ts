import { XMLParser } from "fast-xml-parser";
import type { NoteEvent } from "./types";

// We parse with preserveOrder so that <note>, <backup>, <forward> and tempo
// directions are visited in document order — order matters for the running
// time position. fast-xml-parser is used (over DOMParser) so the same code
// runs in the browser and in Node without environment quirks.

const SEMITONE: Record<string, number> = {
  C: 0,
  D: 2,
  E: 4,
  F: 5,
  G: 7,
  A: 9,
  B: 11,
};

// ---- helpers over the preserveOrder node shape -----------------------------
// Each node is an object with exactly one tag key (whose value is an array of
// child nodes) plus an optional ":@" key holding attributes.

type PNode = Record<string, unknown>;

function tagName(node: PNode): string {
  return Object.keys(node).find((k) => k !== ":@") ?? "";
}

function childrenOf(node: PNode): PNode[] {
  const t = tagName(node);
  const v = node[t];
  return Array.isArray(v) ? (v as PNode[]) : [];
}

function attrsOf(node: PNode): Record<string, string> {
  return (node[":@"] as Record<string, string>) ?? {};
}

/** Text content of a leaf node, e.g. <octave>4</octave> -> "4". */
function textOf(node: PNode): string {
  for (const child of childrenOf(node)) {
    if ("#text" in child) return String((child as Record<string, unknown>)["#text"]);
  }
  return "";
}

function findChild(node: PNode, name: string): PNode | undefined {
  return childrenOf(node).find((c) => tagName(c) === name);
}

/** Recursively search a subtree for the first node with the given tag. */
function findDeep(node: PNode, name: string): PNode | undefined {
  for (const child of childrenOf(node)) {
    if (tagName(child) === name) return child;
    const deeper = findDeep(child, name);
    if (deeper) return deeper;
  }
  return undefined;
}

/** Repeat and volta-ending barline info for a single measure. */
function barlineInfo(measure: PNode): {
  forward: boolean;
  backwardTimes: number | null;
  endingStart: number | null; // ending number that opens here (1, 2, …)
  endingClose: boolean;       // ending bracket closes here (stop or discontinue)
} {
  let forward = false;
  let backwardTimes: number | null = null;
  let endingStart: number | null = null;
  let endingClose = false;
  for (const el of childrenOf(measure)) {
    if (tagName(el) !== "barline") continue;
    const rep = findChild(el, "repeat");
    if (rep) {
      const dir = attrsOf(rep)["@_direction"];
      if (dir === "forward") forward = true;
      else if (dir === "backward") {
        const t = parseInt(attrsOf(rep)["@_times"] ?? "", 10);
        // MusicXML `times` = total plays; default 2 (one repeat).
        backwardTimes = Number.isFinite(t) && t > 1 ? t : 2;
      }
    }
    const ending = findChild(el, "ending");
    if (ending) {
      const type = attrsOf(ending)["@_type"];
      if (type === "start") {
        const num = parseInt(attrsOf(ending)["@_number"] ?? "1", 10) || 1;
        endingStart = num;
      }
      if (type === "stop" || type === "discontinue") endingClose = true;
    }
  }
  return { forward, backwardTimes, endingStart, endingClose };
}

/**
 * Expand repeats (including volta endings) into a linear measure sequence.
 *
 * Handles:
 *   - Simple forward/backward repeats with optional `times` (verse hymns etc.)
 *   - Volta brackets (1st/2nd endings): on pass N, skip endings numbered ≠ N.
 *     Typical pattern: ||: A [1. B :|| [2. C || → plays A B A C.
 *   - Multi-measure volta brackets (ending bracket spans several measures).
 *   - Multiple independent repeated sections in a single part.
 *
 * Scores with no repeats pass through unchanged. Nested repeats are not
 * supported (very rare in standard scores).
 */
function expandRepeats(measures: PNode[]): PNode[] {
  const out: PNode[] = [];
  let i = 0;
  let sectionStart = 0;  // index of the most recent forward-repeat measure
  let pass = 1;          // which pass through the current section we're on
  let maxPasses = 2;     // set by backward-repeat `times`
  let currentEnding: number | null = null; // ending number we're currently inside
  let guard = 0;
  const maxSteps = measures.length * 64 + 64;

  while (i < measures.length && guard++ < maxSteps) {
    const measure = measures[i];
    const { forward, backwardTimes, endingStart, endingClose } = barlineInfo(measure);

    // Enter a volta bracket.
    if (endingStart != null) currentEnding = endingStart;

    // On pass N, skip measures that belong to a different ending.
    if (currentEnding != null && currentEnding !== pass) {
      if (endingClose) currentEnding = null;
      i++;
      continue;
    }

    // Forward repeat: mark new section start (don't reset pass — that's done
    // only when a section is exhausted, so a second pass keeps its counter).
    if (forward) sectionStart = i;

    out.push(measure);

    // Exit the volta bracket.
    if (endingClose) currentEnding = null;

    if (backwardTimes != null) {
      maxPasses = backwardTimes;
      if (pass < maxPasses) {
        pass++;
        currentEnding = null;
        i = sectionStart;
        continue;
      }
      // Section fully played; reset state for a possible next repeated section.
      sectionStart = i + 1;
      pass = 1;
      maxPasses = 2;
      currentEnding = null;
    }

    i++;
  }
  return out;
}

/**
 * Resolve a tempo (in quarter-notes per minute) from a <sound> or <direction>
 * element, or null if it carries none. Prefers a written <metronome> marking
 * over the <sound tempo> playback field (notation editors can disagree).
 */
function tempoFromElement(el: PNode, tag: string): number | null {
  if (tag === "direction") {
    const metronome = findDeep(el, "metronome");
    if (metronome) {
      const pm = findChild(metronome, "per-minute");
      if (pm) {
        const perMinute = parseFloat(textOf(pm));
        if (perMinute > 0) {
          const beatUnit = textOf(findChild(metronome, "beat-unit") ?? {} as PNode);
          const dotted = !!findChild(metronome, "beat-unit-dot");
          const unitMap: Record<string, number> = {
            whole: 4, half: 2, quarter: 1, eighth: 0.5, "16th": 0.25, "32nd": 0.125,
          };
          const unitQuarters = (unitMap[beatUnit] ?? 1) * (dotted ? 1.5 : 1);
          return perMinute * unitQuarters;
        }
      }
    }
  }
  const sound = tag === "sound" ? el : findDeep(el, "sound");
  if (sound) {
    const t = attrsOf(sound)["@_tempo"];
    if (t) return parseFloat(t) || null;
  }
  return null;
}

// Approximate qpm for textual tempo words, used only as a fallback when a score
// carries no numeric tempo (no <sound tempo> / <metronome>). Italian terms plus
// common French/German equivalents. Values are conventional mid-range tempi.
const TEMPO_WORDS: Record<string, number> = {
  grave: 40, largo: 50, larghetto: 63, lento: 52, adagietto: 72, adagio: 66,
  andantino: 96, andante: 92, moderato: 108, allegretto: 112, allegro: 132,
  vivace: 160, vivo: 160, prestissimo: 200, presto: 184,
  // French
  lent: 52, "modéré": 108, modere: 108, "animé": 120, anime: 120, vif: 160, rapide: 170,
  // German
  langsam: 60, "mäßig": 108, massig: 108, lebhaft: 138, schnell: 150,
};

// Longest keys first so e.g. "allegretto" is matched before "allegro".
const TEMPO_WORD_KEYS = Object.keys(TEMPO_WORDS).sort((a, b) => b.length - a.length);

function tempoFromWords(text: string): number | null {
  const t = text.toLowerCase();
  for (const key of TEMPO_WORD_KEYS) {
    if (t.includes(key)) return TEMPO_WORDS[key];
  }
  return null;
}

/** First tempo marking anywhere in the score (scanning all parts in order).
 *  Tempo directions usually live only in the top part, so every part must start
 *  from this shared value — otherwise parts without their own marking default to
 *  120 and drift out of sync with the rest. Falls back to a textual tempo word
 *  (Allegro, Andante, …) when no numeric tempo is present, then to 120. */
function findInitialTempo(partNodes: PNode[]): number {
  let wordTempo: number | null = null;
  for (const part of partNodes) {
    for (const measure of childrenOf(part)) {
      if (tagName(measure) !== "measure") continue;
      for (const el of childrenOf(measure)) {
        const t = tagName(el);
        if (t === "sound" || t === "direction") {
          const resolved = tempoFromElement(el, t);
          if (resolved != null) return resolved; // numeric wins
        }
        // Remember the first textual tempo word, but keep looking for a number.
        if (wordTempo == null && t === "direction") {
          const words = findDeep(el, "words");
          if (words) wordTempo = tempoFromWords(textOf(words));
        }
      }
    }
  }
  return wordTempo ?? 120;
}

function pitchToMidi(pitchNode: PNode): number {
  const step = textOf(findChild(pitchNode, "step")!).trim().toUpperCase();
  const octave = parseInt(textOf(findChild(pitchNode, "octave")!), 10);
  const alterNode = findChild(pitchNode, "alter");
  const alter = alterNode ? parseFloat(textOf(alterNode)) || 0 : 0;
  return 12 * (octave + 1) + (SEMITONE[step] ?? 0) + alter;
}

export interface ScorePart {
  id: string;
  name: string;
  notes: NoteEvent[];
}

export interface ParsedScore {
  /** Notes of the first part (backward-compatible default). */
  notes: NoteEvent[];
  tempo: number;
  /** All parts in document order, for multi-voice scores. */
  parts: ScorePart[];
}

/**
 * Parse a MusicXML string into ordered note events plus the (last seen) tempo.
 *
 * Tracks <divisions> (may change), tempo from <sound tempo>, and a running
 * position measured in divisions. Handles <chord/> (shares the previous onset,
 * does not advance time), <rest> (advances time, emits no note), and basic
 * <backup>/<forward>. onsetSec = (positionDivisions / divisions) * 60 / tempo.
 */
export function parseMusicXML(xml: string): ParsedScore {
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });

  const root = parser.parse(xml) as PNode[];

  // Support both score-partwise and (rarely) the timewise wrapper.
  let scoreNode: PNode | undefined;
  for (const top of root) {
    const t = tagName(top);
    if (t === "score-partwise" || t === "score-timewise") {
      scoreNode = top;
      break;
    }
  }
  if (!scoreNode) {
    throw new Error("No <score-partwise> element found in MusicXML.");
  }

  let tempo = 120;
  const parsedParts: ScorePart[] = [];

  // Build a name map from <part-list> so we can label parts in the UI.
  const partListNode = childrenOf(scoreNode).find((n) => tagName(n) === "part-list");
  const partNameMap = new Map<string, string>();
  if (partListNode) {
    for (const sp of childrenOf(partListNode)) {
      if (tagName(sp) !== "score-part") continue;
      const id = attrsOf(sp)["@_id"] ?? "";
      const nameNode = findChild(sp, "part-name");
      const name = nameNode ? textOf(nameNode).trim() : id;
      partNameMap.set(id, name || id);
    }
  }

  const partNodes = childrenOf(scoreNode).filter((n) => tagName(n) === "part");

  // Tempo is a global property of the score, but MusicXML usually writes the
  // marking only in the top part. Resolve it once up front so every part shares
  // the same initial tempo (otherwise lower parts default to 120 qpm and their
  // note onsets drift away from the top part and the recording).
  const initialTempo = findInitialTempo(partNodes);
  tempo = initialTempo;

  for (const part of partNodes) {
    const partId = attrsOf(part)["@_id"] ?? "";
    const partName = partNameMap.get(partId) ?? partId;
    const partNotes: NoteEvent[] = [];
    let divisions = 1;
    let position = 0;
    let lastNoteOnset = 0;
    // Open ties keyed by pitch: a <note> with <tie type="stop"> continues the
    // held note of the same pitch (extend its duration) instead of re-attacking.
    const openTies = new Map<number, NoteEvent>();

    // Wall-clock tracking: accumulate elapsed seconds segment-by-segment so
    // that tempo changes mid-piece don't retroactively re-scale all prior
    // note onsets. `advance()` must be called before any change to partTempo
    // or divisions; `onsetAt()` converts a raw-divisions position to seconds.
    let timeSec = 0;
    let lastCheckPos = 0;
    let partTempo = initialTempo;
    const advance = (toPos: number) => {
      if (toPos > lastCheckPos) {
        timeSec += (toPos - lastCheckPos) / divisions * (60 / partTempo);
        lastCheckPos = toPos;
      }
    };
    const onsetAt = (divPos: number): number =>
      timeSec + (divPos - lastCheckPos) / divisions * (60 / partTempo);

    const measures = childrenOf(part).filter((n) => tagName(n) === "measure");
    const playback = expandRepeats(measures);

    for (const measure of playback) {
      const measureNumber =
        parseInt(attrsOf(measure)["@_number"] ?? "", 10) || partNotes.length;

      for (const el of childrenOf(measure)) {
        const tag = tagName(el);

        if (tag === "attributes") {
          const div = findChild(el, "divisions");
          if (div) {
            const d = parseInt(textOf(div), 10);
            if (d > 0) {
              advance(position); // flush before divisions change
              divisions = d;
            }
          }
        } else if (tag === "sound" || tag === "direction") {
          const resolved = tempoFromElement(el, tag);
          if (resolved != null) {
            advance(position); // flush before tempo change
            partTempo = resolved;
            tempo = resolved;
          }
        } else if (tag === "backup") {
          const dur = parseInt(textOf(findChild(el, "duration")!), 10) || 0;
          position = Math.max(0, position - dur);
        } else if (tag === "forward") {
          const dur = parseInt(textOf(findChild(el, "duration")!), 10) || 0;
          position += dur;
        } else if (tag === "note") {
          const isChord = !!findChild(el, "chord");
          const isRest = !!findChild(el, "rest");
          const isGrace = !!findChild(el, "grace");
          const durNode = findChild(el, "duration");
          const dur = durNode ? parseInt(textOf(durNode), 10) || 0 : 0;

          const onsetDivisions = isChord ? lastNoteOnset : position;

          if (!isRest) {
            const pitch = findChild(el, "pitch");
            if (pitch) {
              const midi = pitchToMidi(pitch);
              const durSec = (dur / divisions) * (60 / partTempo);
              // A tie binds two notated notes into one sounding note. <tie> (the
              // sounding element, distinct from notation-only <tied>) carries
              // type="start"/"stop"; a note may have both (mid-chain).
              const tieTypes = childrenOf(el)
                .filter((c) => tagName(c) === "tie")
                .map((c) => attrsOf(c)["@_type"]);
              const tieStop = tieTypes.includes("stop");
              const tieStart = tieTypes.includes("start");
              const held = tieStop ? openTies.get(midi) : undefined;

              if (held) {
                // Continuation: extend the held note, emit no new onset.
                held.durationSec = (held.durationSec ?? 0) + durSec;
                if (!tieStart) openTies.delete(midi);
              } else {
                const note: NoteEvent = {
                  midi,
                  onsetSec: onsetAt(onsetDivisions),
                  durationSec: durSec,
                  measure: measureNumber,
                };
                partNotes.push(note);
                if (tieStart) openTies.set(midi, note);
              }
            }
          }

          // Grace notes steal time from the following note and must NOT advance
          // the position counter; the surrounding notes already account for the
          // stolen duration in their own <duration> values.
          if (!isChord && !isGrace) {
            lastNoteOnset = position;
            position += dur;
          }
        }
      }
    }

    partNotes.sort((a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi);
    parsedParts.push({ id: partId, name: partName, notes: partNotes });
  }

  const firstNotes = parsedParts[0]?.notes ?? [];
  return { notes: firstNotes, tempo, parts: parsedParts };
}
