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

test("public demo lets keyboard users compare pass and fail evidence", async ({ page }) => {
  await page.goto(demoUrl);

  const focusFailure = page.getByRole("button", { name: "Focus remains behind" });
  await focusFailure.focus();
  await page.keyboard.press("Enter");

  await expect(focusFailure).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#verdict")).toHaveText("Fail");
  await expect(page.locator("#dom-changed")).toHaveText("Yes");
  await expect(page.locator("#after-focus")).toHaveText("button#delete-project");
  await expect(page.locator("#json-output")).toContainText('"verdict": "fail"');
});

test("public demo distinguishes static scanning, contextual repair, and behavioral evidence", async ({
  page
}) => {
  await page.goto(demoUrl);

  await expect(page.getByText("Button has no name")).toBeVisible();
  await expect(page.getByText("Focus stays behind")).toBeVisible();
  await expect(page.getByText("Focus enters dialog")).toBeVisible();
  await expect(page.getByRole("link", { name: "axe unnamed-button result" })).toHaveAttribute(
    "href",
    "demo-artifacts/axe-unnamed-icon.json"
  );
  await expect(page.getByRole("link", { name: "Reviewed AI label proposal" })).toHaveAttribute(
    "href",
    "demo-artifacts/ai-label-suggestion.json"
  );
  await expect(page.locator("video")).toHaveAttribute("controls", "");
  await expect(page.locator(".video-caption")).toContainText(
    "Press play to watch the complete story"
  );
  await expect(page.getByText("Read the recording transcript")).toBeVisible();

  const [issueReport, fixedReport] = await Promise.all(
    ["recorded-modal-focus-issue", "recorded-modal-focus-fixed"].map(async (runId) =>
      JSON.parse(
        await readFile(path.resolve(`site/demo-artifacts/${runId}/aee-report.json`), "utf8")
      )
    )
  );
  expect(issueReport.run.results).toEqual({ pass: 1, fail: 2, unknown: 0 });
  expect(fixedReport.run.results).toEqual({ pass: 3, fail: 0, unknown: 0 });

  const [axeUnnamed, axeNamed, axeOpenDialog, aiSuggestion] = await Promise.all(
    [
      "axe-unnamed-icon.json",
      "axe-named-icon.json",
      "axe-open-dialog.json",
      "ai-label-suggestion.json"
    ].map(async (fileName) =>
      JSON.parse(await readFile(path.resolve(`site/demo-artifacts/${fileName}`), "utf8"))
    )
  );
  expect(axeUnnamed.violations.some((violation) => violation.id === "button-name")).toBe(true);
  expect(axeNamed.violations).toEqual([]);
  expect(axeOpenDialog.violations).toEqual([]);
  expect(aiSuggestion.proposal.safety).toBe("review");
  expect(aiSuggestion.proposal.patches).toContain(
    '#delete-project: add aria-label="Delete Project Alpha"'
  );
  expect(aiSuggestion.verificationRequired).toBe(true);

  const duration = await page.locator("video").evaluate(async (element) => {
    const video = element as HTMLVideoElement;

    if (video.readyState < 1) {
      await new Promise<void>((resolve, reject) => {
        video.addEventListener("loadedmetadata", () => resolve(), { once: true });
        video.addEventListener("error", () => reject(new Error("Demo video failed to load.")), {
          once: true
        });
      });
    }

    return video.duration;
  });
  expect(duration).toBeGreaterThan(1);
  expect(duration).toBeLessThan(15);
});

test("public interaction moves focus inside the dialog", async ({ page }) => {
  await page.goto(demoUrl);

  await page.getByRole("button", { name: "Delete Project Alpha" }).click();

  await expect(page.getByRole("dialog", { name: "Delete Project Alpha?" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
});
