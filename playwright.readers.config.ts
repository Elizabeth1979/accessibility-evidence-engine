import { defineConfig } from "@playwright/test";

// Screen-reader commands that are not part of the test suite, each its own project:
// - `npm run reader:record` records AEE's virtual screen reader reading a page, on video.
// - `npm run readers:compare` reads a page with AEE's virtual screen reader, Guidepup's virtual
//   screen reader and the real one on this machine (VoiceOver, NVDA or Orca, driven by Guidepup),
//   and scores how much of the real reader each virtual one says. The real reader takes the
//   machine over for a minute or two.
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
    // A screen reader reads a window it can see. Guidepup's virtual reader is imported into the page
    // as a module, which a page's Content-Security-Policy would refuse.
    { name: "compare", testMatch: "*.compare.ts", use: { headless: false, bypassCSP: true } }
  ]
});
