import { defineConfig } from "@playwright/test";

// `npm run readers:compare`: reads a page with the virtual screen reader and with VoiceOver or NVDA
// on this machine. The real reader takes the machine over, so it is not part of the test suite.
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.compare.ts",
  outputDir: "test-results/readers-run",
  reporter: "list",
  workers: 1,
  timeout: 10 * 60_000
});
