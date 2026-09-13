import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import AxeBuilder from "@axe-core/playwright";
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

test("evidence flow documents every capture lane and its implementation status", async ({
  page
}) => {
  await page.goto(demoUrl);

  const flow = page.locator(".workflow-map");
  await expect(flow.getByRole("heading", { name: "Describe one user journey" })).toBeVisible();
  await expect(
    flow.getByRole("heading", { name: "Fork the journey into independent input lanes" })
  ).toBeVisible();
  await expect(flow.getByText("DOM + focus", { exact: true })).toBeVisible();
  await expect(flow.getByText("axe", { exact: true })).toBeVisible();
  await expect(flow.getByText("Virtual screen reader", { exact: true })).toBeVisible();
  await expect(flow.getByText("Action trace", { exact: true })).toBeVisible();
  await expect(flow.getByText("Transcript + video", { exact: true })).toBeVisible();
  await expect(flow.getByText("Available", { exact: true })).toHaveCount(3);
  await expect(flow.getByText("Planned", { exact: true })).toHaveCount(4);
  await expect(
    page.getByRole("link", { name: /artifact contract and Mermaid source/i })
  ).toHaveAttribute("href", /docs\/evidence-run-layout\.md$/);
});

test("generated remediation table stays readable and identifies AI boundaries", async ({
  page
}) => {
  await page.goto(demoUrl);

  const registry = page.getByRole("region", { name: "Remediation registry table" });
  await expect(registry.getByRole("table")).toBeVisible();
  await expect(registry.getByRole("row")).toHaveCount(8);
  await expect(registry.getByText("Missing or unsuitable accessible name")).toBeVisible();
  await expect(registry.getByText("Text and component color contrast")).toBeVisible();
  await expect(registry.getByText("AI-assisted", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("link", { name: "JSON registry" })).toHaveAttribute(
    "href",
    "data/remediation-registry.json"
  );
});

test("public demo has no serious axe violations or prohibited ARIA attributes", async ({
  page
}) => {
  await page.goto(demoUrl);

  const results = await new AxeBuilder({ page }).analyze();
  const seriousViolations = results.violations.filter(({ impact }) =>
    ["serious", "critical"].includes(impact ?? "")
  );
  const prohibitedAria = [...results.violations, ...results.incomplete].filter(
    ({ id }) => id === "aria-prohibited-attr"
  );

  expect(seriousViolations).toEqual([]);
  expect(prohibitedAria).toEqual([]);
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
  await expect(page.locator("#slideshow-status")).toHaveText("Example 2 of 6: Headings");
});

test("slideshow supports buttons and arrow-key navigation", async ({ page }) => {
  await page.goto(demoUrl);

  const next = page.getByRole("button", { name: "Show next example" });
  await next.click();
  await next.click();
  await expect(
    page.getByRole("heading", { name: "Move focus into an opened modal" })
  ).toBeVisible();

  const animationPicker = page.getByRole("button", { name: "Animation", exact: true });
  await animationPicker.click();
  await animationPicker.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("heading", { name: "Give an icon-only button a useful name" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Icon label", exact: true })).toBeFocused();

  await page.getByRole("button", { name: "Show previous example" }).click();
  await expect(
    page.getByRole("heading", { name: "Verify that a Pause control really stops animation" })
  ).toBeVisible();
});

test("slideshow images and generated evidence agree", async ({ page }) => {
  await page.goto(demoUrl);

  const [
    axeUnnamed,
    axeNamed,
    axeHeading,
    aiLabel,
    aiHeading,
    issueReport,
    fixedReport,
    paletteEvidence,
    hoverEvidence,
    motionEvidence
  ] = await Promise.all(
    [
      "axe-unnamed-icon.json",
      "axe-named-icon.json",
      "axe-heading-structure.json",
      "ai-label-suggestion.json",
      "ai-heading-suggestion.json",
      "recorded-modal-focus-issue/aee-report.json",
      "recorded-modal-focus-fixed/aee-report.json",
      "palette-contrast/evidence.json",
      "hover-keyboard/evidence.json",
      "motion-control/evidence.json"
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
  expect(paletteEvidence.currentRatio).toBeLessThan(4.5);
  expect(paletteEvidence.selectedRatio).toBeGreaterThanOrEqual(4.5);
  expect(paletteEvidence.selected.name).toBe("Text subtle");
  expect(hoverEvidence.before.verdict).toBe("fail");
  expect(hoverEvidence.after.verdict).toBe("pass");
  expect(motionEvidence.before.verdict).toBe("fail");
  expect(motionEvidence.after.verdict).toBe("pass");

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
  await expect(rawLinks).toHaveCount(10);
  for (const link of await rawLinks.all()) {
    await expect(link).toHaveAttribute("download", "");
  }
});
