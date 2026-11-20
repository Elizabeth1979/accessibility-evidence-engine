import { execFileSync } from "node:child_process";
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

import { issuePageUrl } from "../scripts/test-lab-contract.mjs";
import {
  contract,
  labFixtureModel,
  readerWalk,
  runOnLabPage,
  type LabHeading,
  type LabPage
} from "./test-lab-helpers";
import { serveDirectory, startHtmlServer } from "./scenario-helpers";

const site = pathToFileURL(path.resolve("site") + path.sep).href;
const { issues: issuesPage, fixed: fixedPage } = contract.pages;

test.beforeAll(() => {
  execFileSync(process.execPath, ["scripts/generate-test-lab.mjs"]);
});

async function open(page: Page, labPage: LabPage) {
  await page.goto(new URL(labPage.url, site).href);
}

async function axeViolations(page: Page) {
  return (await new AxeBuilder({ page }).analyze()).violations;
}

async function axeRules(page: Page) {
  return (await axeViolations(page)).map(({ id }) => id).sort();
}

// The headings in the accessibility tree, in page order, each with its level and accessible name.
// An aria snapshot with a name of "" matches any name, so the name is checked on its own.
async function expectHeadingOutline(page: Page, outline: LabHeading[]) {
  const headings = page.getByRole("heading");
  await expect(headings).toHaveCount(outline.length);
  for (const [index, { level, name }] of outline.entries()) {
    const heading = headings.nth(index);
    await expect(heading).toMatchAriaSnapshot(`- heading [level=${level}]`);
    await expect(heading).toHaveAccessibleName(name);
  }
}

test("the heading outline is what a screen reader lists, not the heading tags", async ({
  page
}) => {
  // A box with the heading role is a heading; a heading hidden from screen readers, or with its
  // role removed, is not one.
  await page.setContent(`
    <h1>Workspace overview</h1>
    <div role="heading" aria-level="2">Projects</div>
    <h2 aria-hidden="true">Archived projects</h2>
    <h3 role="presentation">Notes</h3>
    <h2></h2>`);
  await expectHeadingOutline(page, [
    { level: 1, name: "Workspace overview" },
    { level: 2, name: "Projects" },
    { level: 2, name: "" }
  ]);
});

const expectedSweepKinds = contract.issues.flatMap(({ sweepFinding }) =>
  sweepFinding ? [sweepFinding] : []
);
const expectedAxeRules = contract.issues.flatMap(({ axeRule }) => (axeRule ? [axeRule] : []));

// Over http, as the lab is published: a page opened from a file cannot send a request.
async function sweep(page: Page, url: string) {
  const server = await startHtmlServer(serveDirectory("site"));
  try {
    const result = await sweepKeyboardAndPointer({
      page,
      url: new URL(url, `${server.origin}/`).href,
      activateControls: true
    });
    return result.findings;
  } finally {
    await server.close();
  }
}

async function sweepFindings(page: Page, labPage: LabPage) {
  return (await sweep(page, labPage.url)).map(({ kind }) => kind).sort();
}

test("every issue has its own page, with only its own mutation and its expected element", async ({
  page
}) => {
  for (const issue of contract.issues) {
    await page.goto(new URL(issuePageUrl(contract, issue), site).href);
    await expect(page.locator("body"), issue.id).toHaveAttribute("data-defects", issue.id);
    await expect(page.locator("#case-name")).toHaveText("With one deliberate accessibility issue");
    await expect(page.locator(issue.expected.ownPage.element), issue.id).toHaveCount(1);
  }
  // A case that passes on the fixed page points at an element there; an inapplicable one has none.
  await open(page, fixedPage);
  for (const { id, expected } of contract.issues) {
    if (expected.fixedPage.outcome === "passed") {
      await expect(page.locator(expected.fixedPage.element), id).toHaveCount(1);
    }
  }
});

test("a case the page does not know is refused, not shown as the fixed page", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", ({ message }) => errors.push(message));
  await page.goto(new URL("test-case.html?case=no-such-issue", site).href);
  await expect(page.locator("#case-name")).toHaveText("Unknown case “no-such-issue”");
  await expect(page.locator("body")).not.toHaveAttribute("data-defects");
  expect(errors).toEqual(['test-case.html has no case "no-such-issue"']);
});

// Each issue alone: its check finds it at the element the contract names, and nothing else on the
// page is found. A check may find it more than once, as the silent status message is found once
// for each control whose message it hides; each is the same bug at the same element. An issue AEE
// has no check for yet is found by nothing: a miss, still counted as one, since its expected
// outcome is "failed" whatever the judges say.
for (const issue of contract.issues) {
  test(`on its own page, ${issue.id} is found only where the contract says`, async ({ page }) => {
    const url = issuePageUrl(contract, issue);
    const found = (await sweep(page, url)).map(({ kind, selector }) => ({ by: kind, selector }));
    await page.goto(new URL(url, site).href);
    for (const { id, nodes } of await axeViolations(page)) {
      found.push(...nodes.map(({ target }) => ({ by: id, selector: target.join(" ") })));
    }
    const check = issue.axeRule ?? issue.sweepFinding;
    expect([...new Set(found.map(({ by }) => by))], issue.id).toEqual(check ? [check] : []);
    if (!check) {
      test.info().annotations.push({
        type: "missed",
        description: `${issue.id} has no check yet (planned in ${issue.plannedStep})`
      });
    }
    // The same element, however the judge writes its selector.
    for (const { selector } of found) {
      const sameElement = await page.evaluate(
        ([foundSelector, expectedSelector]) => {
          const expected = document.querySelector(expectedSelector);
          return expected !== null && document.querySelector(foundSelector) === expected;
        },
        [selector, issue.expected.ownPage.element]
      );
      expect(sameElement, `${issue.id}: found at ${selector}`).toBe(true);
    }
  });
}

test("the demo page shows exactly the issues' axe rules", async ({ page }) => {
  await open(page, issuesPage);
  expect(await axeRules(page)).toEqual([...expectedAxeRules].sort());
  await expectHeadingOutline(page, issuesPage.headingOutline);
  const defects = await page.locator("body").getAttribute("data-defects");
  expect(defects?.split(" ").sort()).toEqual(contract.issues.map(({ id }) => id).sort());
});

test("the fixed page has no axe findings", async ({ page }) => {
  await open(page, fixedPage);
  expect(await axeRules(page)).toEqual([]);
  await expectHeadingOutline(page, fixedPage.headingOutline);
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
    // The reader says where an element begins and where it ends, so each element is listed once.
    const paths = (role: string) => [
      ...new Set(items.filter((item) => item.role === role).map(({ nodePath }) => nodePath))
    ];

    // Only the page's own header is a banner; the project card's <header> is inside an <article>.
    expect(paths("banner"), labPage.url).toEqual([".site-header"]);
    // The logo in the heading has alt="", so only the chart is an image, and on the demo page the
    // banner drawn as an image of its words.
    expect(paths("image"), labPage.url).toEqual(
      labPage === contract.pages.fixed ? ["#usage-chart"] : ["#upgrade-banner", "#usage-chart"]
    );
    // The breadcrumb's current page is an <a> without href: read as text, not as a link.
    expect(paths("link"), labPage.url).not.toContain('a[aria-current="page"]');
    expect(items, labPage.url).toContainEqual(
      expect.objectContaining({
        role: "text",
        text: "Workspace overview",
        nodePath: 'a[aria-current="page"]'
      })
    );
    // HTML-AAM makes an unnamed form no landmark, and screen readers do not announce one. Guidepup's
    // reader says "form" for it: reported upstream as guidepup/virtual-screen-reader#253, to fix there
    // rather than around it here.
  }
});

test("the portable reader reads text in plain boxes, as screen readers do", async ({ page }) => {
  for (const labPage of Object.values(contract.pages)) {
    await open(page, labPage);
    const reader = createPortableVirtualScreenReader(page);
    const items: VirtualScreenReaderItem[] = [];
    for (let entry = await reader.command("start"); entry.item;) {
      items.push(entry.item);
      entry = await reader.command("next-item");
    }
    const texts = items.filter(({ role }) => role === "text").map(({ text }) => text);

    // Bold titles in plain boxes and a field's visible label: in the tree, so read, without a role.
    expect(texts, labPage.url).toEqual(
      expect.arrayContaining(["Search projects", "Project Alpha", "Weekly digest"])
    );
    // On the demo page "Export report" is a box styled as a button: its words are all a screen
    // reader can say. On the fixed page it is a button, so it is not read again as text.
    expect(texts.includes("Export report"), labPage.url).toBe(labPage !== contract.pages.fixed);
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
