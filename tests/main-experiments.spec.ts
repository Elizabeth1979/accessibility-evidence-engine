import path from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
const home = pathToFileURL(path.resolve("site/index.html")).href;

test("baseline and every example have no Axe violations", async ({ page }) => {
  await page.goto(home);
  for (const button of await page.locator("[data-slide-target]").all()) {
    await button.click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  }
  await page.locator(".evidence-library > summary").click();
  await page.locator(".workflow-details > summary").click();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const issue of ["icon-labels", "headings", "body-hidden"]) {
  test(`main page plants ${issue} and Escape restores baseline`, async ({ page }) => {
    await page.goto(`${home}?issue=${issue}#experiments`);
    await expect(page.locator("body")).toHaveAttribute("data-issues", issue);
    const result = await new AxeBuilder({ page }).analyze();
    if (issue === "icon-labels") {
      expect(result.violations.map(({ id }) => id)).toEqual(["button-name"]);
      expect(result.violations[0].nodes).toHaveLength(2);
      await page.locator("#next-example").click();
      await expect(page.locator("#slideshow-status")).toContainText("Example 2");
    }
    if (issue === "headings") {
      expect(result.violations).toEqual([]);
      await expect(page.locator("h3#examples-title")).toBeVisible();
      await expect(page.locator("#examples h4")).toHaveCount(12);
    }
    if (issue === "body-hidden")
      expect(result.violations.map(({ id }) => id)).toContain("aria-hidden-body");
    await page.keyboard.press("Escape");
    await expect(page.locator("body")).toHaveAttribute("data-issues", "");
    await expect(page.locator("body")).not.toHaveAttribute("aria-hidden");
    await expect(page.locator("#next-example")).toHaveAccessibleName("Show next example");
    await expect(page.locator("h2#examples-title")).toBeVisible();
  });
}

test("experiments are discoverable on mobile and keyboard accessible", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(home);
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();
  await expect(
    page.getByRole("link", { name: "Accessibility experiments", exact: true })
  ).toBeVisible();
  await page.getByRole("link", { name: "Try accessibility experiments" }).click();
  const checkbox = page.locator('input[value="headings"]');
  await checkbox.focus();
  await page.keyboard.press("Space");
  await expect(checkbox).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.locator("#experiments").screenshot({ path: "/tmp/aee-main-experiments-mobile.png" });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator("#experiments").screenshot({ path: "/tmp/aee-main-experiments-desktop.png" });
});

test("form applies combined issues and reset clears the URL", async ({ page }) => {
  await page.goto(home);
  await page.locator('input[value="headings"]').check();
  await page.locator('input[value="icon-labels"]').check();
  await page.getByRole("button", { name: "Apply selected issues" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-issues", "headings,icon-labels");
  await expect(page.locator("h3#examples-title")).toBeAttached();
  await expect(page.locator("#next-example")).toHaveAccessibleName("");
  await page.getByRole("link", { name: "Reset to accessible baseline" }).click();
  await expect(page.locator("body")).toHaveAttribute("data-issues", "");
  expect(new URL(page.url()).search).toBe("");
});
