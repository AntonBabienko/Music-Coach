"use client";

import { useRef, useState } from "react";
import ScoreView from "../components/ScoreView";
import PianoKeyboard from "../components/PianoKeyboard";
import ResultsPanel from "../components/ResultsPanel";
import { parseMusicXML } from "../lib/musicxml";
import type { ScorePart } from "../lib/musicxml";
import { freqToMidi, AUDIO_MIN_FREQ, AUDIO_MAX_FREQ } from "../lib/audio";
import { compare, collapseChords, cleanPhantomSteps } from "../lib/compare";
import { scoreInformedCompare } from "../lib/scoreInformed";
import { buildFeedback } from "../lib/feedback";
import { buildAISummary, DICTAPHONE_BIAS } from "../lib/assessment";
import { normalizeAgainstBaseline } from "../lib/calibrate";
import { quantizeNotes, filterShortNotes } from "../lib/quantize";
import type { CompareResult, NoteEvent } from "../lib/types";
import type { Sampler } from "tone";
import type * as ToneModule from "tone";
import { DEFAULT_NOTE_DURATION_SEC } from "../lib/constants";


export default function Page() {
  const [xml, setXml] = useState<string | null>(null);
  const [scoreParts, setScoreParts] = useState<ScorePart[]>([]);
  const [selectedPartId, setSelectedPartId] = useState<string>("");
  const [refNotes, setRefNotes] = useState<NoteEvent[]>([]);
  const [refTempo, setRefTempo] = useState<number>(120);
  const [perfNotes, setPerfNotes] = useState<NoteEvent[]>([]);
  const [perfFromAudio, setPerfFromAudio] = useState(false);
  const [dictaphoneBias, setDictaphoneBias] = useState(false);
  const [perfPoly, setPerfPoly] = useState(false);
  const [result, setResult] = useState<CompareResult | null>(null);
  // Calibration ceiling: a compare of the score against its OWN reference audio
  // (XML ↔ etalon mp3). Player scores are then shown relative to this ceiling,
  // since audio transcription can never hit 100% on polyphony.
  const [baseline, setBaseline] = useState<CompareResult | null>(null);
  const [coaching, setCoaching] = useState<string | null>(null);
  const [coachingLoading, setCoachingLoading] = useState(false);
  const [feedback, setFeedback] = useState<string[]>([]);
  const [active, setActive] = useState<Set<number>>(new Set());
  const [status, setStatus] = useState<string>("");
  const [playing, setPlaying] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  // 0 = "auto": let SNR-adaptive thresholds in lib/preprocess.ts pick the gate.
  // Any value > 0 is a manual override.
  const [velocityThreshold, setVelocityThreshold] = useState(0);
  const [chromaConf, setChromaConf] = useState<Map<number, number> | null>(null);

  const [isRecording, setIsRecording] = useState(false);
  const transcribeAbortRef = useRef<AbortController | null>(null);
  // Raw basic-pitch posteriorgrams of the last transcribed audio, kept so
  // runCompare() can grade with the score-informed path (lib/scoreInformed.ts)
  // instead of the note-sequence DTW. Null for MIDI / score-as-performance.
  const posteriorgramRef = useRef<{ frames: number[][]; onsets: number[][] } | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const micStreamRef = useRef<MediaStream | null>(null);
  const samplerRef = useRef<Sampler | null>(null);
  const toneRef = useRef<typeof ToneModule | null>(null);
  const playbackCancelRef = useRef(false);

  // ---- score loading -------------------------------------------------------
  function loadScoreFromXml(text: string, source = "MusicXML") {
    try {
      const parsed = parseMusicXML(text);
      setXml(text);
      setScoreParts(parsed.parts);
      setSelectedPartId(parsed.parts[0]?.id ?? "");
      setRefNotes(parsed.notes);
      setRefTempo(parsed.tempo);
      setResult(null);
      setFeedback([]);
      const partInfo = parsed.parts.length > 1
        ? ` (${parsed.parts.length} parts — using "${parsed.parts[0]?.name}")`
        : "";
      setStatus(`Loaded score (${source}): ${parsed.notes.length} notes${partInfo}.`);
    } catch (err) {
      setStatus(`Score parse error: ${(err as Error).message}`);
    }
  }

  function selectPart(partId: string) {
    const part = scoreParts.find((p) => p.id === partId);
    if (!part) return;
    setSelectedPartId(partId);
    setRefNotes(part.notes);
    setResult(null);
    setFeedback([]);
  }

  // Single demo: a real SATB hymn with a matching etalon mp3. The score button
  // loads the MusicXML; the performance button transcribes the etalon recording
  // (reproduces the XML↔etalon-mp3 calibration run).
  async function loadDemoScore() {
    setStatus("Завантажую демо-партитуру (гімн)…");
    try {
      const res = await fetch("/jesus-lives.musicxml");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      loadScoreFromXml(await res.text(), "demo / jesus-lives.musicxml");
    } catch (err) {
      setStatus(`Demo score error: ${(err as Error).message}`);
    }
  }

  async function onScoreFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    loadScoreFromXml(await file.text());
    e.target.value = "";
  }

  async function onScoreImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    const name = file.name.toLowerCase();

    // Plain MusicXML — read directly as text
    if (name.endsWith(".musicxml") || name.endsWith(".xml")) {
      try {
        loadScoreFromXml(await file.text(), file.name);
      } catch (err) {
        setStatus(`XML помилка: ${(err as Error).message}`);
      }
      return;
    }

    // Compressed MusicXML (.mxl) — extract via server route
    if (name.endsWith(".mxl")) {
      setStatus(`Розпаковую ${file.name}…`);
      try {
        const fd = new FormData();
        fd.append("file", file);
        const res = await fetch("/api/omr", { method: "POST", body: fd });
        const data = await res.json() as { xml?: string; error?: string };
        if (data.error) throw new Error(data.error);
        loadScoreFromXml(data.xml!, `MXL / ${file.name}`);
      } catch (err) {
        setStatus(`MXL помилка: ${(err as Error).message}`);
      }
      return;
    }

    // PDF or photo — Audiveris via server route
    setStatus(`OMR: обробляю ${file.name}…`);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/omr", { method: "POST", body: fd });
      const data = await res.json() as { xml?: string; error?: string };
      if (data.error) throw new Error(data.error);
      loadScoreFromXml(data.xml!, `OMR / ${file.name}`);
    } catch (err) {
      setStatus(`OMR помилка: ${(err as Error).message}`);
    }
  }

  // ---- performance loading -------------------------------------------------
  function setPerformance(notes: NoteEvent[], label: string, fromAudio = false, poly = false) {
    // Posteriorgrams belong to one specific transcription; drop them on any new
    // performance. transcribeAudioBuffer re-sets them right after this call.
    posteriorgramRef.current = null;
    setPerfNotes(notes);
    setPerfFromAudio(fromAudio);
    setPerfPoly(poly);
    setResult(null);
    setFeedback([]);
    setStatus(`Loaded performance (${label}): ${notes.length} notes.`);
  }

  function useScoreAsPerformance() {
    if (refNotes.length === 0) { setStatus("Load a score first."); return; }
    setPerformance(refNotes.map((n) => ({ ...n })), "score = perfect", false);
  }

  async function loadDemoPerformance() {
    if (refNotes.length === 0) { setStatus("Спершу завантаж демо-партитуру."); return; }
    setStatus("Завантажую демо-виконання (еталон mp3)…");
    setResult(null);
    setFeedback([]);
    try {
      const res = await fetch("/jesus-lives.mp3");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await transcribeAudioBuffer(await res.arrayBuffer(), "demo audio / jesus-lives.mp3");
    } catch (err) {
      setStatus(`Demo performance error: ${(err as Error).message}`);
    }
  }

  async function transcribeAudioBuffer(buf: ArrayBuffer, label: string) {
    const controller = new AbortController();
    transcribeAbortRef.current = controller;
    setIsTranscribing(true);
    setStatus("Transcribing audio (basic-pitch)… 0%");
    try {
      const { audioToNotesPoly } = await import("../lib/basicPitch");
      const { notes, frames, onsets } = await audioToNotesPoly(buf, {
        signal: controller.signal,
        onProgress: (pct) => setStatus(`Transcribing… ${Math.round(pct * 100)}%`),
        onPostProcess: () => setStatus("Decoding notes…"),
        velocityThreshold: velocityThreshold > 0 ? velocityThreshold : undefined,
      });
      if (controller.signal.aborted) return;
      setPerformance(notes, label, true, true);
      // Keep the posteriorgrams for the score-informed grade in runCompare()
      // (set AFTER setPerformance, which clears them).
      posteriorgramRef.current = { frames, onsets };
      setStatus("Computing chroma confidence…");
      const { chromaConfidenceFromAudio } = await import("../lib/chroma");
      // Use all parts so the chroma template covers the full harmony — single-part
      // templates give artificially low similarity and suppress transcriptionUnreliable.
      const allRefNotes = scoreParts.length > 0
        ? scoreParts.flatMap((p) => p.notes)
        : refNotes;
      const conf = await chromaConfidenceFromAudio(buf, allRefNotes);
      setChromaConf(conf);
      setStatus("Done.");
    } catch (err) {
      if (controller.signal.aborted) {
        setStatus("Transcription cancelled.");
      } else {
        setStatus(`Audio transcription error: ${(err as Error).message}`);
      }
    } finally {
      setIsTranscribing(false);
      transcribeAbortRef.current = null;
    }
  }

  async function onPerfAudioFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";
    if (refNotes.length === 0) { setStatus("Load a score first, then upload audio."); return; }
    setResult(null);
    setFeedback([]);
    const buf = await file.arrayBuffer();
    await transcribeAudioBuffer(buf, `audio / ${file.name}`);
  }

  async function startRecording() {
    if (refNotes.length === 0) { setStatus("Load a score first, then record."); return; }
    try {
      // Disable the browser's speech-tuned DSP — echo cancellation, noise
      // suppression and auto gain all mangle musical harmonics and dynamics
      // that the transcriber relies on. We do our own music-aware cleanup in
      // lib/preprocess.ts instead. Request mono 48 kHz for a clean source.
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: 1,
          sampleRate: 48000,
        },
      });
      micStreamRef.current = stream;
      recordedChunksRef.current = [];
      const mr = new MediaRecorder(stream);
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) recordedChunksRef.current.push(e.data);
      };
      mr.onstop = async () => {
        micStreamRef.current?.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
        const blob = new Blob(recordedChunksRef.current, { type: mr.mimeType });
        const buf = await blob.arrayBuffer();
        setResult(null);
        setFeedback([]);
        await transcribeAudioBuffer(buf, "microphone");
      };
      mr.start();
      setIsRecording(true);
      setStatus("Recording… press Stop when done.");
    } catch (err) {
      setStatus(`Microphone error: ${(err as Error).message}`);
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }

  function cancelTranscription() {
    transcribeAbortRef.current?.abort();
  }

  // ---- reference playback --------------------------------------------------
  async function playReference() {
    if (refNotes.length === 0 || playing) return;
    playbackCancelRef.current = false;
    setPlaying(true);

    const Tone = await import("tone");
    toneRef.current = Tone;
    await Tone.start();

    // Build sampler once; reuse on subsequent plays (avoids CDN reload lag).
    if (!samplerRef.current) {
      setStatus("Loading piano samples…");
      samplerRef.current = new Tone.Sampler({
        urls: {
          A0: "A0.mp3", C1: "C1.mp3", "D#1": "Ds1.mp3", "F#1": "Fs1.mp3",
          A1: "A1.mp3", C2: "C2.mp3", "D#2": "Ds2.mp3", "F#2": "Fs2.mp3",
          A2: "A2.mp3", C3: "C3.mp3", "D#3": "Ds3.mp3", "F#3": "Fs3.mp3",
          A3: "A3.mp3", C4: "C4.mp3", "D#4": "Ds4.mp3", "F#4": "Fs4.mp3",
          A4: "A4.mp3", C5: "C5.mp3", "D#5": "Ds5.mp3", "F#5": "Fs5.mp3",
          A5: "A5.mp3", C6: "C6.mp3", "D#6": "Ds6.mp3", "F#6": "Fs6.mp3",
          A6: "A6.mp3", C7: "C7.mp3", "D#7": "Ds7.mp3", "F#7": "Fs7.mp3",
          A7: "A7.mp3", C8: "C8.mp3",
        },
        release: 1,
        baseUrl: "https://tonejs.github.io/audio/salamander/",
      }).toDestination();
      await Tone.loaded();
    }

    // Stop was clicked while samples were loading — abort.
    if (playbackCancelRef.current) { setPlaying(false); return; }

    const transport = Tone.getTransport();
    transport.cancel();
    transport.stop();
    transport.position = 0;

    setStatus("Playing reference…");
    const sampler = samplerRef.current;
    let lastEnd = 0;

    for (const n of refNotes) {
      const dur = n.durationSec && n.durationSec > 0 ? n.durationSec : DEFAULT_NOTE_DURATION_SEC;
      const noteName = Tone.Frequency(n.midi, "midi").toNote();

      transport.schedule((time: number) => {
        sampler.triggerAttackRelease(noteName, dur * 0.95, time, 0.7);
      }, n.onsetSec);

      // Keyboard highlights via transport.schedule() so they're cancelled together
      // with audio on transport.cancel() and stay in sync with the transport clock.
      transport.schedule(() => {
        setActive((prev) => { const s = new Set(prev); s.add(n.midi); return s; });
      }, n.onsetSec);
      transport.schedule(() => {
        setActive((prev) => { const s = new Set(prev); s.delete(n.midi); return s; });
      }, n.onsetSec + dur);

      lastEnd = Math.max(lastEnd, n.onsetSec + dur);
    }

    transport.schedule(() => {
      setActive(new Set());
      setPlaying(false);
      setStatus("Reference playback finished.");
    }, lastEnd + 0.3);

    transport.start("+0.05");
  }

  function stopPlayback() {
    playbackCancelRef.current = true;
    const T = toneRef.current;
    if (T) {
      T.getTransport().stop();
      T.getTransport().cancel();
    }
    samplerRef.current?.releaseAll();
    setActive(new Set());
    setPlaying(false);
    setStatus("Stopped.");
  }

  async function getCoaching() {
    if (!result) return;
    setCoachingLoading(true);
    setCoaching(null);
    try {
      const summary = buildAISummary(result, chromaConf ?? undefined);
      const normalizedScores = baseline ? normalizeAgainstBaseline(result, baseline) : null;
      const res = await fetch("/api/coach", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary, normalizedScores }),
      });
      const data = await res.json() as { coaching: string };
      setCoaching(data.coaching);
    } catch (err) {
      setCoaching(`Помилка: ${(err as Error).message}`);
    }
    setCoachingLoading(false);
  }

  // ---- compare -------------------------------------------------------------
  function runCompare() {
    if (refNotes.length === 0 || perfNotes.length === 0) return;

    // Score-informed path: when the performance came from polyphonic audio we
    // still hold the basic-pitch posteriorgrams, so grade directly off them with
    // the score as a prior — robust to noise, transposition and stop-early, and
    // it reports off-score. Grade against ALL parts (full harmony in the mix).
    const pg = posteriorgramRef.current;
    if (perfFromAudio && perfPoly && pg) {
      const gradeRef = scoreParts.length > 0 ? scoreParts.flatMap((p) => p.notes) : refNotes;
      const r = scoreInformedCompare(gradeRef, pg.frames, pg.onsets);
      setResult(r);
      setFeedback(buildFeedback(r));
      setCoaching(null);
      setStatus(
        r.offScore
          ? "Це не схоже на цю партитуру — схоже грається інше (off-score)."
          : `Score-informed аналіз готовий${r.transposeSemitones ? ` (виявлено транспозицію ${r.transposeSemitones > 0 ? "+" : ""}${r.transposeSemitones} пт)` : ""}.`
      );
      return;
    }

    const midiLo = freqToMidi(AUDIO_MIN_FREQ);
    const midiHi = freqToMidi(AUDIO_MAX_FREQ);
    const ref = perfFromAudio && !perfPoly
      ? collapseChords(refNotes).filter(n => n.midi >= midiLo && n.midi <= midiHi)
      : refNotes;
    const perf = perfPoly
      ? quantizeNotes(filterShortNotes(perfNotes, 50, refTempo), refTempo)
      : perfNotes;
    const raw = compare(ref, perf);
    const r = perfPoly ? cleanPhantomSteps(raw) : raw;
    setResult(r);
    setFeedback(buildFeedback(r));
    setCoaching(null);
    setStatus("Comparison complete.");
  }

  const refPitchSet = new Set(refNotes.map((n) => n.midi));

  return (
    <main style={{ maxWidth: 1000, margin: "0 auto", padding: 24 }}>
      <h1 style={{ marginBottom: 4 }}>Music Coach — Core Prototype</h1>
      <p style={{ color: "var(--muted)", marginTop: 0 }}>
        Score (MusicXML або фото/PDF) → parse → display → performance (audio) → score-informed compare → feedback.
      </p>

      <section style={{ display: "flex", gap: 24, flexWrap: "wrap", marginBottom: 20 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <strong>1. Reference score</strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={loadDemoScore}>Load demo score (hymn)</button>
            <label className="panel" style={{ padding: "8px 12px", cursor: "pointer" }}>
              Upload .musicxml
              <input type="file" accept=".musicxml,.xml" onChange={onScoreFile} style={{ display: "none" }} />
            </label>
          </div>
          {scoreParts.length > 1 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <label htmlFor="part-select">Part:</label>
              <select
                id="part-select"
                value={selectedPartId}
                onChange={(e) => selectPart(e.target.value)}
              >
                {scoreParts.map((p) => (
                  <option key={p.id} value={p.id}>{p.name || p.id}</option>
                ))}
              </select>
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={playReference} disabled={refNotes.length === 0 || playing}>▶ Play</button>
            <button onClick={stopPlayback} disabled={!playing}>■ Stop</button>
          </div>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <strong>2. Performance</strong>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={useScoreAsPerformance} disabled={refNotes.length === 0}>
              Use score (100% test)
            </button>
            <button onClick={loadDemoPerformance} disabled={isTranscribing || isRecording || refNotes.length === 0}>
              Load demo performance (etalon mp3)
            </button>
            <label className="panel" style={{ padding: "8px 12px", cursor: "pointer", opacity: isTranscribing ? 0.5 : 1 }}>
              Upload audio
              <input
                type="file"
                accept=".wav,.mp3,.ogg,.m4a,audio/*"
                onChange={onPerfAudioFile}
                disabled={isTranscribing || isRecording}
                style={{ display: "none" }}
              />
            </label>
            {!isRecording ? (
              <button
                onClick={startRecording}
                disabled={isTranscribing}
                style={{ background: "#c0392b" }}
              >
                ⏺ Record
              </button>
            ) : (
              <button onClick={stopRecording} style={{ background: "#e74c3c", animation: "pulse 1s infinite" }}>
                ⏹ Stop
              </button>
            )}
          </div>
          {perfFromAudio && (
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              <input
                type="checkbox"
                checked={dictaphoneBias}
                onChange={(e) => setDictaphoneBias(e.target.checked)}
              />
              Dictaphone / ambient recording (corrects for low-freq cutoff)
            </label>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
              Velocity gate:
              <input
                type="range"
                min={0} max={0.4} step={0.01}
                value={velocityThreshold}
                onChange={(e) => setVelocityThreshold(parseFloat(e.target.value))}
                style={{ width: 90 }}
              />
              <span style={{ minWidth: 32 }}>
                {velocityThreshold > 0 ? velocityThreshold.toFixed(2) : "auto"}
              </span>
            </label>
            {isTranscribing && (
              <button onClick={cancelTranscription} style={{ background: "#ff6b6b" }}>
                ✕ Cancel
              </button>
            )}
          </div>
          <button
            onClick={runCompare}
            disabled={refNotes.length === 0 || perfNotes.length === 0 || isTranscribing}
            style={{ alignSelf: "flex-start" }}
          >
            Compare
          </button>
        </div>
      </section>

      <p data-testid="status" style={{ color: "var(--accent)", minHeight: 20 }}>{status}</p>

      <section style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 16 }}>
          Score
          {refNotes.length > 0 && (
            <span style={{ color: "var(--muted)", fontWeight: 400, fontSize: 13 }}>
              {" "}— {refNotes.length} notes, {refTempo} BPM
            </span>
          )}
        </h2>
        <ScoreView xml={xml} />
      </section>

      <section style={{ marginBottom: 20 }}>
        <h2 style={{ fontSize: 16 }}>Keyboard</h2>
        <PianoKeyboard active={playing ? active : refPitchSet} />
        <p style={{ color: "var(--muted)", fontSize: 12, margin: "6px 0 0" }}>
          {playing ? "Highlighting notes as the reference plays." : "Showing all distinct pitches in the loaded score."}
        </p>
      </section>

      {result && (
        <section>
          <h2 style={{ fontSize: 16 }}>Results</h2>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 8 }}>
            <button onClick={() => setBaseline(result)} title="Порівняй XML з еталонним mp3, потім натисни тут — це стане стелею транскрипції, відносно якої оцінюється гравець.">
              📐 Зберегти як baseline (калібрування)
            </button>
            {baseline && (
              <span style={{ fontSize: 13, color: "var(--muted)" }}>
                Baseline активний: стеля pitch {baseline.pitchAccuracy.toFixed(0)}% / coverage {baseline.coverageAccuracy.toFixed(0)}%
                {" "}
                <button onClick={() => setBaseline(null)} style={{ fontSize: 12, padding: "2px 8px" }}>скинути</button>
              </span>
            )}
          </div>
          <ResultsPanel
            result={result}
            feedback={feedback}
            normalizedScores={baseline ? normalizeAgainstBaseline(result, baseline) : null}
            coaching={coaching}
            coachingLoading={coachingLoading}
            onGetCoaching={getCoaching}
            chromaConf={chromaConf ?? undefined}
            recordingBias={dictaphoneBias ? DICTAPHONE_BIAS : undefined}
          />
        </section>
      )}
    </main>
  );
}
