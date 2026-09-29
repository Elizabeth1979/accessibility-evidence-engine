import { pathToFileURL } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { contract, readerWalk, runOnLabPage } from "./test-lab-helpers";

const layers = ["headings", "tab-order", "images", "focus"] as const;
const reports: Record<"issues" | "fixed", string> = { issues: "", fixed: "" };

test.beforeAll(async ({ browser }, testInfo) => {
  // Two full lab runs, one after the other: each writes its scenario to the test's folder.
  test.setTimeout(120_000);
  for (const page of ["issues", "fixed"] as const) {
    const run = await runOnLabPage(
      browser,
      contract.pages[page],
      ["focus", "hover", "activate-page-controls"],
      testInfo,
      { readerCommands: readerWalk }
    );
    reports[page] = `${pathToFileURL(run.reportFiles.html).href}#panel-page`;
  }
});

/** Switches every added layer on from the keyboard, and checks its list and markers appear. */
async function switchLayersOn(page: Page) {
  const panel = page.locator("#panel-page");
  for (const layer of layers) {
    const toggle = panel.locator(`[data-layer-toggle="${layer}"]`);
    await expect(toggle).not.toBeChecked();
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(panel.locator(`section[data-layer="${layer}"]`)).toBeVisible();
  }
  // Every item with a position has exactly one outline on the page.
  for (const item of await panel.locator(".marker-item[data-marker]").all()) {
    const id = await item.getAttribute("data-marker");
    await expect(panel.locator(`[data-marker-shape="${id}"]`)).toHaveCount(1);
  }
  return panel;
}

const items = (panel: ReturnType<Page["locator"]>, layer: (typeof layers)[number]) =>
  panel.locator(`section[data-layer="${layer}"] li`);

for (const [device, width] of [
  ["desktop", 1280],
  ["phone", 390]
] as const) {
  test(`Page view on ${device}: the demo page's heading, keyboard and alt text issues each show on their layer, with no axe violations`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(reports.issues);
    const panel = await switchLayersOn(page);

    // Headings: the outline as a screen reader lists it, the empty one flagged, and the level 3
    // indented under Projects, where the lab's wrong-heading-level issue puts it.
    const headings = items(panel, "headings");
    await expect(headings.locator(".marker-number")).toHaveText(
      contract.pages.issues.headingOutline
    );
    await expect(headings.filter({ hasText: "Empty heading" })).toHaveCount(1);
    await expect(headings.filter({ hasText: "Workspace settings" })).toHaveAttribute(
      "style",
      "--depth:2"
    );

    // Images: the chart with no text alternative is flagged; the decorative logo is not.
    const images = items(panel, "images");
    await expect(images.filter({ hasText: "No alt" })).toHaveCount(1);
    await expect(images.filter({ hasText: "#usage-chart" })).toContainText("No alt");
    await expect(images.filter({ hasText: "Decorative" }).locator(".marker-flag")).toHaveCount(0);

    // Tab order: each keyboard issue the sweep found, on the stop it affects or listed where Tab
    // never goes.
    const tabOrder = items(panel, "tab-order");
    await expect(tabOrder.filter({ hasText: "Export report" })).toContainText(
      "Works with a mouse only"
    );
    await expect(tabOrder.filter({ hasText: "Team plan" })).toContainText(
      "Shown on mouse hover only"
    );
    await expect(tabOrder.filter({ hasText: "Focus is lost after an action" })).toHaveCount(1);

    // Focus: every stop shows how it looked with focus, and the lab has no focus-style issue.
    const focus = items(panel, "focus");
    await expect(focus).toHaveCount(
      await tabOrder.locator(".marker-number", { hasText: /^\d+$/ }).count()
    );
    // Close-ups load lazily, as each scrolls into view.
    for (const crop of await focus.locator("img.focus-crop").all()) {
      await crop.scrollIntoViewIfNeeded();
      await expect
        .poll(() => crop.evaluate((image: HTMLImageElement) => image.naturalWidth))
        .toBeGreaterThan(0);
    }
    await expect(focus.filter({ hasText: "No visible focus" })).toHaveCount(0);

    // Keyboard only: select the mouse-only export control and see its outline highlighted.
    const exportItem = tabOrder.filter({ hasText: "Export report" }).locator(".marker-item");
    await exportItem.focus();
    await page.keyboard.press("Enter");
    await expect(exportItem).toHaveAttribute("aria-current", "true");
    await expect(
      panel.locator(`[data-marker-shape="${await exportItem.getAttribute("data-marker")}"]`)
    ).toHaveClass(/current/);

    const result = await new AxeBuilder({ page }).include("#panel-page").analyze();
    expect(result.violations).toEqual([]);
  });
}

test("the fixed page shows the same layers with nothing flagged", async ({ page }) => {
  await page.goto(reports.fixed);
  const panel = await switchLayersOn(page);

  await expect(items(panel, "headings").locator(".marker-number")).toHaveText(
    contract.pages.fixed.headingOutline
  );
  await expect(items(panel, "images")).toHaveCount(2);
  await expect(items(panel, "tab-order").filter({ hasText: "Export report" })).toHaveCount(1);
  for (const layer of layers) {
    await expect(items(panel, layer)).not.toHaveCount(0);
    await expect(items(panel, layer).locator(".marker-flag"), layer).toHaveCount(0);
  }
});
