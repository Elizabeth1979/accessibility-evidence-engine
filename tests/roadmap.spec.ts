import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

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
  await expect(browser.locator(".milestone")).toHaveCount(9);
  await expect(browser.locator(".station")).toHaveCount(9);
  await expect(browser.locator(".milestone .m-outcome")).toHaveCount(9);

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
