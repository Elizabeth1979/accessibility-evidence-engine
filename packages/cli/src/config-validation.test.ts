import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, loadFixture } from "./index";

test("loadConfig accepts the example CLI config", async () => {
  const configPath = path.resolve(__dirname, "../../../examples/basic-run-config.json");
  const config = await loadConfig(configPath);

  assert.equal(config.projectRoot, "..");
  assert.equal(config.fixturePath, "./basic-fixture.json");
});

test("loadFixture rejects malformed fixture payloads", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aee-cli-fixture-"));
  const fixturePath = path.join(tempDir, "invalid-fixture.json");

  try {
    await writeFile(
      fixturePath,
      JSON.stringify({
        url: "https://example.com"
      }),
      "utf8"
    );

    await assert.rejects(() => loadFixture(fixturePath), /missing required property "html"/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
