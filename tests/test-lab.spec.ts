import path from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const fixture = pathToFileURL(path.resolve("site/test-case.html")).href;
for (const scenario of ["fixed", "headings", "icon-labels", "body-hidden", "all"]) {
  test(`controlled fixture: ${scenario}`, async ({ page }) => {
    await page.goto(`${fixture}?case=${scenario}`);
    await expect(page.locator("body")).toHaveAttribute("data-test-case", scenario);
    const result = await new AxeBuilder({ page }).analyze();
    const rules = result.violations.map(({ id }) => id);
    console.log(scenario, JSON.stringify(rules));
    if (scenario === "fixed" || scenario === "headings") expect(rules).toEqual([]);
    if (scenario === "icon-labels") {
      expect(rules).toEqual(["button-name"]);
      expect(result.violations[0].nodes).toHaveLength(2);
    }
    if (scenario === "body-hidden" || scenario === "all") {
      expect(rules).toContain("aria-hidden-body");
      await expect(page.locator("body")).toHaveAttribute("aria-hidden", "true");
    }
    const levels = await page
      .locator("h1,h2,h3")
      .evaluateAll((nodes) => nodes.map((node) => node.tagName));
    expect(levels).toEqual([
      "H1",
      "H2",
      scenario === "headings" || scenario === "all" ? "H3" : "H2"
    ]);
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
  await expect(page.locator(".experiments a")).toHaveCount(5);
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
