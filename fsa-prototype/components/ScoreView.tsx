"use client";

import { useEffect, useRef } from "react";
import { parseMusicXML } from "../lib/musicxml";
import { notesToMusicXml } from "../lib/omr";

/**
 * Sanitize MusicXML before handing it to OSMD 1.9.9, which crashes on a handful
 * of constructs that OMR engines (Audiveris) routinely emit.
 *
 * The big one: Audiveris exports empty bars as a whole-measure rest with a ZERO
 * duration — `<rest measure="yes"/><duration>0</duration>`. OSMD's whole-rest
 * detection misfires on the 0, so `VexFlowConverter.durations()` returns an
 * EMPTY array, the VexFlow duration becomes `undefined`, VexFlow stringifies it
 * to "undefined", its parser regex grabs the first letter "u", and throws
 * "duration is not valid: u" — aborting the WHOLE score (e.g. a 2-part hymn then
 * renders only its first part). We repair these rests by writing the real
 * measure length (divisions × beats, scaled by the time signature) so OSMD draws
 * a proper whole rest. Any other degenerate zero/duration-less note is dropped
 * (carries no time, so timing-safe).
 *
 * Also stripped: <octave-shift> (crash on undefined realValue) and <harmony>
 * (chord-symbol reader can yield the same invalid "u" duration).
 */
function sanitizeForOsmd(xml: string): string {
  const stripped = xml
    .replace(/<octave-shift[^>]*\/>/g, "")
    .replace(/<octave-shift[\s\S]*?<\/octave-shift>/g, "")
    .replace(/<harmony[\s\S]*?<\/harmony>/g, "");

  // Walk divisions/time-signature/note tags in document order so each note is
  // repaired against the divisions and meter active at its position.
  let divisions = 1;
  let beats = 4;
  let beatType = 4;
  return stripped.replace(
    /<divisions>(\d+)<\/divisions>|<beats>(\d+)<\/beats>|<beat-type>(\d+)<\/beat-type>|<note\b[^>]*>[\s\S]*?<\/note>/g,
    (match, dv?: string, bt?: string, btp?: string) => {
      if (dv) { divisions = +dv; return match; }
      if (bt) { beats = +bt; return match; }
      if (btp) { beatType = +btp; return match; }
      // It's a <note>. Healthy (non-zero, has a duration) → leave untouched.
      const zeroDuration =
        /<duration>\s*0*\s*<\/duration>/.test(match) || !/<duration>/.test(match);
      if (!zeroDuration) return match;
      // Whole-measure rest → give it the real measure length so OSMD renders it.
      if (/<rest\b[^>]*measure="yes"/.test(match)) {
        const measureLen = Math.max(1, Math.round((divisions * 4 * beats) / beatType));
        return /<duration>/.test(match)
          ? match.replace(/<duration>\s*0*\s*<\/duration>/, `<duration>${measureLen}</duration>`)
          : match.replace(/(<rest\b[^>]*\/?>(?:<\/rest>)?)/, `$1<duration>${measureLen}</duration>`);
      }
      // Any other zero/duration-less note: drop it.
      return "";
    }
  );
}

/**
 * Renders MusicXML using OpenSheetMusicDisplay. OSMD touches the DOM and the
 * `window` object, so it is imported lazily inside useEffect and never on the
 * server.
 */
export default function ScoreView({ xml }: { xml: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!xml || !containerRef.current) return;
    let cancelled = false;
    const container = containerRef.current;

    let osmdInstance: import("opensheetmusicdisplay").OpenSheetMusicDisplay | null = null;

    function safeRender(fromResize = false) {
      if (cancelled || !osmdInstance) return;
      try {
        osmdInstance.render();
      } catch (err) {
        if (!fromResize) {
          container.innerHTML = `<p style="color:#ff6b6b">Failed to render score: ${(err as Error).message}</p>`;
        }
        // on resize — OSMD bug, silently ignore
      }
    }

    (async () => {
      const { OpenSheetMusicDisplay } = await import("opensheetmusicdisplay");
      if (cancelled) return;
      osmdInstance = new OpenSheetMusicDisplay(container, {
        autoResize: false,
        backend: "svg",
        drawTitle: false,
      });
      // Try the real (sanitized) Audiveris XML first so we keep its full
      // rhythm/voicing. If OSMD still throws on some construct we didn't strip,
      // fall back to MusicXML regenerated from the notes that already parsed
      // cleanly — guaranteed-valid (only quarter/half/whole), so it never "u"s.
      async function tryLoad(xmlStr: string): Promise<boolean> {
        if (!osmdInstance) return false;
        try {
          await osmdInstance.load(xmlStr);
          if (cancelled) return true;
          osmdInstance.render();
          return true;
        } catch {
          return false;
        }
      }

      if (await tryLoad(sanitizeForOsmd(xml))) return;
      if (cancelled) return;

      let fallbackErr = "";
      try {
        const parsed = parseMusicXML(xml);
        const cleanXml = notesToMusicXml(parsed.notes, parsed.tempo);
        if (await tryLoad(cleanXml)) return;
      } catch (err) {
        fallbackErr = (err as Error).message;
      }

      if (!cancelled) {
        container.innerHTML = `<p style="color:#ff6b6b">Failed to render score${
          fallbackErr ? `: ${fallbackErr}` : ""
        }</p>`;
      }
    })();

    const ro = new ResizeObserver(() => safeRender(true));
    ro.observe(container);

    return () => {
      cancelled = true;
      ro.disconnect();
      container.innerHTML = "";
    };
  }, [xml]);

  if (!xml) {
    return (
      <div data-testid="score-view" className="panel" style={{ color: "var(--muted)" }}>
        No score loaded.
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="score-view"
      className="panel"
      style={{ background: "#ffffff", overflowX: "auto" }}
    />
  );
}
