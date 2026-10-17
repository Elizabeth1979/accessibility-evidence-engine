import { readFile } from "node:fs/promises";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

import { imageRoleFromTree } from "@aee/ai-fixes";
import {
  describeElementContexts,
  runAeeOnPage,
  sweepKeyboardAndPointer,
  withPageSessions
} from "@aee/playwright";

// Each example is one the home-grown-code audit found AEE reading wrong from the markup. The
// expected answers are what Chrome's accessibility tree gives NVDA and JAWS.

interface FocusReport {
  records: Array<{ observerId: string; phase?: string; meta?: { focusTarget?: unknown } }>;
  judgments: Array<{ judgeId: string; verdict: string }>;
}

/** Focuses `selector` as the interaction, and returns the report and the focus captured after. */
async function focusAndReport(
  page: Page,
  testInfo: TestInfo,
  selector: string,
  interaction: Parameters<typeof runAeeOnPage>[0]["interaction"]
) {
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: testInfo.outputPath("focus-output"),
    observers: ["focus"],
    judges: ["focus-management"],
    checkpointName: "tree-focus",
    interaction,
    async performInteraction() {
      await page.focus(selector);
    }
  });
  const reportPath = result.reporterFiles.find((file) => file.endsWith("aee-report.json"))!;
  const report = JSON.parse(await readFile(reportPath, "utf8")) as FocusReport;
  const after = report.records.find(
    ({ observerId, phase }) => observerId === "focus" && phase === "after"
  );
  return { report, focusTarget: after?.meta?.focusTarget };
}

test("a field labelled by <label for> is named by its label, not its form name", async ({
  page
}, testInfo) => {
  await page.setContent(
    `<button id="start">Start</button><label for="q">Search</label><input id="q" name="q">`
  );
  await page.focus("#start");

  const { report, focusTarget } = await focusAndReport(page, testInfo, "#q", {
    kind: "focus",
    actor: "test",
    target: { role: "textbox", name: "Search" },
    meta: { focusExpectation: "target" }
  });

  expect(focusTarget).toEqual(
    expect.objectContaining({
      id: "q",
      role: "textbox",
      name: "Search",
      accessibilityFocus: expect.objectContaining({
        status: "matched",
        role: "textbox",
        name: "Search"
      })
    })
  );
  expect(report.judgments).toEqual([
    expect.objectContaining({ judgeId: "focus-management", verdict: "pass" })
  ]);
});

test("an unlabelled dialog has no name, though it has text", async ({ page }, testInfo) => {
  await page.setContent(`
    <button id="start">Start</button>
    <div id="confirm" role="dialog"><p>Your changes will be lost.</p><button id="ok">OK</button></div>
  `);
  await page.focus("#start");

  const { focusTarget } = await focusAndReport(page, testInfo, "#ok", {
    kind: "focus",
    actor: "test"
  });

  expect(focusTarget).toEqual(
    expect.objectContaining({
      role: "button",
      name: "OK",
      dialogContext: { tagName: "div", id: "confirm", role: "dialog", name: "", modal: false }
    })
  );
});

test("a modal <dialog> opened with showModal() is modal, and named by aria-labelledby", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <button id="start">Start</button>
    <dialog id="settings" aria-labelledby="title"><h2 id="title">Settings</h2><button id="close">Close</button></dialog>
  `);
  await page.evaluate(() => (document.querySelector("#settings") as HTMLDialogElement).showModal());

  const { focusTarget } = await focusAndReport(page, testInfo, "#close", {
    kind: "focus",
    actor: "test"
  });

  expect(focusTarget).toEqual(
    expect.objectContaining({
      dialogContext: {
        tagName: "dialog",
        id: "settings",
        role: "dialog",
        name: "Settings",
        modal: true
      }
    })
  );
});

test("a native radio button is checked, and sits in its radio group, as the tree has them", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <button id="start">Start</button>
    <div role="radiogroup" aria-label="Size">
      <input type="radio" name="size" id="small" aria-label="Small">
      <input type="radio" name="size" id="large" aria-label="Large" checked>
    </div>
  `);
  await page.focus("#start");

  const { focusTarget } = await focusAndReport(page, testInfo, "#large", {
    kind: "focus",
    actor: "test"
  });

  expect(focusTarget).toEqual(
    expect.objectContaining({
      role: "radio",
      name: "Large",
      checked: true,
      compositeRole: "radiogroup",
      compositeItemIndex: 1,
      compositeItemCount: 2
    })
  );
});

test("focus inside a same-origin frame is found in the accessibility tree", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <button id="before">Before</button>
    <iframe id="payment-frame" srcdoc='<button id="inside">Review invoice</button>'></iframe>
  `);
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
  await frame.locator("#inside").waitFor();
  await page.focus("#before");

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: testInfo.outputPath("frame-output"),
    observers: ["focus"],
    judges: ["release"],
    checkpointName: "frame-focus",
    interaction: { kind: "focus", actor: "test" },
    async performInteraction() {
      await frame.focus("#inside");
    }
  });
  const reportPath = result.reporterFiles.find((file) => file.endsWith("aee-report.json"))!;
  const report = JSON.parse(await readFile(reportPath, "utf8")) as FocusReport;
  const after = report.records.find(
    ({ observerId, phase }) => observerId === "focus" && phase === "after"
  );

  expect(after?.meta?.focusTarget).toEqual(
    expect.objectContaining({
      role: "button",
      name: "Review invoice",
      documentActiveElement: expect.objectContaining({ id: "payment-frame", role: "Iframe" }),
      accessibilityFocus: expect.objectContaining({ status: "matched", name: "Review invoice" })
    })
  );
});

test("the sweep names mouse-only controls as a screen reader does", async ({ page }) => {
  const url = `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head><title>Names</title></head>
  <body>
    <main>
      <h1>Names</h1>
      <input type="submit" value="Save" tabindex="-1" style="cursor: pointer">
      <span id="archive-label">Archive</span>
      <button aria-labelledby="archive-label" tabindex="-1" style="cursor: pointer"></button>
      <a href="#home" tabindex="-1"><img alt="Home" width="16" height="16" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>
      <div onclick="void 0" style="cursor: pointer">Open menu</div>
    </main>
  </body>
</html>`)}`;

  const result = await sweepKeyboardAndPointer({ page, url, activateControls: false });

  const pointerOnly = result.findings.filter(({ kind }) => kind === "pointer-only");
  expect(pointerOnly.map(({ label }) => label).sort()).toEqual(["", "Archive", "Home", "Save"]);
  // A generic element with a click handler is no control to a screen reader, so it has no name;
  // the text it shows is kept to tell which one it is. A named control keeps no such text.
  expect(pointerOnly.find(({ label }) => label === "")?.text).toBe("Open menu");
  expect(pointerOnly.filter(({ text }) => text !== undefined)).toHaveLength(1);
});

test("an image with alt='' and aria-label is not decorative, as WAI-ARIA's conflict rule says", async ({
  page
}) => {
  await page.setContent(`
    <section>
      <h2>Not this section</h2>
    </section>
    <section>
      <h2 role="presentation">Styled like a heading</h2>
      <div role="heading" aria-level="2">Quarterly results</div>
      <img id="chart" alt="" aria-label="Revenue chart" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <img id="spacer" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <div aria-hidden="true"><img id="hidden" alt="Logo" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></div>
      <p>Revenue rose. <img id="inline" alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></p>
    </section>
  `);

  const [chart, spacer, hidden, inline] = await withPageSessions(page.context(), page, (sessions) =>
    describeElementContexts(page, sessions, ["#chart", "#spacer", "#hidden", "#inline"])
  );
  // The full tree leaves some ignored images out, as one inside a paragraph; the heading above
  // a decorative image is found all the same.
  for (const decorative of [spacer, hidden, inline]) {
    expect(decorative?.nearbyHeading).toBe("Quarterly results");
  }
  expect(inline?.ignoredReasons).toEqual(["emptyAlt"]);

  expect(chart).toEqual(
    expect.objectContaining({
      role: "image",
      name: "Revenue chart",
      ignoredReasons: [],
      nearbyHeading: "Quarterly results",
      image: expect.objectContaining({ alt: "" })
    })
  );
  expect(imageRoleFromTree({ ignoredReasons: chart!.ignoredReasons })).toBeUndefined();
  expect(spacer?.ignoredReasons).toEqual(["emptyAlt"]);
  expect(imageRoleFromTree({ ignoredReasons: spacer!.ignoredReasons })).toBe("decorative");
  expect(hidden?.ignoredReasons).toEqual(["ariaHiddenSubtree"]);
  expect(imageRoleFromTree({ ignoredReasons: hidden!.ignoredReasons })).toBe("decorative");
});
