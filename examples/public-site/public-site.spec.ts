import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { loadScenario } from "@aee/cli";
import { runAeeOnPage, runInputComparison, runVirtualScreenReaderLane } from "@aee/playwright";

test("Public homepage moves focus forward through the primary navigation", async ({ page }) => {
  await page.goto("https://elizabeth1979.github.io/accessibility-evidence-engine/", {
    waitUntil: "domcontentloaded"
  });

  const evidenceFlow = page.getByRole("link", { name: "Evidence flow", exact: true });
  await expect(evidenceFlow).toBeVisible();
  await evidenceFlow.focus();

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: "aee-output",
    checkpointName: "public-homepage-evidence-flow",
    observers: ["focus", "dom", "accessibility-tree", "visual", "axe"],
    judges: ["keyboard", "axe", "release"],
    interaction: {
      kind: "tab",
      actor: "test",
      target: {
        role: "link",
        name: "Evidence flow"
      }
    },
    async performInteraction({ page }) {
      await page.keyboard.press("Tab");
    }
  });

  await expect(page.getByRole("link", { name: "Examples", exact: true }).first()).toBeFocused();
  console.log("AEE reports:", result.reporterFiles);
});

test("Public homepage runs user-selected virtual-reader commands in an isolated lane", async ({
  browser
}) => {
  const scenario = await loadScenario(path.resolve("examples/public-site/scenario.yml"));
  const journey = scenario.journeys[0]!;
  const commands = journey.virtualScreenReaderCommands;
  expect(commands).toEqual(["next-landmark", "next-heading", "next-control"]);

  const lane = await runVirtualScreenReaderLane({
    browser,
    projectRoot: process.cwd(),
    outputDir: "aee-output",
    laneId: `public-site-virtual-reader-${Date.now()}`,
    targetUrl: new URL(journey.startPath ?? "/", scenario.target.url).href,
    allowedOrigins: scenario.target.allowedOrigins ?? [scenario.target.url],
    commands: commands!
  });

  expect(lane.steps).toHaveLength(commands!.length);
  expect(lane.transcript.entries.every(({ focusMoved }) => !focusMoved)).toBe(true);
  expect(JSON.parse(await readFile(lane.transcriptJsonFile!, "utf8")).entries).toHaveLength(
    commands!.length
  );
  console.log("AEE virtual-reader lane:", lane.laneFile);
});

test("Public homepage runs the user-authored pointer and keyboard comparison", async ({
  browser
}) => {
  const scenario = await loadScenario(path.resolve("examples/public-site/scenario.yml"));
  const journey = scenario.journeys[0]!;
  const comparison = journey.interactionComparisons?.[0];
  expect(comparison).toBeDefined();

  const result = await runInputComparison({
    browser,
    projectRoot: process.cwd(),
    outputDir: "aee-output",
    comparisonId: `public-site-${comparison!.id}-${Date.now()}`,
    name: comparison!.name,
    targetUrl: new URL(journey.startPath ?? "/", scenario.target.url).href,
    allowedOrigins: scenario.target.allowedOrigins ?? [scenario.target.url],
    pointerActions: comparison!.pointerActions,
    keyboardActions: comparison!.keyboardActions,
    observe: comparison!.observe,
    expected: comparison!.expected
  });

  expect(result.equivalence.verdict).toBe("pass");
  expect(result.expectation?.verdict).toBe("pass");
  console.log("AEE pointer/keyboard trace:", result.traceFile);
  console.log("AEE evidence manifest:", result.manifestFile);
});
