import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

import { ATTACHED_SCREENSHOT } from "@aee/ai-fixes";

import {
  createPortableVirtualScreenReader,
  sweepKeyboardAndPointer,
  type VirtualScreenReaderItem
} from "@aee/playwright";

import {
  contract,
  labFixtureModel,
  readerWalk,
  runOnLabPage,
  type LabPage
} from "./test-lab-helpers";
import { serveDirectory, startHtmlServer } from "./scenario-helpers";

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

const expectedSweepKinds = contract.issues.flatMap(({ sweepFinding }) =>
  sweepFinding ? [sweepFinding] : []
);
const expectedAxeRules = contract.issues.flatMap(({ axeRule }) => (axeRule ? [axeRule] : []));

// Over http, as the lab is published: a page opened from a file cannot send a request.
async function sweepFindings(page: Page, labPage: LabPage) {
  const server = await startHtmlServer(serveDirectory("site"));
  try {
    const result = await sweepKeyboardAndPointer({
      page,
      url: new URL(labPage.url, `${server.origin}/`).href,
      activateControls: true
    });
    return result.findings.map(({ kind }) => kind).sort();
  } finally {
    await server.close();
  }
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
  expect(await axeRules(page)).toEqual([...expectedAxeRules].sort());
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

test("aee run reports every issue the lab marks as found, and its status rows agree", async ({
  browser
}, testInfo) => {
  const { report, reportFiles, sweepFindings } = await runOnLabPage(
    browser,
    issuesPage,
    ["focus", "hover", "activate-page-controls"],
    testInfo,
    { readerCommands: readerWalk }
  );
  const { findings, status } = report.synthesis;
  expect(findings.map(({ ruleId }) => ruleId).sort()).toEqual(
    [...expectedAxeRules, ...expectedSweepKinds].sort()
  );
  expect(
    findings
      .filter(({ advisory }) => advisory)
      .map(({ ruleId }) => ruleId)
      .sort()
  ).toEqual([
    "colour-only",
    "empty-heading",
    "failure-not-announced",
    "status-not-announced",
    "text-in-image"
  ]);
  for (const finding of sweepFindings) {
    expect(finding.pattern?.url, finding.ruleId).toContain("/Elizabeth1979/a11y-skills/");
    expect(finding.checkpoints[0]?.sweepPath, finding.ruleId).toBeTruthy();
  }
  // The unnamed controls fail both rows: axe's rules and what the reader actually announced.
  const row = (id: string) => status.find((area) => area.id === id);
  expect(row("semantics")).toMatchObject({ verdict: "fail" });
  expect(row("reader")).toMatchObject({ verdict: "fail" });
  for (const unnamed of ["#project-search", "#help-link", "#archive-project"]) {
    expect(row("reader")?.detail).toContain(unnamed);
  }
  expect(report.synthesis.conclusion).not.toContain("virtual-reader commands passed");
  // With no model named, AI is allowed for the unnamed button but nothing is sent anywhere.
  const buttonName = findings.find(({ ruleId }) => ruleId === "button-name");
  expect(buttonName?.remediation.ai).toMatchObject({ used: false, status: "not-configured" });
  expect(buttonName?.remediation.ai.reason).toContain("AEE_LLM_PROVIDER=local");
  expect(report.ai.present).toBe(false);
  // The Keyboard access row carries the sweep's own recording.
  expect(await readFile(reportFiles.html, "utf8")).toContain("Keyboard sweep recording");
  expect(row("keyboard")).toMatchObject({ verdict: "fail" });
  expect(row("contrast")).toMatchObject({
    verdict: "fail",
    detail: expect.stringMatching(/^1 text element falls below/)
  });
  expect(report.verdict).toBe("fail");
});

test("an allowlisted AI specialist names the icon-only controls, labelled AI, without changing the verdict", async ({
  browser
}, testInfo) => {
  const model = labFixtureModel();
  const { report, reportFiles } = await runOnLabPage(browser, issuesPage, ["focus"], testInfo, {
    aiProvider: model.provider
  });
  const ai = (ruleId: string) =>
    report.synthesis.findings.find((finding) => finding.ruleId === ruleId)?.remediation.ai;
  expect(ai("button-name")).toMatchObject({
    used: true,
    status: "suggested",
    providerId: "lab-fixture",
    suggestions: [{ selector: "#archive-project", text: "Archive Project Alpha" }]
  });
  expect(ai("link-name")?.suggestions).toMatchObject([
    { selector: "#help-link", text: "Help with projects" }
  ]);
  expect(ai("image-alt")?.suggestions).toMatchObject([
    { selector: "#usage-chart", classification: "informative" }
  ]);
  // The sweep's colour-only and image-of-text findings get a reading of how they look, labelled.
  expect(ai("colour-only")?.suggestions).toMatchObject([
    { selector: "#storage-limit", label: "What the colour means", text: "Over the storage limit" }
  ]);
  expect(ai("text-in-image")?.suggestions).toMatchObject([
    {
      selector: "#upgrade-banner",
      label: "Words in the image",
      text: "Upgrade to Team for unlimited projects"
    }
  ]);
  // The search field is not icon-only, so the allowlist keeps it deterministic: no model call.
  expect(ai("label")).toMatchObject({ used: false, status: "available-if-needed" });
  expect(ai("label")?.notes?.join(" ")).toContain("not icon-only");
  const asked = (selector: string) =>
    model.requests.find(({ input }) => (input as { selector: string }).selector === selector);
  expect(model.requests).toHaveLength(5);
  expect(asked("#project-search")).toBeUndefined();
  // The model saw captured evidence only: the row the archive button sits in, and the element as
  // the page's screenshot shows it, cut close to its edges.
  expect(asked("#archive-project")?.input).toMatchObject({
    nearbyHeading: "Projects",
    nearbyText: "Project Alpha Website accessibility review",
    screenshot: ATTACHED_SCREENSHOT
  });
  const crops = [
    "#archive-project",
    "#help-link",
    "#usage-chart",
    "#storage-limit",
    "#upgrade-banner"
  ];
  for (const selector of crops) {
    expect(asked(selector)?.image?.mediaType, selector).toBe("image/png");
  }
  const cropOf = (selector: string) =>
    PNG.sync.read(Buffer.from(asked(selector)?.image?.base64 ?? "", "base64"));
  // A colour is judged against the item's neighbours, so its picture is the row around it; an
  // image's words are read from the image alone.
  expect(cropOf("#storage-limit").height).toBeGreaterThanOrEqual(240);
  expect(cropOf("#upgrade-banner").height).toBeLessThan(240);
  // Labelled as AI, and it changes nothing: the page still fails until a rerun passes.
  expect(report.ai).toMatchObject({
    present: true,
    label: expect.stringContaining("AI-generated suggestions: 5")
  });
  expect(report.verdict).toBe("fail");
  const html = await readFile(reportFiles.html, "utf8");
  expect(html).toContain(">AI suggestion<");
  expect(html).toContain("“Archive Project Alpha”");
  expect(html).toContain("Based on the text around it");
  expect(html).toContain("What the colour means: “Over the storage limit”");
});

test("aee run writes the demo page's findings as one pull-request comment", async ({
  browser
}, testInfo) => {
  const { reportFiles } = await runOnLabPage(
    browser,
    issuesPage,
    ["focus", "hover", "activate-page-controls"],
    testInfo,
    { readerCommands: readerWalk }
  );
  const comment = await readFile(reportFiles.prComment, "utf8");
  // The lab server's port changes every run; nothing else in the comment does.
  expect(comment.replace(/127\.0\.0\.1:\d+/, "127.0.0.1:PORT")).toMatchSnapshot(
    "demo-page-pr-comment.md"
  );
});

test("aee run finds nothing on the fixed page", async ({ browser }, testInfo) => {
  const { report, activated } = await runOnLabPage(
    browser,
    fixedPage,
    ["focus", "hover", "activate-page-controls"],
    testInfo,
    { readerCommands: readerWalk }
  );
  expect(activated.length).toBeGreaterThan(0);
  expect(report.synthesis.findings).toEqual([]);
  expect(report.synthesis.status.map(({ id, verdict }) => [id, verdict])).toEqual([
    ["keyboard", "pass"],
    ["reader", "pass"],
    ["semantics", "pass"],
    ["contrast", "pass"]
  ]);
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
  // Lost focus and the silent message are found by pressing Archive, and the silent failure by
  // pressing Sync, so without the permission none of them can be found.
  const foundByPressing = ["focus-lost", "status-not-announced", "failure-not-announced"];
  const withoutPressing = expectedSweepKinds.filter((kind) => !foundByPressing.includes(kind));
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
    // The logo in the heading has alt="", so only the chart is an image, and on the demo page the
    // banner drawn as an image of its words.
    expect(paths("image"), labPage.url).toEqual(
      labPage === contract.pages.fixed ? ["#usage-chart"] : ["#upgrade-banner", "#usage-chart"]
    );
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
