import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  // Text snapshots are the same on every platform, so one file serves macOS, Linux and CI.
  snapshotPathTemplate: "{testDir}/__snapshots__/{testFilePath}/{arg}{ext}",
  fullyParallel: true,
  use: {
    headless: true
  }
});
