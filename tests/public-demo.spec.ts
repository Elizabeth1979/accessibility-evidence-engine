import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

const demoUrl = pathToFileURL(path.resolve("site/index.html")).href;

test("public demo exposes its purpose and limitations", async ({ page }) => {
  await page.goto(demoUrl);

  await expect(page).toHaveTitle("Accessibility Evidence Engine");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Accessibility results with the evidence attached."
    })
  ).toBeVisible();
  await expect(page.getByText(/not a complete WCAG scanner/i)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeAttached();
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeAttached();
});

test("slideshow shows only one focused before-and-after example", async ({ page }) => {
  await page.goto(demoUrl);

  await expect(
    page.getByRole("heading", { name: "One issue. One before. One after." })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Give an icon-only button a useful name" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Make the semantic outline match the visual structure" })
  ).toBeHidden();
  await expect(page.locator("video")).toHaveCount(0);
  await expect(page.locator(".issue-fix-summary, .evidence-grid")).toHaveCount(0);

  await page.getByRole("button", { name: "Headings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Give an icon-only button a useful name" })
  ).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Make the semantic outline match the visual structure" })
  ).toBeVisible();
  await expect(page.locator("#slideshow-status")).toHaveText("Example 2 of 3: Headings");
});

test("slideshow supports buttons and arrow-key navigation", async ({ page }) => {
  await page.goto(demoUrl);

  const next = page.getByRole("button", { name: "Show next example" });
  await next.click();
  await next.click();
  await expect(
    page.getByRole("heading", { name: "Move focus into an opened modal" })
  ).toBeVisible();

  const modalPicker = page.getByRole("button", { name: "Modal focus", exact: true });
  await modalPicker.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("heading", { name: "Give an icon-only button a useful name" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Icon label", exact: true })).toBeFocused();

  await page.getByRole("button", { name: "Show previous example" }).click();
  await expect(
    page.getByRole("heading", { name: "Move focus into an opened modal" })
  ).toBeVisible();
});

test("slideshow images and generated evidence agree", async ({ page }) => {
  await page.goto(demoUrl);

  const [axeUnnamed, axeNamed, axeHeading, aiLabel, aiHeading, issueReport, fixedReport] =
    await Promise.all(
      [
        "axe-unnamed-icon.json",
        "axe-named-icon.json",
        "axe-heading-structure.json",
        "ai-label-suggestion.json",
        "ai-heading-suggestion.json",
        "recorded-modal-focus-issue/aee-report.json",
        "recorded-modal-focus-fixed/aee-report.json"
      ].map(async (fileName) =>
        JSON.parse(await readFile(path.resolve(`site/demo-artifacts/${fileName}`), "utf8"))
      )
    );

  expect(axeUnnamed.violations.some((violation) => violation.id === "button-name")).toBe(true);
  expect(axeNamed.violations).toEqual([]);
  expect(aiLabel.routing.route).toBe("ai-review");
  expect(aiLabel.proposal.patches).toContain(
    '#delete-project: add aria-label="Delete Project Alpha"'
  );
  expect(axeHeading.violations).toEqual([]);
  expect(aiHeading.routing.route).toBe("ai-review");
  expect(aiHeading.proposal.after).toContain("  h2 Settings");
  expect(issueReport.run.results).toEqual({ pass: 1, fail: 2, unknown: 0 });
  expect(fixedReport.run.results).toEqual({ pass: 3, fail: 0, unknown: 0 });

  for (const image of await page.locator(".before-after img").all()) {
    await expect(image).toHaveAttribute("alt", /.+/);
    await expect(image).toHaveJSProperty("complete", true);
  }
});

test("evidence is readable in place and raw artifacts are downloads", async ({ page }) => {
  await page.goto(demoUrl);

  await page.getByText("Read the evidence behind these examples").click();

  await expect(page.getByRole("heading", { name: "Icon label" })).toBeVisible();
  await expect(page.getByText('aria-label="Delete Project Alpha"')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Heading hierarchy" })).toBeVisible();
  await expect(
    page.getByText(/missing relationship, not an invalid heading sequence/i)
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Modal focus" })).toBeVisible();
  await expect(page.getByText(/focused element is still its trigger/i)).toBeVisible();

  const rawLinks = page.locator(".raw-downloads a");
  await expect(rawLinks).toHaveCount(7);
  for (const link of await rawLinks.all()) {
    await expect(link).toHaveAttribute("download", "");
  }
});
