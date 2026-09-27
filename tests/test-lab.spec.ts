import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser, type Page, type TestInfo } from "@playwright/test";

import {
  createPortableVirtualScreenReader,
  SWEEP_FINDING_CONCEPTS,
  sweepKeyboardAndPointer,
  type VirtualScreenReaderItem
} from "@aee/playwright";

import { runApprovedScenario, serveDirectory, startHtmlServer } from "./scenario-helpers";

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

interface ScenarioReport {
  verdict: string;
  completeness: { status: string };
  artifacts: Array<{ kind: string; path: string }>;
  synthesis: {
    findings: Array<{
      ruleId: string;
      pattern?: { url: string };
      checkpoints: Array<{ sweepPath?: string }>;
    }>;
  };
}

const sweepKinds = new Set(Object.keys(SWEEP_FINDING_CONCEPTS));
const expectedSweepKinds = contract.issues.flatMap(({ sweepFinding }) =>
  sweepFinding ? [sweepFinding] : []
);

/** Runs `aee run` on a lab page over http, as a user would, and reads back its report. */
async function runOnLabPage(
  browser: Browser,
  labPage: LabPage,
  allowedActions: string[],
  testInfo: TestInfo
) {
  const server = await startHtmlServer(serveDirectory("site"));
  try {
    const result = await runApprovedScenario(
      browser,
      `schemaVersion: 0.1.0
id: test-lab
target:
  url: ${server.origin}/
standard:
  name: WCAG
  version: "2.2"
  levels: [A, AA]
profile: core
goal: Find every issue the lab page is known to have.
journeys:
  - id: lab-page
    name: ${JSON.stringify(labPage.title)}
    goal: Read and operate the page.
    startPath: ${JSON.stringify(`/${labPage.url}`)}
    allowedActions: [${allowedActions.join(", ")}]
    forbiddenActions: [submit-forms]
    virtualScreenReaderCommands: [start]
approval:
  required: true
`,
      testInfo
    );
    const report = JSON.parse(await readFile(result.reportFiles.json, "utf8")) as ScenarioReport;
    const sweepArtifact = report.artifacts.find(({ kind }) => kind === "keyboard-pointer-sweep");
    const sweep = JSON.parse(
      await readFile(path.join(result.outputDir, sweepArtifact!.path), "utf8")
    ) as { activated: string[] };
    return {
      report,
      activated: sweep.activated,
      sweepFindings: report.synthesis.findings.filter(({ ruleId }) => sweepKinds.has(ruleId))
    };
  } finally {
    await server.close();
  }
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
  expect(await sweepFindings(page, issuesPage)).toEqual([...expectedSweepKinds].sort());
});

test("the keyboard and pointer sweep finds nothing on the fixed page", async ({ page }) => {
  expect(await sweepFindings(page, fixedPage)).toEqual([]);
});

test("aee run reports the demo page's keyboard issues, each with its fix pattern and evidence", async ({
  browser
}, testInfo) => {
  const { report, sweepFindings } = await runOnLabPage(
    browser,
    issuesPage,
    ["focus", "hover", "activate-page-controls"],
    testInfo
  );
  expect(sweepFindings.map(({ ruleId }) => ruleId).sort()).toEqual([...expectedSweepKinds].sort());
  for (const finding of sweepFindings) {
    expect(finding.pattern?.url, finding.ruleId).toContain("/Elizabeth1979/a11y-skills/");
    expect(finding.checkpoints[0]?.sweepPath, finding.ruleId).toBeTruthy();
  }
  expect(report.verdict).toBe("fail");
});

test("aee run finds nothing on the fixed page", async ({ browser }, testInfo) => {
  const { report, activated } = await runOnLabPage(
    browser,
    fixedPage,
    ["focus", "hover", "activate-page-controls"],
    testInfo
  );
  expect(activated.length).toBeGreaterThan(0);
  expect(report.synthesis.findings).toEqual([]);
  expect(report).toMatchObject({ verdict: "pass", completeness: { status: "complete" } });
});

test("aee run presses no control unless the journey allows activate-page-controls", async ({
  browser
}, testInfo) => {
  const { activated, sweepFindings } = await runOnLabPage(
    browser,
    issuesPage,
    ["focus", "hover"],
    testInfo
  );
  // Lost focus is found by pressing Archive, so without the permission it cannot be found.
  const withoutPressing = expectedSweepKinds.filter((kind) => kind !== "focus-lost");
  expect(activated).toEqual([]);
  expect(sweepFindings.map(({ ruleId }) => ruleId).sort()).toEqual(withoutPressing.sort());
});

test("the portable reader announces the demo page's markup as HTML-AAM maps it", async ({
  page
}) => {
  for (const labPage of Object.values(contract.pages)) {
    await open(page, labPage);
    const reader = createPortableVirtualScreenReader(page);
    const items: VirtualScreenReaderItem[] = [];
    for (let entry = await reader.command("start"); entry.item;) {
      items.push(entry.item);
      entry = await reader.command("next-item");
    }
    const paths = (role: string) =>
      items.filter((item) => item.role === role).map(({ nodePath }) => nodePath);

    // Only the page's own header is a banner; the project card's <header> is inside an <article>.
    expect(paths("banner"), labPage.url).toEqual(["html > body > header"]);
    // The logo in the heading has alt="", so only the chart is an image.
    expect(paths("image"), labPage.url).toEqual(["#usage-chart"]);
    // The breadcrumb's current page is an <a> without href: read as text, not as a link.
    expect(paths("link"), labPage.url).not.toContain(
      "html > body > main > nav > ol > li:nth-of-type(2) > a"
    );
    expect(items, labPage.url).toContainEqual(
      expect.objectContaining({ role: "listitem", text: "Workspace overview" })
    );
    // The search form has no name, so it is not a form landmark.
    expect(paths("form"), labPage.url).toEqual([]);
  }
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
