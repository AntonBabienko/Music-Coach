import { Midi } from "@tonejs/midi";
import type { NoteEvent } from "./types";

export interface MidiTrack {
  index: number;
  name: string;
  notes: NoteEvent[];
}

export interface ParsedMidi {
  /** Notes of the first non-empty track (backward-compatible default). */
  notes: NoteEvent[];
  /** All tracks that contain at least one note. */
  tracks: MidiTrack[];
}

/**
 * Parse a .mid file into per-track note events.
 * Returns all non-empty tracks separately so the UI can let the user pick
 * which track to compare against (melody vs accompaniment).
 */
export function parseMidi(buffer: ArrayBuffer): ParsedMidi {
  const midi = new Midi(buffer);
  const tracks: MidiTrack[] = [];

  midi.tracks.forEach((track, idx) => {
    if (track.notes.length === 0) return;
    const notes: NoteEvent[] = track.notes.map((n) => ({
      midi: n.midi,
      onsetSec: n.time,
      durationSec: n.duration,
      velocity: n.velocity,
    }));
    notes.sort((a, b) => a.onsetSec - b.onsetSec || a.midi - b.midi);
    tracks.push({
      index: idx,
      name: track.name || `Track ${idx + 1}`,
      notes,
    });
  });

  const firstNotes = tracks[0]?.notes ?? [];
  return { notes: firstNotes, tracks };
}
