import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { contract, readerWalk, runOnLabPage } from "./test-lab-helpers";

let reportUrl: string;
let located: { issues: number; announcements: number };

test.beforeAll(async ({ browser }, testInfo) => {
  const run = await runOnLabPage(browser, contract.pages.issues, ["focus", "hover"], testInfo, {
    readerCommands: readerWalk
  });
  reportUrl = `${pathToFileURL(run.reportFiles.html).href}#panel-page`;
  const transcript = JSON.parse(
    await readFile(path.join(run.outputDir, "lab-page-virtual-reader", "transcript.json"), "utf8")
  ) as { entries: Array<{ item?: { visualBounds?: unknown } }> };
  located = {
    issues: run.report.synthesis.findings.flatMap(({ instances }) => instances).length,
    announcements: transcript.entries.filter(({ item }) => item?.visualBounds).length
  };
});

async function expectNoViolations(page: Page, state: string) {
  const result = await new AxeBuilder({ page }).include("#panel-page").analyze();
  expect(result.violations, state).toEqual([]);
}

for (const [device, width] of [
  ["desktop", 1280],
  ["phone", 390]
] as const) {
  test(`Page view on ${device}: every finding and announcement is outlined at its element, by keyboard, with no axe violations`, async ({
    page
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(reportUrl);
    const panel = page.locator("#panel-page");
    await expect(page.getByRole("tab", { name: "Page view" })).toHaveAttribute(
      "aria-selected",
      "true"
    );

    // Every located finding instance and announcement has a list item and a marker on the page.
    const issueItems = panel.locator('[data-layer="issues"] .marker-item');
    const readerItems = panel.locator('[data-layer="reader"] .marker-item');
    await expect(issueItems).toHaveCount(located.issues);
    await expect(readerItems).toHaveCount(located.announcements);
    for (const item of await panel.locator(".marker-item").all()) {
      const id = await item.getAttribute("data-marker");
      await expect(panel.locator(`[data-marker-shape="${id}"]`)).toHaveCount(1);
    }
    // Announced without a name is flagged, as the Virtual reader status row says.
    await expect(readerItems.filter({ hasText: "No name" })).toHaveCount(3);
    await expectNoViolations(page, `${device}, default`);

    // Keyboard only: select the unnamed archive button and see its marker highlighted.
    const archive = issueItems.filter({ hasText: "Archive project" });
    await archive.focus();
    await page.keyboard.press("Enter");
    await expect(archive).toHaveAttribute("aria-current", "true");
    const marker = panel.locator(
      `[data-marker-shape="${await archive.getAttribute("data-marker")}"]`
    );
    await expect(marker).toHaveClass(/current/);
    const canvas = panel.locator(".page-canvas").first();
    // The picture moves to the marker; it glides there unless the reader asks for reduced motion.
    await expect
      .poll(async () => {
        const [box, view] = [await marker.boundingBox(), await canvas.boundingBox()];
        return box!.y >= view!.y && box!.y + box!.height <= view!.y + view!.height;
      })
      .toBe(true);
    const canvasBox = await canvas.boundingBox();
    if (device === "phone") {
      // The focused item is not hidden behind the picture, which stays in view above the lists.
      expect((await archive.boundingBox())!.y).toBeGreaterThanOrEqual(
        canvasBox!.y + canvasBox!.height
      );
    }
    await expectNoViolations(page, `${device}, an issue selected`);

    // Previous and Next step through what the screen reader said.
    const next = panel.getByRole("button", { name: "Next" });
    await next.focus();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await expect(panel.locator("[data-reader-count]")).toHaveText(`2 of ${located.announcements}`);
    await expect(readerItems.nth(1)).toHaveAttribute("aria-current", "true");

    // Each layer switches off and on from the keyboard, list and markers together.
    for (const layer of ["issues", "reader"] as const) {
      const toggle = panel.locator(`[data-layer-toggle="${layer}"]`);
      await toggle.focus();
      await page.keyboard.press("Space");
      await expect(panel.locator(`[data-layer="${layer}"]`).first()).toBeHidden();
    }
    await expectNoViolations(page, `${device}, both layers off`);
    await page.keyboard.press("Space");
    await expect(panel.locator('[data-layer="reader"]').first()).toBeVisible();
  });
}
