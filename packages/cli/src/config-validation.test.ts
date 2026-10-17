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

/** Writes the public-site example with its scenario changed, and loads it. */
async function loadExampleWith(change: (scenario: ExampleScenario) => void) {
  const examplePath = path.resolve(__dirname, "../../../examples/public-site/scenario.yml");
  const scenario = parse(await readFile(examplePath, "utf8")) as ExampleScenario;
  change(scenario);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aee-cli-scenario-"));
  const scenarioPath = path.join(tempDir, "scenario.yml");
  try {
    await writeFile(scenarioPath, stringify(scenario), "utf8");
    return await loadScenario(scenarioPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

interface ExampleScenario {
  target: { url: string; allowedOrigins?: string[] };
  journeys: Array<{ startPath?: string }>;
}

test("loadScenario refuses a journey whose startPath leads to a site the scenario may not visit", async () => {
  // A URL parser reads each of these as "//other.example/": the backslash counts as a slash and
  // the tab is dropped, so each one leaves the target site.
  for (const startPath of ["//other.example/", "/\\other.example/", "/\t/other.example/"]) {
    await assert.rejects(
      () => loadExampleWith(({ journeys }) => (journeys[0]!.startPath = startPath)),
      new Error(
        `Journey “explore-public-homepage” startPath ${JSON.stringify(startPath)} leads to https://other.example, which is not one of the sites this scenario may visit (https://elizabeth1979.github.io). Start at a path on one of those sites, such as "/", or add https://other.example to target.allowedOrigins.`
      )
    );
  }
});

test("loadScenario refuses a startPath off the target's own site when no allowed origins are listed", async () => {
  await assert.rejects(
    () =>
      loadExampleWith((scenario) => {
        delete scenario.target.allowedOrigins;
        scenario.journeys[0]!.startPath = "//other.example/";
      }),
    /leads to https:\/\/other\.example, which is not one of the sites this scenario may visit \(https:\/\/elizabeth1979\.github\.io\)/
  );
});

test("loadScenario accepts a startPath that leads to another site the scenario lists", async () => {
  const scenario = await loadExampleWith(({ target, journeys }) => {
    target.allowedOrigins = [target.url, "https://other.example/"];
    journeys[0]!.startPath = "//other.example/";
  });

  assert.equal(scenario.journeys[0]?.startPath, "//other.example/");
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
