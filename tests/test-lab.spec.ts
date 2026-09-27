import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import { sweepKeyboardAndPointer } from "@aee/playwright";

interface LabPage {
  title: string;
  url: string;
  headingOutline: string[];
}

interface LabIssue {
  id: string;
  concept: string;
  axeRule?: string;
  sweepFinding?: string;
  plannedStep?: string;
}

// The contract is the known answer: the demo page must show exactly its issues' axe rules and
// sweep findings, and the fixed page none. The lab page is generated from the same file.
const contract = JSON.parse(readFileSync("site/test-lab-contract.json", "utf8")) as {
  pages: { issues: LabPage; fixed: LabPage };
  issues: LabIssue[];
};
const registry = JSON.parse(
  readFileSync("packages/schemas/json/remediation-registry.json", "utf8")
) as { entries: Array<{ id: string }> };
const site = pathToFileURL(path.resolve("site") + path.sep).href;
const { issues: issuesPage, fixed: fixedPage } = contract.pages;

test.beforeAll(() => {
  execFileSync(process.execPath, ["scripts/generate-test-lab.mjs"]);
});

async function open(page: Page, labPage: LabPage) {
  await page.goto(new URL(labPage.url, site).href);
}

async function axeRules(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations.map(({ id }) => id).sort();
}

async function headingOutline(page: Page) {
  return page.locator("h1,h2,h3,h4,h5,h6").evaluateAll((nodes) => nodes.map((n) => n.tagName));
}

async function sweepFindings(page: Page, labPage: LabPage) {
  const result = await sweepKeyboardAndPointer({
    page,
    url: new URL(labPage.url, site).href,
    activateControls: true
  });
  return result.findings.map(({ kind }) => kind).sort();
}

test("every issue belongs to a registry concept and has exactly one way it is found", () => {
  const concepts = new Set(registry.entries.map(({ id }) => id));
  for (const issue of contract.issues) {
    expect(concepts, issue.id).toContain(issue.concept);
    const ways = [issue.axeRule, issue.sweepFinding, issue.plannedStep].filter(Boolean);
    expect(ways, issue.id).toHaveLength(1);
  }
});

test("the demo page shows exactly the issues' axe rules", async ({ page }) => {
  await open(page, issuesPage);
  const expected = contract.issues.flatMap(({ axeRule }) => (axeRule ? [axeRule] : [])).sort();
  expect(await axeRules(page)).toEqual(expected);
  expect(await headingOutline(page)).toEqual(issuesPage.headingOutline);
  const defects = await page.locator("body").getAttribute("data-defects");
  expect(defects?.split(" ").sort()).toEqual(contract.issues.map(({ id }) => id).sort());
});

test("the fixed page has no axe findings", async ({ page }) => {
  await open(page, fixedPage);
  expect(await axeRules(page)).toEqual([]);
  expect(await headingOutline(page)).toEqual(fixedPage.headingOutline);
  await expect(page.locator("body")).toHaveAttribute("data-defects", "");
});

test("the fixed page works by keyboard and resets on reload", async ({ page }) => {
  await open(page, fixedPage);
  await page.locator("#archive-project").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#restore-project")).toBeFocused();
  await expect(page.locator("#project-alpha")).toBeHidden();
  await page.keyboard.press("Enter");
  await expect(page.locator("#archive-project")).toBeFocused();
  await page.locator("#export-report").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#action-status")).toHaveText("Report exported.");
  await page.locator("#plan-details summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#plan-details p")).toBeVisible();
  await page.locator("#toggle-digest").focus();
  await page.keyboard.press("Space");
  await expect(page.locator("#digest-state")).toHaveText("Disabled");
  await page.reload();
  await expect(page.locator("#digest-state")).toHaveText("Enabled");
});

test("the keyboard and pointer sweep finds exactly the demo page's keyboard issues", async ({
  page
}) => {
  const expected = contract.issues.flatMap(({ sweepFinding }) =>
    sweepFinding ? [sweepFinding] : []
  );
  expect(await sweepFindings(page, issuesPage)).toEqual(expected.sort());
});

test("the keyboard and pointer sweep finds nothing on the fixed page", async ({ page }) => {
  expect(await sweepFindings(page, fixedPage)).toEqual([]);
});

test("the lab page lists both pages and every issue, and fits desktop and phone", async ({
  page
}) => {
  const lab = new URL("test-lab.html", site).href;
  await page.goto(lab);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  for (const { url } of Object.values(contract.pages)) {
    await expect(page.locator(`.lab-pages a[href="${url}"]`)).toHaveCount(1);
  }
  await expect(page.locator("tbody tr")).toHaveCount(contract.issues.length);
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const url of [
      lab,
      ...Object.values(contract.pages).map((p) => new URL(p.url, site).href)
    ]) {
      await page.goto(url);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true
      );
    }
  }
});
