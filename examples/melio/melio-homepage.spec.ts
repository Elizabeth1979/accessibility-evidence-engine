import { readFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";
import { loadScenario } from "@aee/cli";
import { runAeeOnPage, runVirtualScreenReaderLane } from "@aee/playwright";

test("Melio homepage moves focus forward from Sign in", async ({ page }) => {
  await page.goto("https://melio.com/", {
    waitUntil: "domcontentloaded"
  });

  const signIn = page.getByRole("link", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible();
  await signIn.focus();

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: "aee-output",
    checkpointName: "melio-homepage-sign-in",
    observers: ["focus", "dom", "accessibility-tree", "visual", "axe"],
    judges: ["keyboard", "axe", "release"],
    interaction: {
      kind: "tab",
      actor: "test",
      target: {
        role: "link",
        name: "Sign in"
      }
    },
    async performInteraction({ page }) {
      await page.keyboard.press("Tab");
    }
  });

  await expect(page.getByRole("link", { name: "Start now", exact: true }).first()).toBeFocused();
  console.log("AEE reports:", result.reporterFiles);
});

test("Melio homepage runs user-selected virtual-reader commands in an isolated lane", async ({
  browser
}) => {
  const scenario = await loadScenario(path.resolve("examples/melio/scenario.yml"));
  const journey = scenario.journeys[0]!;
  const commands = journey.virtualScreenReaderCommands;
  expect(commands).toEqual(["next-landmark", "next-heading", "next-control"]);

  const lane = await runVirtualScreenReaderLane({
    browser,
    projectRoot: process.cwd(),
    outputDir: "aee-output",
    laneId: `melio-virtual-reader-${Date.now()}`,
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
