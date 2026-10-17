import { defineConfig } from "@playwright/test";

// Screen-reader commands that are not part of the test suite, each its own project:
// - `npm run reader:record` records AEE's virtual screen reader reading a page, on video.
// - `npm run readers:compare` reads a page with AEE's virtual screen reader and with the real one
//   on this machine (VoiceOver, NVDA or Orca, driven by Guidepup), lines the two transcripts up,
//   and lists what each said that the other did not. The real reader takes the machine over for
//   about ten minutes.
// - `npm run readers:combine` puts the comparisons from several machines (NVDA on Windows,
//   VoiceOver on a Mac) in one table; the "Real screen readers" workflow runs all three.
export default defineConfig({
  testDir: "./tests",
  outputDir: "test-results/readers-run",
  // In GitHub Actions, failures and retries also show on the run's page.
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
  // One machine has one screen reader: never two tests at once.
  workers: 1,
  fullyParallel: false,
  // A fresh CI machine can be slower than a desktop at stepping a reader through the page.
  timeout: 20 * 60_000,
  projects: [
    { name: "record", testMatch: "*.record.ts" },
    // A screen reader reads a window it can see.
    { name: "compare", testMatch: "*.compare.ts", use: { headless: false } },
    { name: "combine", testMatch: "*.combine.ts" }
  ]
});
