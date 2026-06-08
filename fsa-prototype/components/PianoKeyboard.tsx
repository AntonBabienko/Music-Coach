"use client";

// A static virtual piano keyboard that highlights a set of active MIDI notes.
// Rendered with plain divs and inline styles (design is intentionally minimal).

const FIRST_MIDI = 48; // C3
const LAST_MIDI = 84; // C6

const BLACK_OFFSETS = new Set([1, 3, 6, 8, 10]); // pitch classes that are black keys

function isBlack(midi: number): boolean {
  return BLACK_OFFSETS.has(((midi % 12) + 12) % 12);
}

function noteName(midi: number): string {
  const names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const octave = Math.floor(midi / 12) - 1;
  return `${names[midi % 12]}${octave}`;
}

export default function PianoKeyboard({ active }: { active: Set<number> }) {
  const whiteKeys: number[] = [];
  for (let m = FIRST_MIDI; m <= LAST_MIDI; m++) {
    if (!isBlack(m)) whiteKeys.push(m);
  }

  const whiteWidth = 28;
  const blackWidth = 18;

  return (
    <div
      data-testid="piano-keyboard"
      className="panel"
      style={{ overflowX: "auto", paddingBottom: 8 }}
    >
      <div
        style={{
          position: "relative",
          height: 130,
          width: whiteKeys.length * whiteWidth,
        }}
      >
        {/* white keys */}
        {whiteKeys.map((m, idx) => {
          const on = active.has(m);
          return (
            <div
              key={m}
              title={noteName(m)}
              style={{
                position: "absolute",
                left: idx * whiteWidth,
                top: 0,
                width: whiteWidth - 1,
                height: 130,
                background: on ? "#4f8cff" : "#fafafa",
                border: "1px solid #888",
                borderRadius: "0 0 4px 4px",
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
                fontSize: 9,
                color: on ? "#fff" : "#555",
                paddingBottom: 3,
              }}
            >
              {m % 12 === 0 ? noteName(m) : ""}
            </div>
          );
        })}

        {/* black keys, positioned over the gaps */}
        {whiteKeys.map((m, idx) => {
          const next = m + 1;
          if (next > LAST_MIDI || !isBlack(next)) return null;
          const on = active.has(next);
          return (
            <div
              key={next}
              title={noteName(next)}
              style={{
                position: "absolute",
                left: idx * whiteWidth + whiteWidth - blackWidth / 2,
                top: 0,
                width: blackWidth,
                height: 80,
                background: on ? "#4f8cff" : "#1a1a1a",
                border: "1px solid #000",
                borderRadius: "0 0 3px 3px",
                zIndex: 2,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}
