import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "public-site.spec.ts",
  workers: 1,
  use: {
    headless: true
  }
});
