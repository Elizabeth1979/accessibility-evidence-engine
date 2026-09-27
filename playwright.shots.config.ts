import { defineConfig } from "@playwright/test";

// `npm run site:shots`: product shots and videos for the site, from a real run of the test lab.
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.shots.ts",
  outputDir: "test-results/shots",
  workers: 1,
  timeout: 10 * 60_000,
  use: {
    // Playwright's default viewport, the size the engine records every lane at.
    headless: true
  }
});
