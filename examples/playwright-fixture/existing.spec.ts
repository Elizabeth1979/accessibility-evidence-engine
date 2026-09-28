// An ordinary Playwright spec. To check every page it loads with AEE, change its import from
// "@playwright/test" to "@aee/cli/test" and nothing else; tests/test-fixture.spec.ts does exactly
// that and reads the report it writes.
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "@playwright/test";

const demoPage = pathToFileURL(path.resolve("site/test-case.html")).href;

test("the demo page lists the project and its plan", async ({ page }) => {
  await page.goto(demoPage);

  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.getByText("Project Alpha", { exact: true })).toBeVisible();
});
