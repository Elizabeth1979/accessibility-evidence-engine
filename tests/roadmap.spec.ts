import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { sweepKeyboardAndPointer } from "@aee/playwright";

import { parsePlan } from "../scripts/master-plan.mjs";

const page = pathToFileURL(path.resolve("site/roadmap.html")).href;

test.beforeAll(() => {
  execFileSync(process.execPath, ["scripts/generate-roadmap.mjs"]);
});

test("roadmap is generated from the plan and opens the current milestone", async ({
  page: browser
}) => {
  await browser.goto(page);
  const now = browser.locator(".milestone.now");
  await expect(now).toHaveCount(1);
  await expect(now.locator("details")).toHaveAttribute("open", "");
  await expect(now.locator(".m-tag")).toHaveText("You are here");
  // One of each per milestone in the plan.
  const milestones = parsePlan(await readFile("docs/MASTER-PLAN.md", "utf8")).length;
  await expect(browser.locator(".milestone")).toHaveCount(milestones);
  await expect(browser.locator(".station")).toHaveCount(milestones);
  await expect(browser.locator(".milestone .m-outcome")).toHaveCount(milestones);
  // Each milestone title is a real heading, so screen reader users can jump between them.
  await expect(browser.getByRole("heading", { level: 2 })).toHaveCount(milestones);

  const result = await new AxeBuilder({ page: browser }).analyze();
  expect(result.violations.map(({ id }) => id)).toEqual([]);
});

test("roadmap works at phone width without sideways scrolling", async ({ page: browser }) => {
  await browser.setViewportSize({ width: 390, height: 800 });
  await browser.goto(page);
  const overflow = await browser.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth
  );
  expect(overflow).toBe(false);
});

test("the keyboard and pointer sweep finds nothing on the roadmap, where every title is a heading", async ({
  page: browser
}) => {
  const { findings } = await sweepKeyboardAndPointer({
    page: browser,
    url: page,
    activateControls: false
  });
  expect(findings).toEqual([]);
});
