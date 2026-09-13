import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "melio-homepage.spec.ts",
  workers: 1,
  use: {
    headless: true
  }
});
