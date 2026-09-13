import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { loadConfig, loadFixture, loadScenario } from "./index";

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

test("loadScenario accepts the user-controlled Melio YAML scenario", async () => {
  const scenarioPath = path.resolve(__dirname, "../../../examples/melio/scenario.yml");
  const scenario = await loadScenario(scenarioPath);

  assert.equal(scenario.id, "melio-public-homepage");
  assert.equal(scenario.profile, "core");
  assert.deepEqual(scenario.standard.levels, ["A", "AA"]);
  assert.deepEqual(scenario.journeys[0]?.forbiddenActions, [
    "sign-in",
    "create-account",
    "submit-personal-information",
    "initiate-payment"
  ]);
});

test("loadScenario rejects duplicate YAML keys", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aee-cli-scenario-"));
  const scenarioPath = path.join(tempDir, "duplicate.yml");

  try {
    await writeFile(scenarioPath, "id: first\nid: second\n", "utf8");
    await assert.rejects(() => loadScenario(scenarioPath), /Map keys must be unique/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
