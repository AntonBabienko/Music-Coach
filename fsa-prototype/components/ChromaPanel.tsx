"use client";

import type { ChromaResult } from "../lib/chroma";

const mm = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

export default function ChromaPanel({ result }: { result: ChromaResult }) {
  const simColor =
    result.pitchSimilarity >= 80
      ? "#3ddc84"
      : result.pitchSimilarity >= 60
      ? "#ffb347"
      : "#ff6b6b";

  const ratioDiff = result.tempoRatio - 1;
  const ratioLabel =
    Math.abs(ratioDiff) < 0.04 ? "on tempo" :
    ratioDiff < 0 ? `${Math.round(-ratioDiff * 100)}% faster` :
    `${Math.round(ratioDiff * 100)}% slower`;
  const ratioColor = Math.abs(ratioDiff) < 0.06 ? "#3ddc84" : "#ffb347";

  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>Audio Analysis</h3>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", marginBottom: 12 }}>
        <span style={{ fontSize: 14 }}>
          Pitch similarity:{" "}
          <b style={{ color: simColor }}>{result.pitchSimilarity}%</b>
        </span>
        <span style={{ fontSize: 14 }}>
          Tempo: <b style={{ color: ratioColor }}>{ratioLabel}</b>
        </span>
        {result.weakest && (
          <span style={{ fontSize: 14 }}>
            Weakest:{" "}
            <b>
              {mm(result.weakest.fromSec)}–{mm(result.weakest.toSec)}
            </b>
          </span>
        )}
      </div>
      <ul style={{ margin: 0, paddingLeft: 20, lineHeight: 1.6 }}>
        {result.tips.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
      <p style={{ margin: "8px 0 0", fontSize: 12, color: "var(--muted)" }}>
        Chroma-based comparison (FFT + DTW) — no ML model, processes in ~1s.
      </p>
    </div>
  );
}
