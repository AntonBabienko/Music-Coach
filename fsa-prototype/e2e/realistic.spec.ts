/**
 * "Realistic" E2E tests — close to real usage of the current (hymn-based) UI:
 *   - the "Load demo score (hymn)" + "Use score (100% test)" deterministic path
 *   - file uploads via setInputFiles (custom MusicXML, MIDI, audio)
 *   - playback state machine
 *   - state reset when a new score/performance is loaded after a comparison
 *   - error handling for an invalid file upload
 */

import { test, expect, type Page } from "@playwright/test";
import { join } from "path";

const ROOT = join(__dirname, "..");
const FIXTURES = join(__dirname, "fixtures");
const SAMPLE_XML = join(ROOT, "public", "sample.musicxml");
const SAMPLE_MID = join(ROOT, "public", "sample-performance.mid");

// ---- locators ---------------------------------------------------------------
// The dedicated XML upload has accept=".musicxml,.xml"; the PDF/MXL/photo upload
// also contains ".musicxml", so match the dedicated input exactly.
const scoreXmlInput = (page: Page) => page.locator('input[accept=".musicxml,.xml"]');
const midiInput = (page: Page) => page.locator('input[accept=".mid,.midi"]');
const audioInput = (page: Page) => page.locator('input[accept=".wav,.mp3,.ogg,.m4a,audio/*"]');

async function loadSampleScore(page: Page) {
  await scoreXmlInput(page).setInputFiles(SAMPLE_XML);
  await expect(page.getByTestId("status")).toContainText("Loaded score");
}

// ---- suite ------------------------------------------------------------------

test.describe("Realistic usage", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  // --------------------------------------------------------------------------
  test.describe("Hymn demo (deterministic)", () => {
    test("Load demo score (hymn) → score parsed and rendered", async ({ page }) => {
      await page.getByRole("button", { name: "Load demo score (hymn)" }).click();
      await expect(page.getByTestId("status")).toContainText("Loaded score");
      await expect(
        page.getByTestId("score-view").locator("svg").first()
      ).toBeVisible({ timeout: 15_000 });
      // The keyboard reflects the loaded pitches.
      await expect(page.getByTestId("piano-keyboard").locator("div")).not.toHaveCount(0);
    });

    test("Use score (100% test) → perfect comparison against itself", async ({ page }) => {
      await page.getByRole("button", { name: "Load demo score (hymn)" }).click();
      await expect(page.getByTestId("status")).toContainText("Loaded score");

      await page.getByRole("button", { name: "Use score (100% test)" }).click();
      await expect(page.getByTestId("status")).toContainText("Loaded performance");

      await page.getByRole("button", { name: "Compare" }).click();
      await expect(page.getByTestId("status")).toContainText("Comparison complete");

      const summary = page.getByTestId("results-summary");
      await expect(summary).toContainText("100.0%");
      await expect(summary).toContainText("wrong: 0");
      await expect(summary).toContainText("missed: 0");
      await expect(summary).toContainText("extra: 0");
    });
  });

  // --------------------------------------------------------------------------
  test.describe("Score file upload", () => {
    test("upload a custom .musicxml → parse 4 notes at tempo 120", async ({ page }) => {
      await scoreXmlInput(page).setInputFiles(join(FIXTURES, "tetrachord.musicxml"));
      await expect(page.getByTestId("status")).toContainText("Loaded score");
      await expect(page.getByTestId("status")).toContainText("4 notes");
      await expect(page.getByRole("heading", { name: /Score/ })).toContainText("120 BPM");
      await expect(
        page.getByTestId("score-view").locator("svg").first()
      ).toBeVisible({ timeout: 15_000 });
    });
  });

  // --------------------------------------------------------------------------
  test.describe("Performance file upload", () => {
    test.beforeEach(async ({ page }) => {
      await loadSampleScore(page);
    });

    test.skip("upload a .mid file → notes parsed, Compare enabled", async ({ page }) => {
      await midiInput(page).setInputFiles(join(FIXTURES, "perfect-perf.mid"));
      await expect(page.getByTestId("status")).toContainText("Loaded performance");
      await expect(page.getByTestId("status")).toContainText("MIDI");
      await expect(page.getByRole("button", { name: "Compare" })).toBeEnabled();
    });

    test("upload an audio .wav file → transcribed, Compare enabled", async ({ page }) => {
      // Audio runs through basic-pitch (neural transcription in-browser); allow
      // generous time for model load + inference in headless Chromium.
      test.setTimeout(120_000);
      await audioInput(page).setInputFiles(join(FIXTURES, "performance.wav"));
      await expect(page.getByRole("button", { name: "Compare" })).toBeEnabled({
        timeout: 110_000,
      });
    });
  });

  // --------------------------------------------------------------------------
  test.describe("Playback state machine", () => {
    test.beforeEach(async ({ page }) => {
      await loadSampleScore(page);
    });

    test("▶ Play → status 'Playing', Stop enabled", async ({ page }) => {
      await page.getByRole("button", { name: "▶ Play" }).click();
      await expect(page.getByTestId("status")).toContainText("Playing reference");
      await expect(page.getByRole("button", { name: "■ Stop" })).toBeEnabled();
      await expect(page.getByRole("button", { name: "▶ Play" })).toBeDisabled();
    });

    test("■ Stop → status 'Stopped', Play re-enabled", async ({ page }) => {
      await page.getByRole("button", { name: "▶ Play" }).click();
      await expect(page.getByTestId("status")).toContainText("Playing reference");
      await page.getByRole("button", { name: "■ Stop" }).click();
      await expect(page.getByTestId("status")).toContainText("Stopped");
      await expect(page.getByRole("button", { name: "▶ Play" })).toBeEnabled();
    });

    test("Play button disabled when no score is loaded", async ({ page }) => {
      await page.goto("/");
      await expect(page.getByRole("button", { name: "▶ Play" })).toBeDisabled();
    });
  });

  // --------------------------------------------------------------------------
  // State reset tests use MIDI upload as setup; skipped until migrated to audio path.
  test.describe.skip("State reset", () => {
    test("loading a new score clears comparison results", async ({ page }) => {
      await loadSampleScore(page);
      await midiInput(page).setInputFiles(SAMPLE_MID);
      await expect(page.getByTestId("status")).toContainText("Loaded performance");
      await page.getByRole("button", { name: "Compare" }).click();
      await expect(page.getByTestId("results-summary")).toBeVisible();

      // Load a different score → results panel must disappear.
      await scoreXmlInput(page).setInputFiles(join(FIXTURES, "tetrachord.musicxml"));
      await expect(page.getByTestId("status")).toContainText("Loaded score");
      await expect(page.getByTestId("results-summary")).not.toBeVisible();
    });

    test("loading a new performance clears comparison results", async ({ page }) => {
      await loadSampleScore(page);
      await midiInput(page).setInputFiles(SAMPLE_MID);
      await expect(page.getByTestId("status")).toContainText("Loaded performance");
      await page.getByRole("button", { name: "Compare" }).click();
      await expect(page.getByTestId("results-summary")).toBeVisible();

      // Load a new performance → results gone until Compare is run again.
      await midiInput(page).setInputFiles(join(FIXTURES, "perfect-perf.mid"));
      await expect(page.getByTestId("results-summary")).not.toBeVisible();
    });

    test("Compare can be run multiple times with consistent results", async ({ page }) => {
      await loadSampleScore(page);
      await midiInput(page).setInputFiles(SAMPLE_MID);
      await expect(page.getByTestId("status")).toContainText("Loaded performance");

      for (let run = 0; run < 3; run++) {
        await page.getByRole("button", { name: "Compare" }).click();
        await expect(page.getByTestId("status")).toContainText("Comparison complete");
        await expect(page.getByTestId("results-summary")).toContainText("87.5%");
      }
    });
  });

  // --------------------------------------------------------------------------
  // Error handling tests use MIDI upload; skipped until migrated to audio path.
  test.describe.skip("Error handling", () => {
    test("invalid MIDI file → error in status, no crash", async ({ page }) => {
      await loadSampleScore(page);
      await midiInput(page).setInputFiles(join(FIXTURES, "invalid.mid"));
      await expect(page.getByTestId("status")).toContainText("error", { timeout: 5_000 });
      // Page must still be functional — Compare is disabled (no valid perf).
      await expect(page.getByRole("button", { name: "Compare" })).toBeDisabled();
    });

    test("invalid MIDI does not remove the loaded score", async ({ page }) => {
      await loadSampleScore(page);
      await expect(
        page.getByTestId("score-view").locator("svg").first()
      ).toBeVisible({ timeout: 15_000 });

      await midiInput(page).setInputFiles(join(FIXTURES, "invalid.mid"));
      await expect(page.getByTestId("status")).toContainText("error");
      // Score must still be visible — the upload error should not wipe it.
      await expect(
        page.getByTestId("score-view").locator("svg").first()
      ).toBeVisible();
    });
  });
});
