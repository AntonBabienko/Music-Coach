import { execSync } from "child_process";
import { existsSync, mkdirSync, writeFileSync, copyFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");

function ensureDemoAssets() {
  const pub = join(ROOT, "public");
  const needed = [
    "sample-performance.mid",
    "sample-performance.wav",
    "sample-score.svg",
  ];
  const missing = needed.filter((f) => !existsSync(join(pub, f)));
  if (missing.length > 0) {
    console.log(`\n[global-setup] Generating demo assets: ${missing.join(", ")}`);
    execSync("npm run gen-assets", { cwd: ROOT, stdio: "inherit" });
  }
}

function ensureFixtures() {
  const dir = join(ROOT, "e2e", "fixtures");
  mkdirSync(dir, { recursive: true });

  // 1. A 4-note MusicXML for the score upload test.
  const xmlPath = join(dir, "tetrachord.musicxml");
  if (!existsSync(xmlPath)) {
    writeFileSync(
      xmlPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 3.1 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="3.1">
  <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>1</divisions>
        <key><fifths>0</fifths></key>
        <time><beats>4</beats><beat-type>4</beat-type></time>
        <clef><sign>G</sign><line>2</line></clef>
      </attributes>
      <sound tempo="120"/>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>5</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`
    );
  }

  // 2. Perfect MIDI — no errors injected. Tests the 100% / 0-error boundary.
  const perfMidPath = join(dir, "perfect-perf.mid");
  if (!existsSync(perfMidPath)) {
    execSync("node scripts/gen-fixtures.mjs", { cwd: ROOT, stdio: "inherit" });
  }

  // 3. Invalid file (plain text) for error-handling tests.
  const badPath = join(dir, "invalid.mid");
  if (!existsSync(badPath)) {
    writeFileSync(badPath, "this is not a midi file");
  }

  // 4. Copy the demo SVG as a fixture for the image-upload OMR test.
  const imgPath = join(dir, "score-image.svg");
  const imgSrc = join(ROOT, "public", "sample-score.svg");
  if (!existsSync(imgPath) && existsSync(imgSrc)) {
    copyFileSync(imgSrc, imgPath);
  }

  // 5. Copy the demo WAV as a fixture for the audio-upload test.
  const wavPath = join(dir, "performance.wav");
  const wavSrc = join(ROOT, "public", "sample-performance.wav");
  if (!existsSync(wavPath) && existsSync(wavSrc)) {
    copyFileSync(wavSrc, wavPath);
  }
}

export default function globalSetup() {
  ensureDemoAssets();
  ensureFixtures();
}
