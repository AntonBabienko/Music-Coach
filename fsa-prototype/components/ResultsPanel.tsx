"use client";

import type { CompareResult } from "../lib/types";
import { assess, type Band, type TimingBand, type ChromaConfidence, type RecordingBias } from "../lib/assessment";
import type { NormalizedScores } from "../lib/calibrate";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

const BAND_COLOR: Record<Band | TimingBand, string> = {
  strong: "#3ddc84",
  fair: "#ffb347",
  weak: "#ff6b6b",
  unknown: "#8a8a8a",
  steady: "#3ddc84",
  "slightly-off": "#ffb347",
  unreliable: "#8a8a8a",
};

function Chip({ label, value, band }: { label: string; value: string; band: Band | TimingBand }) {
  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 14 }}>
      {label}:{" "}
      <b style={{ color: BAND_COLOR[band] }}>{value}</b>
    </span>
  );
}
function noteName(midi?: number): string {
  if (midi == null) return "—";
  const octave = Math.floor(midi / 12) - 1;
  return `${NOTE_NAMES[midi % 12]}${octave}`;
}

function filterOctaveDoubleTriggers(steps: import("../lib/types").AlignStep[]): import("../lib/types").AlignStep[] {
  return steps.filter((s, i, arr) => {
    if (i === 0 || s.type !== "match" || s.perfMidi == null || s.residualSec == null) return true;
    const prev = arr[i - 1];
    if (prev.type !== "match" || prev.perfMidi == null || prev.residualSec == null) return true;
    const sameTime = Math.abs(s.residualSec - prev.residualSec) < 0.005;
    const octaveApart = Math.abs(s.perfMidi - prev.perfMidi) % 12 === 0 && s.perfMidi !== prev.perfMidi;
    return !(sameTime && octaveApart && s.perfMidi > prev.perfMidi);
  });
}

const TYPE_COLOR: Record<string, string> = {
  match: "#3ddc84",
  wrong: "#ff6b6b",
  missed: "#ffb347",
  extra: "#c792ea",
};

/**
 * 3-zone timing color based on raw residual (seconds):
 *   ≤ 120 ms  → green  (on target)
 *   120–300 ms → yellow (slightly off)
 *   > 300 ms  → red    (significantly off)
 * Returns null for steps without timing info (missed / extra).
 */
function timingColor(residualSec: number | undefined): string | null {
  if (residualSec == null) return null;
  const abs = Math.abs(residualSec);
  if (abs <= 0.12) return "#3ddc84";
  if (abs <= 0.30) return "#ffb347";
  return "#ff6b6b";
}

function MissedByMeasure({ steps, noisyMeasures }: {
  steps: import("../lib/types").AlignStep[];
  noisyMeasures?: Set<number>;
}) {
  const byMeasure = new Map<number, { missed: number; wrong: number }>();
  for (const s of steps) {
    if (s.measure == null) continue;
    if (s.type !== "missed" && s.type !== "wrong") continue;
    const entry = byMeasure.get(s.measure) ?? { missed: 0, wrong: 0 };
    if (s.type === "missed") entry.missed++;
    else entry.wrong++;
    byMeasure.set(s.measure, entry);
  }
  if (byMeasure.size === 0) return null;

  const rows = [...byMeasure.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, v]) => v.missed + v.wrong > 0);

  const maxErr = Math.max(...rows.map(([, v]) => v.missed + v.wrong));

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Missed &amp; wrong notes by measure</h3>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 6px" }}>
        {rows.map(([m, v]) => {
          const total = v.missed + v.wrong;
          const noisy = noisyMeasures?.has(m);
          const intensity = total / maxErr;
          const bg = noisy ? "#555" : intensity > 0.66 ? "#ff6b6b" : intensity > 0.33 ? "#ffb347" : "#444";
          const title = noisy
            ? `m.${m}: ${v.missed} missed, ${v.wrong} wrong (шум baseline — не враховується)`
            : `m.${m}: ${v.missed} missed, ${v.wrong} wrong`;
          return (
            <span key={m} title={title}
              style={{ fontSize: 12, padding: "2px 6px", borderRadius: 4,
                background: bg, color: noisy ? "#aaa" : "#fff",
                textDecoration: noisy ? "line-through" : undefined, cursor: "default" }}>
              m{m} <b>{total}</b>
            </span>
          );
        })}
      </div>
      <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted)" }}>
        Червоний = найбільше помилок. Наведи на такт щоб побачити деталі.
      </p>
    </div>
  );
}

export default function ResultsPanel({
  result,
  feedback,
  normalizedScores,
  coaching,
  coachingLoading,
  onGetCoaching,
  chromaConf,
  recordingBias,
}: {
  result: CompareResult;
  feedback: string[];
  normalizedScores?: NormalizedScores | null;
  coaching?: string | null;
  coachingLoading?: boolean;
  onGetCoaching?: () => void;
  chromaConf?: ChromaConfidence;
  recordingBias?: RecordingBias;
}) {
  const { counts } = result;
  const a = assess(result, chromaConf, recordingBias);
  const scoreMismatch = result.timingResidualRatio > 2.0;
  // Score-informed signals (undefined on the note-sequence compare path).
  const offScore = result.offScore === true;
  const transpose = result.transposeSemitones ?? 0;
  const notAttempted = result.notAttempted ?? 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div className="panel" data-testid="coaching-summary">
        <h3 style={{ marginTop: 0 }}>Coaching summary</h3>
        {offScore && (
          <div style={{
            background: "#3a1a1a", border: "1px solid #ff6b6b",
            borderRadius: 6, padding: "10px 14px", marginBottom: 12,
          }}>
            <b style={{ color: "#ff6b6b" }}>Не схоже на цю партитуру.</b>
            <span style={{ fontSize: 13, color: "var(--muted)", marginLeft: 8 }}>
              Аудіо майже не збігається зі score (alignment confidence{" "}
              {(result.alignmentConfidence ?? 0).toFixed(1)}×) — схоже, грається інший твір.
              Оцінка нота-за-нотою нижче не показова.
            </span>
          </div>
        )}
        {(transpose !== 0 || notAttempted > 0) && !offScore && (
          <div style={{ fontSize: 13, color: "var(--muted)", marginBottom: 10 }}>
            {transpose !== 0 && (
              <span>🎚 Виявлено транспозицію <b>{transpose > 0 ? "+" : ""}{transpose}</b> пт —
                оцінюю відносно зіграної тональності. </span>
            )}
            {notAttempted > 0 && (
              <span>⏹ <b>{notAttempted}</b> нот не зіграно (виконання обірвалось) — їх виключено з оцінки.</span>
            )}
          </div>
        )}
        {scoreMismatch && (
          <div style={{
            background: "#3a1a1a", border: "1px solid #ff6b6b",
            borderRadius: 6, padding: "10px 14px", marginBottom: 12,
          }}>
            <b style={{ color: "#ff6b6b" }}>Score mismatch — results unreliable.</b>
            <span style={{ fontSize: 13, color: "var(--muted)", marginLeft: 8 }}>
              The audio does not appear to match this score (timing residual {result.timingResidualRatio.toFixed(1)}×).
              Load the correct score or performance and compare again.
            </span>
          </div>
        )}
        <p style={{ margin: "0 0 10px", fontSize: 15, fontWeight: 600 }}>{a.headline}</p>
        <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 10 }}>
          <Chip label="Completeness" value={`${Math.round(a.completenessPct)}%`}
            band={a.completenessPct >= 85 ? "strong" : a.completenessPct >= 60 ? "fair" : "weak"} />
          <Chip label="Pitch" value={a.pitchBand} band={a.pitchBand} />
          <Chip label="Timing"
            value={a.timingBand === "unreliable" ? "n/a" : a.timingBand === "steady" ? "steady" : a.timingTrend}
            band={a.timingBand} />
          {a.weakestRegion && (
            <span style={{ fontSize: 14 }}>
              Weakest: <b>m. {a.weakestRegion.fromMeasure}
              {a.weakestRegion.toMeasure !== a.weakestRegion.fromMeasure ? `–${a.weakestRegion.toMeasure}` : ""}</b>
            </span>
          )}
        </div>
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
          {a.tips.map((t, i) => <li key={i}>{t}</li>)}
        </ul>
        {a.confirmedErrors != null && a.artifactErrors != null && (
          <p style={{ margin: "8px 0 0", fontSize: 13 }}>
            Errors: <span style={{ color: "#ff6b6b" }}><b>{a.confirmedErrors}</b> confirmed</span>
            {" · "}
            <span style={{ color: "#ffb347" }}><b>{a.artifactErrors}</b> likely transcription noise</span>
          </p>
        )}
        {a.blindZoneMissed != null && (
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--muted)" }}>
            Recording bias: <b>{a.blindZoneMissed}</b> missed notes excluded from score
            (low-freq / polyphonic blind zone).
          </p>
        )}
        <p style={{ margin: "4px 0 0", fontSize: 12, color: "var(--muted)" }}>
          Aggregated, confidence-gated view over the note-level result below.
        </p>
      </div>

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Note-by-note feedback (per spec)</h3>
        <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
          {feedback.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>

      {normalizedScores && (
        <div className="panel" style={{ borderLeft: "3px solid #3ddc84" }}>
          <h3 style={{ marginTop: 0 }}>Відносно еталону (baseline = 100%)</h3>
          <div style={{ display: "flex", gap: 20, flexWrap: "wrap", fontSize: 15 }}>
            {(["pitchNorm", "coverageNorm", "onTimeNorm"] as const).map((k) => {
              const v = normalizedScores[k];
              const label = k === "pitchNorm" ? "Pitch" : k === "coverageNorm" ? "Coverage" : "On-time";
              const color = v >= 90 ? "#3ddc84" : v >= 70 ? "#ffb347" : "#ff6b6b";
              return (
                <span key={k}>{label}: <b style={{ color }}>{v.toFixed(0)}%</b></span>
              );
            })}
          </div>
          {normalizedScores.noisyMeasures.size > 0 && (
            <p style={{ margin: "6px 0 0", fontSize: 12, color: "var(--muted)" }}>
              Такти з базовим шумом (виключено з оцінки): {[...normalizedScores.noisyMeasures].sort((a,b)=>a-b).map(m=>`m${m}`).join(", ")}
            </p>
          )}
        </div>
      )}

      {onGetCoaching && (
        <div className="panel">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <button onClick={onGetCoaching} disabled={coachingLoading}>
              {coachingLoading ? "Завантаження…" : "Отримати AI-пораду"}
            </button>
            {coaching && <p style={{ margin: 0, fontSize: 14 }}>{coaching}</p>}
          </div>
        </div>
      )}

      <div className="panel" data-testid="results-summary">
        <h3 style={{ marginTop: 0 }}>Summary</h3>
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", fontSize: 14 }}>
          <span>Pitch accuracy: <b>{result.pitchAccuracy.toFixed(1)}%</b></span>
          <span title="correct pitch AND on-time (≤150ms) / reference notes">On-time: <b>{result.onTimeAccuracy.toFixed(1)}%</b></span>
          <span title="notes with ANY alignment (match+wrong) / reference notes — high coverage + low pitch = detection artefacts">Coverage: <b>{result.coverageAccuracy.toFixed(1)}%</b></span>
          <span title="reference notes vs performance notes fed to the comparison">
            ref: {result.refCount} vs perf: {result.perfCount}
          </span>
          <span style={{ color: TYPE_COLOR.match }}>match: {counts.match}</span>
          <span style={{ color: TYPE_COLOR.wrong }}>wrong: {counts.wrong}</span>
          <span style={{ color: TYPE_COLOR.missed }}>missed: {counts.missed}</span>
          <span style={{ color: TYPE_COLOR.extra }}>extra: {counts.extra}</span>
          <span>late: {counts.late}</span>
          <span>early: {counts.early}</span>
          <span title="resid = median timing residual ÷ note spacing; above ~0.5 the tempo ratio is unreliable">
            tempo ratio (a): <b>{result.tempoRatio.toFixed(3)}</b> (R²={result.timingR2.toFixed(2)}, resid={result.timingResidualRatio.toFixed(2)}×)
          </span>
          {result.alignmentConfidence != null && (
            <span title="aligned match rate ÷ chance baseline; ~1 = off-score, high = the score explains the audio">
              alignment conf: <b>{result.alignmentConfidence.toFixed(1)}×</b>
            </span>
          )}
        </div>
      </div>

      <MissedByMeasure steps={result.steps} noisyMeasures={normalizedScores?.noisyMeasures} />

      <div className="panel">
        <h3 style={{ marginTop: 0 }}>Alignment (note-by-note)</h3>
        <table data-testid="alignment-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Type</th>
              <th>Expected</th>
              <th>Played</th>
              <th>Measure</th>
              <th>Timing</th>
              <th>Residual (s)</th>
            </tr>
          </thead>
          <tbody>
            {filterOctaveDoubleTriggers(result.steps)
              .map((s, i) => (
              <tr key={i}>
                <td>{i + 1}</td>
                <td style={{ color: TYPE_COLOR[s.type], fontWeight: 600 }}>
                  {s.type}
                </td>
                <td>{noteName(s.refMidi)}</td>
                <td>{noteName(s.perfMidi)}</td>
                <td>{s.measure ?? "—"}</td>
                <td style={{ color: timingColor(s.residualSec) ?? undefined }}>
                  {s.timing ?? "—"}
                </td>
                <td style={{ color: timingColor(s.residualSec) ?? undefined }}>
                  {s.residualSec != null ? s.residualSec.toFixed(3) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
