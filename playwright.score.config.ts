import { defineConfig } from "@playwright/test";

// `npm run score:ai`: scores each model's names for the test lab's nameless controls against the
// names the fixed page gives them. Needs a model, so it is not part of the test suite.
export default defineConfig({
  testDir: "./tests",
  testMatch: "*.score.ts",
  outputDir: "test-results/score",
  reporter: "list",
  workers: 1,
  // A free model on a build machine's CPU takes minutes per page.
  timeout: 30 * 60_000,
  use: {
    headless: true
  }
});
