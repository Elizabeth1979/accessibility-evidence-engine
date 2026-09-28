import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { marked } from "marked";

import { contract, labFixtureModel, readerWalk, runOnLabPage } from "./test-lab-helpers";

let reportUrl: string;
let csv: string;
let fixes: number;

test.beforeAll(async ({ browser }, testInfo) => {
  const run = await runOnLabPage(browser, contract.pages.issues, ["focus", "hover"], testInfo, {
    readerCommands: readerWalk,
    aiProvider: labFixtureModel().provider
  });
  reportUrl = `${pathToFileURL(run.reportFiles.html).href}#panel-findings`;
  csv = await readFile(path.join(run.outputDir, "aee-fixes.csv"), "utf8");
  fixes = run.report.synthesis.findings.length;
});

/** RFC 4180: rows end with CRLF outside quotes, and "" is a quote inside a quoted cell. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted && char === '"' && text[index + 1] === '"') {
      cell += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (!quoted && char === ",") {
      row.push(cell);
      cell = "";
    } else if (!quoted && char === "\r" && text[index + 1] === "\n") {
      rows.push([...row, cell]);
      row = [];
      cell = "";
      index += 1;
    } else cell += char;
  }
  return rows;
}

test("the CSV of all fixes opens with one row per fix and every field", () => {
  const [header, ...rows] = parseCsv(csv);
  expect(rows).toHaveLength(fixes);
  expect(header).toEqual([
    "Title",
    "Severity",
    "WCAG",
    "Rule",
    "Rule link",
    "How to build it",
    "Page",
    "Elements",
    "Page state",
    "Steps to reproduce",
    "Expected",
    "Actual",
    "Suggested fix",
    "AI suggestion, review before use",
    "Affected elements",
    "Evidence"
  ]);
  for (const row of rows) expect(row).toHaveLength(header!.length);
  const button = rows.find((row) => row[3] === "button-name")!;
  expect(button[2]).toContain("4.1.2 Name, Role, Value (A)");
  expect(button[11]).toBe('The virtual screen reader announced "button" at #archive-project.');
});

test("a ticket copied by keyboard, pasted as GitHub-flavoured Markdown, shows every field", async ({
  page,
  context
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto(reportUrl);
  const row = page.locator("#review-button-name");
  await row.getByRole("button", { name: "Copy as ticket" }).focus();
  await page.keyboard.press("Enter");
  await expect(row.getByRole("status")).toHaveText(/Ticket copied/);
  const ticket = await page.evaluate(() => navigator.clipboard.readText());

  const rendered = await marked.parse(ticket, { gfm: true });
  expect(rendered).toMatch(/^<h3>Buttons must have discernible text: Archive project<\/h3>/);
  for (const field of [
    "Severity",
    "WCAG",
    "Rule",
    "How to build it",
    "Where",
    "Steps to reproduce",
    "Expected",
    "Actual",
    "Suggested fix",
    "AI suggestion, review before use",
    "Affected elements",
    "Evidence"
  ]) {
    expect(rendered, field).toContain(`<strong>${field}:</strong>`);
  }
  // The steps are a numbered list, and page text never turns into markup.
  expect(rendered).toMatch(/<ol>\s*<li>Open /);
  expect(rendered).toContain("patterns/buttons.instructions.md");
  expect(rendered).not.toContain("<label>");
});

test("where copying is blocked, the ticket text is shown and selected instead", async ({
  page
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("blocked")) }
    });
  });
  await page.goto(reportUrl);
  const row = page.locator("#review-button-name");
  await row.getByRole("button", { name: "Copy as ticket" }).click();
  await expect(row.getByRole("status")).toHaveText(/Copying is blocked here/);
  const text = row.getByRole("textbox", { name: /Ticket for/ });
  await expect(text).toBeFocused();
  expect(await text.evaluate((area: HTMLTextAreaElement) => area.selectionEnd)).toBe(
    (await text.inputValue()).length
  );
});

for (const [device, width] of [
  ["desktop", 1280],
  ["phone", 390]
] as const) {
  test(`Fix review with a ticket open has no axe violations on ${device}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(reportUrl);
    await page.locator("#review-button-name .ticket-text summary").click();
    await expect(page.locator("#review-button-name .ticket-text textarea")).toBeVisible();
    await expect(page.getByRole("link", { name: "Download all fixes as CSV" })).toBeVisible();
    const result = await new AxeBuilder({ page }).include("#panel-findings").analyze();
    expect(result.violations).toEqual([]);
  });
}
