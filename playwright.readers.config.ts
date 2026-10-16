import { defineConfig } from "@playwright/test";

// Screen-reader commands that are not part of the test suite, each its own project:
// - `npm run reader:record` records AEE's virtual screen reader reading a page, on video.
// - `npm run readers:compare` reads a page with AEE's virtual screen reader and with the real one
//   on this machine (VoiceOver, NVDA or Orca) through Guidepup. The real reader takes the machine
//   over for a minute or two.
export default defineConfig({
  testDir: "./tests",
  outputDir: "test-results/readers-run",
  reporter: "list",
  // One machine has one screen reader: never two tests at once.
  workers: 1,
  fullyParallel: false,
  timeout: 10 * 60_000,
  projects: [
    { name: "record", testMatch: "*.record.ts" },
    // A screen reader reads a window it can see.
    { name: "compare", testMatch: "*.compare.ts", use: { headless: false } }
  ]
});
