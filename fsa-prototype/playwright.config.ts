import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // Each test gets its own timeout; audio decode can take a few seconds.
  timeout: 30_000,
  expect: { timeout: 12_000 },
  // Run tests serially — the dev server is shared.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: "http://localhost:3000",
    headless: true,
    // Suppress browser-side console noise in test output.
    // Remove this to debug: page.on('console', msg => console.log(msg.text()))
  },

  globalSetup: "./e2e/global-setup.ts",

  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],

  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    // Reuse a running dev server locally; always start fresh on CI.
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
