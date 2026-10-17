import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parse, stringify } from "yaml";

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

test("loadScenario accepts the user-controlled public site YAML scenario", async () => {
  const scenarioPath = path.resolve(__dirname, "../../../examples/public-site/scenario.yml");
  const scenario = await loadScenario(scenarioPath);

  assert.equal(scenario.id, "public-site-homepage");
  assert.equal(scenario.profile, "core");
  assert.deepEqual(scenario.standard.levels, ["A", "AA"]);
  assert.deepEqual(scenario.journeys[0]?.forbiddenActions, [
    "sign-in",
    "create-account",
    "submit-personal-information",
    "initiate-payment"
  ]);
  assert.equal(scenario.journeys[0]?.interactionComparisons?.[0]?.id, "nav-link-hover-focus");
});

/** Writes the public-site example with its journey changed, and loads it. */
async function loadExampleWith(change: (journey: Record<string, unknown>) => void) {
  const examplePath = path.resolve(__dirname, "../../../examples/public-site/scenario.yml");
  const scenario = parse(await readFile(examplePath, "utf8")) as { journeys: Array<never> };
  change(scenario.journeys[0]!);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aee-cli-scenario-"));
  const scenarioPath = path.join(tempDir, "scenario.yml");
  try {
    await writeFile(scenarioPath, stringify(scenario), "utf8");
    return await loadScenario(scenarioPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

test("loadScenario refuses a journey id too long to name the evidence its lanes write", async () => {
  // The sweep lane's evidence folder is named "<journey id>-keyboard-pointer-sweep".
  const journeyId = `explore-${"a".repeat(98)}`;

  await assert.rejects(
    () => loadExampleWith((journey) => (journey.id = journeyId)),
    new Error(
      `Journey “${journeyId}” makes an evidence folder name that is too long: its keyboard and pointer sweep would be named “${journeyId}-keyboard-pointer-sweep”, which is 129 characters, and the most is 128. Shorten the journey id by at least 1 character.`
    )
  );
});

test("loadScenario refuses a comparison whose ids together are too long to name its actions' evidence", async () => {
  // Each keyboard action's folder is named "<journey id>-<comparison id>-keyboard-<number>".
  const comparisonId = `nav-${"a".repeat(88)}`;
  const runId = `explore-public-homepage-${comparisonId}-keyboard-001`;

  await assert.rejects(
    () =>
      loadExampleWith((journey) => {
        (journey.interactionComparisons as Array<{ id: string }>)[0]!.id = comparisonId;
      }),
    new Error(
      `Journey “explore-public-homepage” comparison “${comparisonId}” makes an evidence folder name that is too long: its keyboard action 1 would be named “${runId}”, which is 129 characters, and the most is 128. Shorten the journey id or the comparison id by at least 1 character.`
    )
  );
});

test("loadScenario accepts ids that name every lane's evidence within the limit", async () => {
  const comparisonId = `nav-${"a".repeat(87)}`;
  const scenario = await loadExampleWith((journey) => {
    (journey.interactionComparisons as Array<{ id: string }>)[0]!.id = comparisonId;
  });

  assert.equal(
    `explore-public-homepage-${comparisonId}-keyboard-001`.length,
    128,
    "the longest name is exactly at the limit"
  );
  assert.equal(scenario.journeys[0]?.interactionComparisons?.[0]?.id, comparisonId);
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
