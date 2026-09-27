import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

interface LabCase {
  url: string;
  observedAxeViolationIds: string[];
  headingOutline: string[];
}

// The contract is the known answer for every lab case: a missed violation or a new one fails.
const contract = JSON.parse(readFileSync("site/test-lab-contract.json", "utf8")) as {
  cases: Record<string, LabCase>;
};
const site = pathToFileURL(path.resolve("site") + path.sep).href;
const fixture = new URL("test-case.html", site).href;

for (const [name, labCase] of Object.entries(contract.cases)) {
  test(`lab case: ${name}`, async ({ page }) => {
    await page.goto(new URL(labCase.url, site).href);
    const result = await new AxeBuilder({ page }).analyze();
    const rules = result.violations.map(({ id }) => id).sort();
    expect(rules).toEqual([...labCase.observedAxeViolationIds].sort());
    const outline = await page
      .locator("h1,h2,h3,h4,h5,h6")
      .evaluateAll((nodes) => nodes.map((node) => node.tagName));
    expect(outline).toEqual(labCase.headingOutline);
  });
}

test("fixture controls work with keyboard and reset on reload", async ({ page }) => {
  await page.goto(`${fixture}?case=fixed`);
  await page.locator("#archive-project").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#restore-project")).toBeFocused();
  await expect(page.locator("#project-alpha")).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(page.locator("#archive-project")).toBeFocused();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Space");
  await expect(page.locator("#digest-state")).toHaveText("Disabled");
  await page.reload();
  await expect(page.locator("#digest-state")).toHaveText("Enabled");
});

test("lab navigation is accessible and layouts fit desktop and mobile", async ({ page }) => {
  await page.goto(pathToFileURL(path.resolve("site/test-lab.html")).href);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  for (const { url } of Object.values(contract.cases)) {
    await expect(page.locator(`.experiments a[href="${url}"]`)).toHaveCount(1);
  }
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const file of ["test-lab.html", "test-case.html?case=headings"]) {
      await page.goto(new URL(file, fixture).href);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
      await page.screenshot({
        path: `/tmp/aee-${width}-${file.split(".")[0]}.png`,
        fullPage: true
      });
    }
  }
});
