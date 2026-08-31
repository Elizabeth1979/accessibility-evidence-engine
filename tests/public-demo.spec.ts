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

  const missingResponse = page.getByRole("button", { name: "Missing response" });
  await missingResponse.focus();
  await page.keyboard.press("Enter");

  await expect(missingResponse).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#verdict")).toHaveText("Fail");
  await expect(page.locator("#dom-changed")).toHaveText("No");
  await expect(page.locator("#json-output")).toContainText('"verdict": "fail"');
});

test("public demo shows a real failure, fix, and verified rerun", async ({ page }) => {
  await page.goto(demoUrl);

  await expect(page.getByText("Enter does nothing")).toBeVisible();
  await expect(page.getByText("Response observed")).toBeVisible();
  await expect(page.getByRole("link", { name: "Failing Markdown report" })).toHaveAttribute(
    "href",
    "demo-artifacts/recorded-keyboard-save-issue/aee-report.md"
  );
  await expect(page.getByRole("link", { name: "Fixed JSON report" })).toHaveAttribute(
    "href",
    "demo-artifacts/recorded-keyboard-save-fixed/aee-report.json"
  );
  await expect(page.locator("video")).toHaveAttribute("controls", "");
  await expect(page.getByText("Press play to watch the complete story.")).toBeVisible();
  await expect(page.getByText("Read the recording transcript")).toBeVisible();

  const [issueReport, fixedReport] = await Promise.all(
    ["recorded-keyboard-save-issue", "recorded-keyboard-save-fixed"].map(async (runId) =>
      JSON.parse(
        await readFile(path.resolve(`site/demo-artifacts/${runId}/aee-report.json`), "utf8")
      )
    )
  );
  expect(issueReport.run.results).toEqual({ pass: 0, fail: 3, unknown: 0 });
  expect(fixedReport.run.results).toEqual({ pass: 3, fail: 0, unknown: 0 });

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
  expect(duration).toBeLessThan(10);
});
