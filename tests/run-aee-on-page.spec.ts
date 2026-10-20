import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Browser } from "@playwright/test";
import { PNG } from "pngjs";

import {
  announcedWithoutName,
  captureElementMap,
  createLaneCaptures,
  createPortableVirtualScreenReader,
  runInputComparison,
  runAeeOnPage,
  runStartPageLane,
  runVirtualScreenReaderLane,
  withPageSessions
} from "@aee/playwright";
import { validateSchema } from "@aee/schemas";

import { runApprovedScenario, startHtmlServer } from "./scenario-helpers";

test("executeScenario integrates an approved real-page lane into one complete report", async ({
  browser,
  page
}, testInfo) => {
  const server = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="en"><head><title>Example</title></head><body>
      <header><a href="/sign-in">Sign in</a></header>
      <main><h1>Account overview</h1><p>Review public information.</p></main>
      <footer><a href="/help" role="menuitem" style="color:#aaa;background:#fff;font-size:14px">Help</a></footer>
    </body></html>`);
  });
  const scenarioYaml = `schemaVersion: 0.1.0
id: local-public-page
target:
  url: ${server.origin}/
  allowedOrigins:
    - ${server.origin}
standard:
  name: WCAG
  version: "2.2"
  levels: [A, AA]
profile: core
goal: Read the public page heading.
journeys:
  - id: read-public-page
    name: Read public page
    goal: Find the primary heading.
    startPath: /
    allowedActions: [navigate, hover, focus]
    forbiddenActions: [submit]
    virtualScreenReaderCommands: [next-heading]
    interactionComparisons:
      - id: sign-in-hover-focus
        name: Sign in remains available with pointer and keyboard
        pointerActions:
          - id: hover-sign-in
            kind: hover
            target: { role: link, name: Sign in }
        keyboardActions:
          - id: focus-sign-in
            kind: focus
            target: { role: link, name: Sign in }
        observe:
          target: { role: link, name: Sign in }
          url: true
          visible: true
          text: true
        expected:
          visible: true
          text: Sign in
privacy:
  storage: local
  remoteUpload: forbidden
  sharingReviewRequired: true
approval:
  required: true
`;

  try {
    const result = await runApprovedScenario(browser, scenarioYaml, testInfo);
    const report = JSON.parse(await readFile(result.reportFiles.json, "utf8")) as {
      status: string;
      completeness: { status: string; plannedLanes: number; completedLanes: number };
      summary: { actions: number; artifacts: number };
      ai: { present: boolean };
      synthesis: {
        directJudgments: { passed: number; failed: number; unknown: number };
        comparisons: Array<{
          equivalence: { verdict: string };
          expectation: { verdict: string };
        }>;
        reader: { commands: number; passed: number };
        findings: Array<{
          ruleId: string;
          checkpointCount: number;
          checkpoints: Array<{
            domPath?: string;
            accessibilityTreePath?: string;
            screenshotPath?: string;
          }>;
          remediation: { ai: { used: boolean } };
        }>;
      };
    };
    const html = await readFile(result.reportFiles.html, "utf8");

    expect(report.status).toBe("completed");
    expect(report.completeness).toMatchObject({
      status: "complete",
      plannedLanes: 5,
      completedLanes: 5
    });
    // The start page's own checkpoint, the reader command and the two comparison actions.
    expect(report.summary.actions).toBe(4);
    expect(report.summary.artifacts).toBeGreaterThan(0);
    expect(report.ai.present).toBe(false);
    expect(report.synthesis.directJudgments).toEqual({ passed: 3, failed: 4, unknown: 0 });
    expect(report.synthesis.comparisons).toMatchObject([
      { equivalence: { verdict: "pass" }, expectation: { verdict: "pass" } }
    ]);
    expect(report.synthesis.reader).toMatchObject({ commands: 1, passed: 1 });
    expect(report.synthesis.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ruleId: "aria-required-parent",
          checkpointCount: 4,
          remediation: expect.objectContaining({
            ai: expect.objectContaining({ used: false })
          }),
          checkpoints: expect.arrayContaining([
            expect.objectContaining({
              domPath: expect.any(String),
              accessibilityTreePath: expect.any(String),
              screenshotPath: expect.any(String)
            })
          ])
        })
      ])
    );
    expect(html).toContain("<video controls");
    expect(html).toContain("Virtual screen-reader report");
    expect(html).toContain('data-tab-list aria-label="Report sections"');
    expect(html).toContain("Keyboard and pointer overview");
    expect(html).toContain("Your accessibility status");
    expect(html).toContain("Ask this report");
    expect(html).toContain("Grouped fix review");
    expect(html).toContain("affected page location");
    expect(html).toContain("Proposed fix");
    expect(html).toContain("Open complete interaction trace");
    expect(html).toContain("Every checkpoint considered in this conclusion");
    expect(html).toContain("Deterministic remediation");
    await access(result.manifestFile);

    await page.goto(pathToFileURL(result.reportFiles.html).href);
    const tabs = page.getByRole("tab");
    await expect(tabs).toHaveCount(6);
    await expect(page.getByRole("tab", { name: "Status & plan" })).toHaveAttribute(
      "aria-selected",
      "true"
    );
    await expect(page.getByRole("heading", { name: "Your accessibility status" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Keyboard journey recording" })).toBeVisible();
    const keyboardRecording = page.locator(".journey-proof video");
    await expect(keyboardRecording).toBeVisible();
    await expect(keyboardRecording.locator("source")).toHaveAttribute(
      "src",
      /keyboard\/video\.webm$/
    );
    await expect(keyboardRecording).toHaveAttribute(
      "poster",
      /keyboard-001\/artifacts\/visual-viewport-after\.png$/
    );
    await expect(
      page.getByRole("link", { name: "Read action descriptions" }).first()
    ).toBeVisible();
    await expect(page.getByRole("link", { name: "Inspect timed action data" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Keyboard and pointer overview" })).toBeHidden();

    const fixTab = page.getByRole("tab", { name: /Fix review/ });
    await fixTab.click();
    await expect(fixTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Grouped fix review" })).toBeVisible();
    await expect(page.getByText("Proposed fix", { exact: true }).first()).toBeVisible();

    const affectedCrop = page.locator(".target-crop").first();
    const completeCapturePath = await affectedCrop.getAttribute("href");
    await affectedCrop.click();
    const imageDialog = page.getByRole("dialog");
    await expect(imageDialog).toBeVisible();
    await expect(imageDialog.locator(".target-crop")).toBeVisible();
    await expect(
      imageDialog.getByRole("link", { name: "Open complete page capture" })
    ).toHaveAttribute("href", new URL(completeCapturePath!, page.url()).href);
    await imageDialog.getByRole("button", { name: "Close" }).click();
    await expect(imageDialog).toBeHidden();
    await expect(affectedCrop).toBeFocused();

    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".instance-list summary").first().click();
    const expandedWidths = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth
    }));
    expect(expandedWidths.scrollWidth).toBe(expandedWidths.clientWidth);

    await fixTab.press("ArrowRight");
    const journeysTab = page.getByRole("tab", { name: "Tested journeys" });
    await expect(journeysTab).toBeFocused();
    await expect(
      page.getByRole("heading", { name: "Keyboard and pointer overview" })
    ).toBeVisible();
    await expect(page.getByText("Both lanes matched", { exact: false })).toBeVisible();

    await expect(page.getByRole("heading", { name: "Virtual screen-reader report" })).toBeVisible();

    await page.getByRole("button", { name: "How bad is it?" }).click();
    await expect(page.getByRole("status")).toContainText("Release is blocked in the tested scope");

    const accessibility = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"])
      .analyze();
    expect(
      accessibility.violations.filter(({ impact }) => impact === "critical" || impact === "serious")
    ).toEqual([]);

    const noScriptContext = await browser.newContext({ javaScriptEnabled: false });
    try {
      const noScriptPage = await noScriptContext.newPage();
      await noScriptPage.goto(pathToFileURL(result.reportFiles.html).href);
      await expect(
        noScriptPage.getByRole("heading", { name: "Keyboard and pointer overview" })
      ).toBeVisible();
      await expect(
        noScriptPage.getByRole("heading", { name: "Axe results", exact: true })
      ).toBeVisible();
      await expect(noScriptPage.getByRole("heading", { name: "Technical annex" })).toBeVisible();
    } finally {
      await noScriptContext.close();
    }
  } finally {
    await server.close();
  }
});

test("a lane whose browser cannot open a page records it as failed and keeps the report incomplete in every format", async ({
  browser
}, testInfo) => {
  const server = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><html lang="en"><head><title>Example</title></head><body>
      <main><h1>Account overview</h1><button type="button">Show details</button></main>
    </body></html>`);
  });
  // The browser cannot open the first lane's context, as when it crashes, disconnects or runs out
  // of memory, so the start-page lane fails before it opens the page and records itself as failed.
  // The other lanes complete. A lane that leaves no manifest at all is covered in
  // scenario-runner.test.ts, since no lane is left that fails that way.
  const journeyId = "read-page";
  let contextsOpened = 0;
  const failsFirstContext = new Proxy(browser, {
    get(target, property) {
      if (property === "newContext") {
        return (...args: Parameters<Browser["newContext"]>) =>
          contextsOpened++ === 0
            ? Promise.reject(new Error("The browser could not open a context."))
            : target.newContext(...args);
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
  const scenarioYaml = `schemaVersion: 0.1.0
id: lane-fails-early
target:
  url: ${server.origin}/
  allowedOrigins:
    - ${server.origin}
standard:
  name: WCAG
  version: "2.2"
  levels: [A, AA]
profile: core
goal: Read the page.
journeys:
  - id: ${journeyId}
    name: Read page
    goal: Find the heading.
    startPath: /
    allowedActions: [navigate, hover, focus]
    forbiddenActions: [submit]
    virtualScreenReaderCommands: [next-heading]
    interactionComparisons:
      - id: show-details-hover-focus
        name: Show details with pointer and keyboard
        pointerActions:
          - id: hover-show-details
            kind: hover
            target: { role: button, name: Show details }
        keyboardActions:
          - id: focus-show-details
            kind: focus
            target: { role: button, name: Show details }
        observe:
          target: { role: button, name: Show details }
          visible: true
privacy:
  storage: local
  remoteUpload: forbidden
  sharingReviewRequired: true
approval:
  required: true
`;

  try {
    const result = await runApprovedScenario(failsFirstContext, scenarioYaml, testInfo);
    const report = JSON.parse(await readFile(result.reportFiles.json, "utf8")) as {
      status: string;
      verdict: string;
      completeness: { status: string; plannedLanes: number; completedLanes: number };
      diagnostics: string[];
    };

    expect(report.diagnostics).toEqual([
      expect.stringMatching(
        new RegExp(`^${journeyId}-start-page: The browser could not open a context`)
      )
    ]);
    // The failed lane is in the run's evidence, not just in its diagnostics.
    const manifest = JSON.parse(await readFile(result.manifestFile, "utf8")) as {
      lanes: Array<{ id: string; status: string }>;
    };
    expect(manifest.lanes).toContainEqual(
      expect.objectContaining({ id: `${journeyId}-start-page`, status: "failed" })
    );
    expect(report.completeness).toMatchObject({
      status: "incomplete",
      plannedLanes: 5,
      completedLanes: 4
    });
    expect(report.status).toBe("partial");
    expect(report.verdict).toBe("unknown");
    expect(result.completeness).toBe("incomplete");
    expect(await readFile(result.reportFiles.prComment, "utf8")).toContain("Evidence: incomplete.");
    expect(await readFile(result.reportFiles.markdown, "utf8")).toContain(
      "**Evidence completeness:** INCOMPLETE"
    );
    expect(await readFile(result.reportFiles.html, "utf8")).toContain("incomplete · 4/5 lanes");
  } finally {
    await server.close();
  }
});

interface JsonReport {
  run: {
    status: string;
    results?: {
      pass: number;
      fail: number;
      unknown: number;
    };
  };
  records: Array<{
    observerId: string;
    phase?: string;
    status: string;
    meta?: {
      focusTarget?: unknown;
      byteLength?: number;
      viewportByteLength?: number;
      fullPageByteLength?: number;
      engineVersion?: string;
      violations?: number;
      changed?: boolean;
      previousByteLength?: number;
      eventCount?: number;
      interestingEventCount?: number;
      filteredNoiseCount?: number;
      requestCount?: number;
      responseCount?: number;
      matchedResponseCount?: number;
      newEventCount?: number;
      newInterestingEventCount?: number;
      newRequestCount?: number;
      newResponseCount?: number;
      newMatchedResponseCount?: number;
      interestingUrls?: string[];
      newInterestingUrls?: string[];
      focusOrderIndex?: number;
      focusableCount?: number;
    };
  }>;
  judgments: Array<{
    judgeId: string;
    verdict: string;
    summary?: string;
    findings?: Array<{ ruleId?: string; severity: string }>;
  }>;
}

test("runAeeOnPage captures evidence from a real Playwright page", async ({ page }, testInfo) => {
  await page.setContent(`
    <main>
      <h1>Accessibility Evidence Engine</h1>
      <p>Evidence-first accessibility investigations for Playwright flows.</p>
      <button type="button">Save</button>
    </main>
  `);

  const outputBaseDir = testInfo.outputPath("aee-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["dom", "accessibility-tree"],
    judges: ["structure", "release"],
    checkpointName: "playwright-smoke",
    interaction: {
      kind: "custom",
      actor: "test",
      target: {
        role: "document",
        name: "Playwright smoke page"
      }
    }
  });

  expect(result.outputDir).toBeDefined();
  expect(result.outputDir?.startsWith(outputBaseDir)).toBe(true);
  expect(result.reporterFiles).toHaveLength(2);
  // No interaction runs, so each observer captures the page once.
  expect(result.artifactFiles).toHaveLength(2);

  await Promise.all([
    ...result.reporterFiles.map((filePath) => access(filePath)),
    ...result.artifactFiles.map((filePath) => access(filePath))
  ]);

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(JSON.stringify(report)).not.toMatch(
    /private-token|private-authorization|private-api-key|private@example\.com/
  );
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 2,
    fail: 0,
    unknown: 0
  });
  expect(report.records).toHaveLength(2);
  expect(report.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observerId: "dom",
        status: "ok"
      }),
      expect.objectContaining({
        observerId: "accessibility-tree",
        status: "ok"
      })
    ])
  );
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "structure",
        verdict: "pass"
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "pass"
      })
    ])
  );
});

test("runAeeOnPage can capture screenshots around a click interaction", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main style="padding: 24px; background: white;">
      <button id="save" type="button">Save</button>
      <p id="status">Idle</p>
    </main>
  `);
  await page.locator("#save").evaluate((button) => {
    button.addEventListener("click", () => {
      const status = document.querySelector("#status");

      if (status) {
        status.textContent = "Saved";
      }

      document.body.style.background = "rgb(222, 255, 232)";
    });
  });

  const outputBaseDir = testInfo.outputPath("aee-visual-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["visual"],
    judges: ["release"],
    checkpointName: "visual-click",
    interaction: {
      kind: "click",
      actor: "test",
      target: {
        role: "button",
        name: "Save"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.click("#save");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  expect(result.artifactFiles).toHaveLength(4);
  await expect(page.locator("#status")).toHaveText("Saved");

  const screenshotBuffers = await Promise.all(
    result.artifactFiles.map((filePath) => readFile(filePath))
  );
  for (const [index, screenshotBuffer] of screenshotBuffers.entries()) {
    expect(result.artifactFiles[index]?.endsWith(".png")).toBe(true);
    expect(screenshotBuffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 1,
    fail: 0,
    unknown: 0
  });
  expect(report.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observerId: "visual",
        phase: "before",
        status: "ok",
        meta: expect.objectContaining({
          viewportByteLength: expect.any(Number),
          fullPageByteLength: expect.any(Number)
        })
      }),
      expect.objectContaining({
        observerId: "visual",
        phase: "after",
        status: "ok",
        meta: expect.objectContaining({
          viewportByteLength: expect.any(Number),
          fullPageByteLength: expect.any(Number)
        })
      })
    ])
  );
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "release",
        verdict: "pass"
      })
    ])
  );
});

test("runAeeOnPage preserves axe 4.14 WCAG results and locates failing elements", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <html>
      <head><title>Axe evidence</title></head>
      <body><main><button id="unlabelled"></button></main></body>
    </html>
  `);

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: testInfo.outputPath("aee-axe-output"),
    observers: ["axe"],
    judges: ["release"],
    checkpointName: "axe-raw-evidence",
    interaction: {
      kind: "custom",
      actor: "test",
      target: { role: "document", name: "Axe fixture" }
    }
  });

  expect(result.artifactFiles).toHaveLength(1);
  const rawResults = await Promise.all(
    result.artifactFiles.map(async (filePath) => JSON.parse(await readFile(filePath, "utf8")))
  );

  for (const rawResult of rawResults) {
    // The report reads this file through its schema, so what axe and AEE wrote must match it.
    expect(validateSchema("axeResult", rawResult)).toEqual({ valid: true, errors: [] });
    expect(rawResult.testEngine.version).toBe("4.14.0");
    expect(rawResult.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "button-name" })])
    );
    const buttonName = rawResult.violations.find(
      (violation: { id?: string }) => violation.id === "button-name"
    );
    expect(buttonName?.nodes[0].aeeTarget).toEqual(
      expect.objectContaining({
        x: expect.any(Number),
        y: expect.any(Number),
        width: expect.any(Number),
        height: expect.any(Number),
        pageWidth: expect.any(Number),
        pageHeight: expect.any(Number)
      })
    );
    expect(rawResult).toEqual(
      expect.objectContaining({
        passes: expect.any(Array),
        incomplete: expect.any(Array),
        inapplicable: expect.any(Array)
      })
    );
  }
});

test("runAeeOnPage keeps axe's path into a shadow root, locates that element and keeps axe's impact", async ({
  page
}, testInfo) => {
  // The host is much larger than the nameless button inside it, so locating the host is wrong.
  await page.setContent(`
    <html lang="en">
      <head><title>Shadow evidence</title></head>
      <body>
        <main>
          <h1>Settings</h1>
          <div id="toolbar" style="display: block; padding: 120px 0 0 200px; width: 600px"></div>
        </main>
        <script>
          document.querySelector("#toolbar").attachShadow({ mode: "open" }).innerHTML =
            '<button class="icon" style="width: 40px; height: 30px"></button>';
        </script>
      </body>
    </html>
  `);
  const box = await page.locator("#toolbar button.icon").boundingBox();

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: testInfo.outputPath("aee-axe-shadow-output"),
    observers: ["axe"],
    judges: ["axe", "release"],
    checkpointName: "axe-shadow-target",
    interaction: {
      kind: "custom",
      actor: "test",
      target: { role: "document", name: "Shadow fixture" }
    }
  });

  const raw = JSON.parse(await readFile(result.artifactFiles[0]!, "utf8"));
  const buttonName = raw.violations.find(({ id }: { id: string }) => id === "button-name");
  expect(buttonName.nodes[0].target).toEqual([["#toolbar", "button"]]);
  expect(buttonName.nodes[0].aeeTarget).toEqual(
    expect.objectContaining({ x: box!.x, y: box!.y, width: box!.width, height: box!.height })
  );
  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  const axeJudgment = report.judgments.find(({ judgeId }) => judgeId === "axe");
  expect(axeJudgment?.verdict).toBe("fail");
  expect(axeJudgment?.findings?.find(({ ruleId }) => ruleId === "button-name")?.severity).toBe(
    "critical"
  );
});

test("runAeeOnPage runs axe's experimental WCAG rules and blocks release on them", async ({
  page
}, testInfo) => {
  // A bold paragraph styled as a title, and a data table whose cells have no headers.
  await page.setContent(`
    <html lang="en">
      <head><title>Experimental rules</title></head>
      <body>
        <main>
          <h1>Orders</h1>
          <p style="font-size: 1.6em; font-weight: bold">Shipping</p>
          <p>Parcels leave the warehouse every weekday before noon.</p>
          <p>Each parcel is tracked from the warehouse to the door.</p>
          <table>
            <caption>Recent orders</caption>
            <tr><td>Order</td><td>Item</td><td>Status</td></tr>
            <tr><td>1001</td><td>Lamp</td><td>Sent</td></tr>
            <tr><td>1002</td><td>Chair</td><td>Packed</td></tr>
          </table>
        </main>
      </body>
    </html>
  `);

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: testInfo.outputPath("aee-axe-experimental-output"),
    observers: ["axe"],
    judges: ["axe", "release"],
    checkpointName: "axe-experimental-rules",
    interaction: {
      kind: "custom",
      actor: "test",
      target: { role: "document", name: "Experimental rules fixture" }
    }
  });

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  const axeJudgment = report.judgments.find(({ judgeId }) => judgeId === "axe");
  expect(axeJudgment?.verdict).toBe("fail");
  expect(axeJudgment?.summary).toContain("p-as-heading");
  expect(axeJudgment?.summary).toContain("td-has-header");
  expect(report.judgments).toContainEqual(
    expect.objectContaining({ judgeId: "release", verdict: "fail" })
  );
});

test("portable virtual reader records guide navigation without moving DOM focus", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <h1>Invoices</h1>
      <p>Review outstanding bills.</p>
      <button id="pay" type="button">Pay invoice</button>
    </main>
  `);
  await page.locator("#pay").focus();
  const reader = createPortableVirtualScreenReader(page);

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: testInfo.outputPath("aee-virtual-reader-output"),
    virtualScreenReader: reader,
    observers: ["focus", "virtual-screen-reader"],
    judges: ["screen-reader", "release"],
    checkpointName: "virtual-reader-next-heading",
    interaction: {
      kind: "screen-reader-command",
      input: "next-heading",
      actor: "test"
    },
    async performInteraction() {
      await reader.command("next-heading");
    }
  });

  await expect(page.locator("#pay")).toBeFocused();
  expect(result.artifactFiles).toHaveLength(6);
  const transcriptPath = result.artifactFiles.find((filePath) =>
    filePath.endsWith("virtual-screen-reader-transcript-json-after.json")
  );
  expect(transcriptPath).toBeTruthy();
  const transcript = JSON.parse(await readFile(transcriptPath!, "utf8"));
  expect(transcript).toEqual(
    expect.objectContaining({
      mode: "guide",
      fidelity: "semantic-simulation",
      physicalAssistiveTechnology: false,
      entries: [
        expect.objectContaining({
          command: "next-heading",
          announcement: "heading, Invoices, level 1",
          domFocusBefore: expect.objectContaining({
            nodePath: "#pay",
            frameId: expect.any(String)
          }),
          domFocusAfter: expect.objectContaining({ nodePath: "#pay", frameId: expect.any(String) }),
          focusMoved: false
        })
      ]
    })
  );
});

test("portable virtual reader keeps every state, the description and the value Chrome gives an element", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <h1>Invoices</h1>
      <button id="filters" type="button" aria-expanded="false" aria-haspopup="true" aria-describedby="filters-hint">Filters</button>
      <p id="filters-hint">Narrows the list by status</p>
      <label>Search <input id="search" value="overdue" required aria-invalid="true"></label>
    </main>
  `);
  const reader = createPortableVirtualScreenReader(page);
  await reader.command("start");

  const button = (await reader.command("next-control")).item;
  expect(button).toEqual(
    expect.objectContaining({
      role: "button",
      name: "Filters",
      description: "Narrows the list by status",
      states: ["collapsed"],
      backendDOMNodeId: expect.any(Number)
    })
  );
  const buttonProperties = new Map(button?.properties?.map(({ name, value }) => [name, value]));
  // Before, only six states were kept; the pop-up and the description link were lost.
  expect(buttonProperties.get("hasPopup")?.value).toBe("menu");
  expect(buttonProperties.get("describedby")?.relatedNodes?.[0]?.idref).toBe("filters-hint");

  const search = (await reader.command("next-control")).item;
  expect(search).toEqual(expect.objectContaining({ role: "textbox", value: "overdue" }));
  const searchProperties = new Map(search?.properties?.map(({ name, value }) => [name, value]));
  expect(searchProperties.get("invalid")?.value).toBe("true");
  expect(searchProperties.get("required")?.value).toBe(true);

  // The judge finds that same element in the tree taken at the checkpoint and compares it whole.
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: testInfo.outputPath("aee-virtual-reader-states"),
    virtualScreenReader: reader,
    observers: ["dom", "accessibility-tree", "visual", "virtual-screen-reader"],
    judges: ["screen-reader"],
    checkpointName: "virtual-reader-read-current",
    interaction: { kind: "screen-reader-command", input: "read-current", actor: "test" },
    async performInteraction() {
      await reader.command("read-current");
    }
  });
  const report = JSON.parse(
    await readFile(
      result.reporterFiles.find((file) => file.endsWith("aee-report.json"))!,
      "utf8"
    )
  ) as JsonReport;
  const judgment = report.judgments.find(({ judgeId }) => judgeId === "screen-reader");
  expect(judgment?.verdict).toBe("pass");
  expect(judgment?.summary).toContain(
    "The element it read has the same role, name, description, value and states"
  );
});

test("portable virtual reader says aria-current as Chrome and NVDA read it, an unknown value as plain current", async ({
  page
}) => {
  // WAI-ARIA 1.2: a value outside page, step, location, date, time, true and false is read as true;
  // "false", "" and "undefined" are not current. Chrome matches the tokens in any case.
  const values = [
    "page",
    "STEP",
    "location",
    "date",
    "time",
    "true",
    "foo",
    "false",
    "",
    "undefined"
  ];
  await page.setContent(`
    <nav aria-label="Pages">
      ${values.map((value) => `<a href="#${value || "empty"}" aria-current="${value}">Link ${value || "empty"}</a>`).join("\n")}
    </nav>
  `);
  const reader = createPortableVirtualScreenReader(page);
  const heard: Record<string, string[]> = {};
  await reader.command("start");
  for (let { item } = await reader.command("next-control"); item?.name;) {
    heard[item.name] = item.states;
    ({ item } = await reader.command("next-control"));
  }
  expect(heard).toEqual({
    "Link page": ["current page"],
    "Link STEP": ["current step"],
    "Link location": ["current location"],
    "Link date": ["current date"],
    "Link time": ["current time"],
    "Link true": ["current"],
    // Before, this was "current foo": the invalid value was read out as if it were a word.
    "Link foo": ["current"],
    "Link false": [],
    "Link empty": [],
    "Link undefined": []
  });
});

test("element map lists each image screen readers skip, with Chrome's exact reason", async ({
  page
}) => {
  const image = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40"/></svg>')}`;
  await page.setContent(`
    <main>
      <h1>Team</h1>
      <p>
        <img src="${image}" alt="" width="40" height="40">
        <img src="${image}" alt="Team photo" aria-hidden="true" width="40" height="40">
        <img src="${image}" role="presentation" width="40" height="40">
        <img src="${image}" alt="Org chart" width="40" height="40">
      </p>
    </main>
  `);

  // The full tree leaves these images out in a paragraph; each is asked about on its own.
  const map = await withPageSessions(page.context(), page, captureElementMap);

  expect(
    map.elements
      .filter(({ kind }) => kind === "image")
      .map(({ alt, ignoredReasons, name }) => ({ alt, ignoredReasons, name }))
  ).toEqual([
    { alt: "ignored", ignoredReasons: ["emptyAlt"], name: "" },
    { alt: "ignored", ignoredReasons: ["ariaHiddenElement"], name: "" },
    { alt: "ignored", ignoredReasons: ["presentationalRole"], name: "" },
    { alt: "text", ignoredReasons: undefined, name: "Org chart" }
  ]);
});

test("portable virtual reader supports item, heading, landmark, control, and current-item commands", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <h1>Dashboard</h1>
      <p>Overview</p>
      <h2>Invoices</h2>
    </main>
    <nav aria-label="Account"><a href="#profile">Profile</a></nav>
    <button id="stable-focus" type="button">Stay focused</button>
  `);
  await page.locator("#stable-focus").focus();
  const reader = createPortableVirtualScreenReader(page);

  expect((await reader.command("start")).item?.role).toBe("main");
  expect((await reader.command("next-heading")).announcement).toBe("heading, Dashboard, level 1");
  expect((await reader.command("next-heading")).announcement).toBe("heading, Invoices, level 2");
  expect((await reader.command("previous-heading")).announcement).toBe(
    "heading, Dashboard, level 1"
  );
  expect((await reader.command("next-landmark")).announcement).toBe("navigation, Account");
  expect((await reader.command("next-control")).announcement).toBe("link, Profile");
  expect((await reader.command("read-current")).announcement).toBe("link, Profile");
  expect((await reader.command("previous-item")).item?.role).toBe("navigation");
  expect((await reader.command("next-item")).item?.role).toBe("link");
  await expect(page.locator("#stable-focus")).toBeFocused();

  const transcript = await reader.snapshot();
  expect(transcript.entries).toHaveLength(9);
  expect(transcript.entries.every(({ focusMoved }) => !focusMoved)).toBe(true);
});

test("portable virtual reader flags the unnamed items WAI-ARIA 1.2 requires a name for, and not a tab", async ({
  page
}) => {
  await page.setContent(`
    <main>
      <h1>Upload</h1>
      <progress value="4" max="10"></progress>
      <div role="progressbar" aria-valuenow="40"></div>
      <meter value="3" max="10"></meter>
      <div role="tablist" aria-label="Views">
        <div id="summary-tab" role="tab" aria-selected="true" aria-controls="summary"></div>
      </div>
      <div id="summary" role="tabpanel"><p>Two files left</p></div>
      <div role="tooltip"><p>Uploads pause offline</p></div>
      <div role="tooltip"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt=""></div>
      <div role="region"><p>Recent uploads</p></div>
    </main>
  `);
  const reader = createPortableVirtualScreenReader(page);
  await reader.command("start");
  while (await reader.peek("next-item")) await reader.command("next-item");

  // The reader stops at the start and the end of a container; each element counts once.
  const read = new Map(
    (await reader.snapshot()).entries.flatMap(({ item }) => (item ? [[item.nodePath, item]] : []))
  );
  const roles = (flagged: boolean) =>
    [...read.values()]
      .filter((item) => announcedWithoutName(item) === flagged)
      .map(({ role }) => role);
  // An unnamed <progress>, role="progressbar", <meter>, tabpanel and tooltip: ARIA 1.2 requires each
  // to be named. The tooltip whose text names it is not flagged.
  expect(roles(true)).toEqual(["progressbar", "progressbar", "meter", "tabpanel", "tooltip"]);
  // A tab is named by its content in ARIA 1.2 and needs no name, so an empty one is not flagged.
  expect(roles(false)).toContain("tab");
  // Chrome exposes a region with no name as a generic container, as Core-AAM says, so the reader
  // never reads it as a region.
  expect([...read.values()].map(({ role }) => role)).not.toContain("region");
});

test("virtual-reader lane owns an isolated context and captures every command", async ({
  browser
}, testInfo) => {
  const fixtureServer = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    // A page with no stylesheet at all leaves axe's css-orientation-lock "needs review".
    response.end(`
      <!doctype html>
      <html lang="en">
        <head><title>Lane fixture</title><style>main { margin: 1rem; }</style></head>
        <body><main><h1>Invoices</h1><button type="button">Pay invoice</button></main></body>
      </html>
    `);
  });
  const initialContextCount = browser.contexts().length;

  try {
    const lane = await runVirtualScreenReaderLane({
      browser,
      projectRoot: process.cwd(),
      outputDir: testInfo.outputPath("virtual-reader-lanes"),
      laneId: "reader-lane-test",
      targetUrl: `${fixtureServer.origin}/invoices`,
      allowedOrigins: [fixtureServer.origin],
      commands: ["next-heading", "next-control"]
    });

    expect(browser.contexts()).toHaveLength(initialContextCount);
    expect(lane.status).toBe("completed");
    expect(lane.isolation).toBe("dedicated-browser-context");
    expect(lane.steps).toHaveLength(2);
    expect(lane.transcript.entries.map(({ announcement }) => announcement)).toEqual([
      "heading, Invoices, level 1",
      "button, Pay invoice"
    ]);
    expect(lane.transcript.entries.every(({ focusMoved }) => !focusMoved)).toBe(true);
    expect(
      lane.transcript.entries.every(
        ({ item }) => (item?.visualBounds.width ?? 0) > 0 && (item?.visualBounds.height ?? 0) > 0
      )
    ).toBe(true);
    expect(lane.steps.every(({ reporterFiles }) => reporterFiles.length === 2)).toBe(true);
    expect(lane.steps.every(({ releaseVerdict }) => releaseVerdict === "pass")).toBe(true);

    for (const step of lane.steps) {
      expect(
        step.artifactFiles.some((filePath) => filePath.endsWith("visual-full-page-after.png"))
      ).toBe(true);
      expect(
        step.artifactFiles.some((filePath) =>
          filePath.endsWith("virtual-screen-reader-transcript-json-after.json")
        )
      ).toBe(true);
      expect(step.artifactFiles.some((filePath) => filePath.endsWith("axe-after.json"))).toBe(true);
      // A reader command only reads the page, so the page is captured once, after it.
      expect(step.artifactFiles.filter((filePath) => /-before\./.test(filePath))).toEqual([]);
      const reportPath = step.reporterFiles.find((filePath) =>
        filePath.endsWith("aee-report.json")
      );
      const report = JSON.parse(await readFile(reportPath!, "utf8")) as JsonReport;
      expect(report.judgments).toContainEqual(
        expect.objectContaining({
          judgeId: "screen-reader",
          verdict: "pass",
          summary: expect.stringContaining(
            "The element it read has the same role, name, description, value and states"
          )
        })
      );
    }

    await Promise.all([
      access(lane.laneFile!),
      access(lane.transcriptJsonFile!),
      access(lane.transcriptTextFile!),
      access(lane.manifestFile!),
      access(lane.video!.videoFile),
      access(lane.video!.sidecarFile),
      access(lane.video!.captionsFile)
    ]);
    const videoSidecar = JSON.parse(await readFile(lane.video!.sidecarFile, "utf8"));
    expect(videoSidecar.actions.map(({ label }: { label: string }) => label)).toEqual([
      "Virtual reader: next-heading",
      "Virtual reader: next-control"
    ]);
    expect(await readFile(lane.video!.captionsFile, "utf8")).toContain("WEBVTT");
    // Only the lane's page is recorded: not the blank page axe opens in its context for each run.
    expect(
      (await readdir(path.dirname(lane.laneFile!))).filter((name) => name.endsWith(".webm"))
    ).toEqual(["video.webm"]);
    const manifest = JSON.parse(await readFile(lane.manifestFile!, "utf8"));
    expect(manifest.status).toBe("completed");
    expect(manifest.summary.missing).toBe(0);
    expect(
      manifest.artifacts.every(({ path: filePath }: { path: string }) => !path.isAbsolute(filePath))
    ).toBe(true);
  } finally {
    await fixtureServer.close();
  }
});

interface AxeResultFile {
  /** When axe ran: each run stamps its own time. */
  timestamp: string;
  violations: Array<{ id: string; nodes: Array<{ html: string }> }>;
}

/** Runs the virtual-reader lane over a page and reads back each step's axe result and screenshot. */
async function readerLaneCaptures(
  browser: Browser,
  html: string,
  outputDir: string
): Promise<Array<{ axe: AxeResultFile; screenshot: Buffer }>> {
  const server = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  try {
    const lane = await runVirtualScreenReaderLane({
      browser,
      projectRoot: process.cwd(),
      outputDir,
      laneId: "reader-lane-captures",
      targetUrl: `${server.origin}/`,
      allowedOrigins: [server.origin],
      commands: ["start", "next-item", "next-item", "next-item"]
    });
    expect(lane.steps).toHaveLength(4);
    return await Promise.all(
      lane.steps.map(async ({ artifactFiles }) => {
        const file = (basename: string) =>
          artifactFiles.find((filePath) => filePath.endsWith(basename))!;
        return {
          axe: JSON.parse(await readFile(file("axe-after.json"), "utf8")) as AxeResultFile,
          screenshot: await readFile(file("visual-full-page-after.png"))
        };
      })
    );
  } finally {
    await server.close();
  }
}

test("virtual-reader lane runs axe and takes its screenshots once while the page stays as it was", async ({
  browser
}, testInfo) => {
  const steps = await readerLaneCaptures(
    browser,
    `<!doctype html><html lang="en"><head><title>Invoices</title></head><body><main>
      <h1>Invoices</h1><p>Two invoices are due.</p>
      <button type="button">Pay invoices</button><p>Due on Friday.</p>
    </main></body></html>`,
    testInfo.outputPath("unchanged-page")
  );
  // A reader command never changes the page, so every step gives the first step's capture.
  expect(new Set(steps.map(({ axe }) => axe.timestamp)).size).toBe(1);
  expect(new Set(steps.map(({ screenshot }) => screenshot.toString("base64"))).size).toBe(1);
});

test("virtual-reader lane captures afresh at each step once its page changed in the DOM", async ({
  browser
}, testInfo) => {
  // The page changes an attribute of an image with no text alternative every few milliseconds,
  // which axe quotes in its result, so each step's result shows the page as it was at that step.
  const steps = await readerLaneCaptures(
    browser,
    `<!doctype html><html lang="en"><head><title>Ticker</title></head><body><main>
      <h1>Ticker</h1><img id="tick" data-tick="0" width="20" height="20"
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">
      <p>Ticks on its own.</p><p>And again.</p>
    </main><script>
      setInterval(() => { tick.dataset.tick = String(Number(tick.dataset.tick) + 1); }, 20);
    </script></body></html>`,
    testInfo.outputPath("ticking-attribute")
  );
  const quoted = steps.map(
    ({ axe }) => axe.violations.find(({ id }) => id === "image-alt")?.nodes[0]?.html
  );
  expect(quoted.every((html) => html?.includes("data-tick="))).toBe(true);
  expect(new Set(quoted).size).toBe(steps.length);
  expect(new Set(steps.map(({ axe }) => axe.timestamp)).size).toBe(steps.length);
});

test("virtual-reader lane captures afresh at each step once its page changed outside the DOM", async ({
  browser
}, testInfo) => {
  // A field's value changes with no change to the DOM's nodes or attributes, yet it shows.
  const steps = await readerLaneCaptures(
    browser,
    `<!doctype html><html lang="en"><head><title>Counter</title></head><body><main>
      <h1>Counter</h1><label>Count <input id="count" value="0"></label>
      <p>Counts on its own.</p><p>And again.</p>
    </main><script>
      setInterval(() => { count.value = String(Number(count.value) + 1); }, 20);
    </script></body></html>`,
    testInfo.outputPath("ticking-value")
  );
  expect(new Set(steps.map(({ screenshot }) => screenshot.toString("base64"))).size).toBe(
    steps.length
  );
  expect(new Set(steps.map(({ axe }) => axe.timestamp)).size).toBe(steps.length);
});

test("a lane's capture is given again only while the page has not changed since it was taken", async ({
  page
}, testInfo) => {
  await page.setContent(`<!doctype html><html lang="en"><head><title>Invoices</title></head>
    <body><main><h1>Invoices</h1>
      <img id="logo" width="20" height="20"
        src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E">
      <label>Note <input id="note"></label>
    </main></body></html>`);
  const laneCaptures = createLaneCaptures();
  let step = 0;
  // One step of a lane: what it captured, with nothing done to the page by the step itself.
  const capture = async () => {
    step += 1;
    const { artifactFiles } = await runAeeOnPage({
      page,
      projectRoot: testInfo.outputPath(),
      outputDir: "steps",
      runId: `step-${step}`,
      observers: ["axe", "visual"],
      judges: ["axe"],
      laneCaptures
    });
    const file = (basename: string) =>
      artifactFiles.find((filePath) => filePath.endsWith(basename))!;
    return {
      axe: JSON.parse(await readFile(file("axe-after.json"), "utf8")) as AxeResultFile,
      screenshot: (await readFile(file("visual-full-page-after.png"))).toString("base64")
    };
  };
  const logo = (result: { axe: AxeResultFile }) =>
    result.axe.violations.find(({ id }) => id === "image-alt")?.nodes[0]?.html;

  // Playwright's screenshot leaves an empty style attribute on the field, so the first capture
  // changes the page; from the second on, nothing does.
  await capture();
  const settled = await capture();
  expect((await capture()).axe.timestamp).toBe(settled.axe.timestamp);

  // A change to the DOM: the next step captures afresh and shows it.
  await page.locator("#logo").evaluate((image) => image.setAttribute("data-state", "changed"));
  const afterAttribute = await capture();
  expect(afterAttribute.axe.timestamp).not.toBe(settled.axe.timestamp);
  expect(logo(afterAttribute)).toContain('data-state="changed"');
  expect((await capture()).axe.timestamp).toBe(afterAttribute.axe.timestamp);

  // A change no DOM node or attribute shows: a field's value, typed in or set by a script.
  await page.locator("#note").evaluate((field) => {
    (field as HTMLInputElement).value = "Paid in full";
  });
  const afterValue = await capture();
  expect(afterValue.axe.timestamp).not.toBe(afterAttribute.axe.timestamp);
  expect(afterValue.screenshot).not.toBe(afterAttribute.screenshot);

  // A change undone before the next step still counts: the capture is not proven the same.
  await page.locator("#logo").evaluate((image) => {
    image.setAttribute("hidden", "");
    image.removeAttribute("hidden");
  });
  expect((await capture()).axe.timestamp).not.toBe(afterValue.axe.timestamp);
  await laneCaptures.stop();
});

test("virtual-reader lane blocks a redirect outside the approved origin and closes its context", async ({
  browser
}, testInfo) => {
  const destination = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<h1>Outside approved origin</h1>");
  });
  const redirector = await startHtmlServer((_request, response) => {
    response.writeHead(302, { location: `${destination.origin}/outside` });
    response.end();
  });
  const initialContextCount = browser.contexts().length;
  const blockedOutputDir = testInfo.outputPath("blocked-virtual-reader-lanes");

  try {
    await expect(
      runVirtualScreenReaderLane({
        browser,
        projectRoot: process.cwd(),
        outputDir: blockedOutputDir,
        laneId: "reader-lane-blocked-origin",
        targetUrl: `${redirector.origin}/start`,
        allowedOrigins: [redirector.origin],
        commands: ["next-heading"]
      })
    ).rejects.toThrow(/blocked origin/);
    expect(browser.contexts()).toHaveLength(initialContextCount);
    const blockedLane = JSON.parse(
      await readFile(path.join(blockedOutputDir, "reader-lane-blocked-origin", "lane.json"), "utf8")
    );
    expect(blockedLane.status).toBe("blocked");
    expect(blockedLane.diagnostics).toEqual([expect.stringMatching(/blocked origin/)]);
    const blockedManifest = JSON.parse(
      await readFile(
        path.join(blockedOutputDir, "reader-lane-blocked-origin", "manifest.json"),
        "utf8"
      )
    );
    expect(blockedManifest.status).toBe("partial");
    expect(blockedManifest.lanes[0].status).toBe("blocked");
  } finally {
    await redirector.close();
    await destination.close();
  }
});

test("start-page lane records a redirect outside the approved origin as blocked and closes its context", async ({
  browser
}, testInfo) => {
  const destination = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<h1>Outside approved origin</h1>");
  });
  const redirector = await startHtmlServer((_request, response) => {
    response.writeHead(302, { location: `${destination.origin}/outside` });
    response.end();
  });
  const initialContextCount = browser.contexts().length;
  const outputDir = testInfo.outputPath("blocked-start-page-lanes");

  try {
    await expect(
      runStartPageLane({
        browser,
        projectRoot: process.cwd(),
        outputDir,
        laneId: "start-page-blocked-origin",
        targetUrl: `${redirector.origin}/start`,
        allowedOrigins: [redirector.origin]
      })
    ).rejects.toThrow(
      `Start-page lane blocked origin ${destination.origin} at ${destination.origin}/outside;`
    );
    expect(browser.contexts()).toHaveLength(initialContextCount);
    const manifest = JSON.parse(
      await readFile(path.join(outputDir, "start-page-blocked-origin", "manifest.json"), "utf8")
    );
    expect(manifest.status).toBe("partial");
    expect(manifest.lanes).toEqual([
      expect.objectContaining({ id: "start-page-blocked-origin", status: "blocked" })
    ]);
  } finally {
    await redirector.close();
    await destination.close();
  }
});

// The other site's page is a frame Chrome renders in the start page's own process when the two
// share a site (127.0.0.1 on another port), and in a process of its own when they do not
// (localhost): each is read through a different DevTools session.
for (const { label, host } of [
  { label: "the same site", host: "127.0.0.1" },
  { label: "another site", host: "localhost" }
]) {
  test(`start-page lane checks a frame on the start page that a redirect takes outside the allowed origins, on ${label}, and reads nothing inside it`, async ({
    browser
  }, testInfo) => {
    const outside = await startHtmlServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        `<body style="margin:0;background:rgb(0,255,0)"><h1>Outside heading</h1><img src="/x.png"></body>`
      );
    });
    const outsideOrigin = outside.origin.replace("127.0.0.1", host);
    const outsideUrl = `${outsideOrigin}/outside`;
    const reason = `It shows a page from ${outsideOrigin}, which is not an allowed origin; add it to them to check this frame.`;
    const site = await startHtmlServer((request, response) => {
      if (request.url === "/offers") {
        response.writeHead(302, { location: outsideUrl });
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html" });
      response.end(`<!doctype html><html lang="en"><head><title>Start</title></head><body>
        <main><h1>Start</h1><iframe title="Partner offers" src="/offers" width="300" height="200"></iframe></main>
      </body></html>`);
    });
    const outputDir = testInfo.outputPath("outside-frame-start-page-lanes");
    const laneDir = path.join(outputDir, "start-page-outside-frame");

    try {
      const lane = await runStartPageLane({
        browser,
        projectRoot: process.cwd(),
        outputDir,
        laneId: "start-page-outside-frame",
        targetUrl: `${site.origin}/`,
        allowedOrigins: [site.origin]
      });

      expect(lane.blockedNavigations).toEqual([outsideUrl]);
      expect(lane.diagnostics).toEqual([
        `start-page-outside-frame: checkpoint "start page" did not check the frame at ${outsideUrl}. ${reason}`
      ]);
      // Nothing the other site's page holds is kept anywhere in the lane's evidence or reports.
      for (const file of await readdir(laneDir, { recursive: true })) {
        if (!/\.(json|html|md)$/.test(file)) continue;
        expect(await readFile(path.join(laneDir, file), "utf8"), file).not.toContain(
          "Outside heading"
        );
      }
      const artifacts = path.join(laneDir, "start-page-outside-frame-001", "artifacts");
      // The frame's element is the start page's own, and is still read there.
      const tree = JSON.parse(
        await readFile(path.join(artifacts, "accessibility-tree-after.json"), "utf8")
      );
      expect(tree.framesNotRead).toEqual([{ url: outsideUrl, reason }]);
      expect(tree.nodes).toContainEqual(
        expect.objectContaining({
          role: expect.objectContaining({ value: "Iframe" }),
          name: expect.objectContaining({ value: "Partner offers" })
        })
      );
      // axe did not check the frame, so the start page is not reported as passing.
      const axe = JSON.parse(await readFile(path.join(artifacts, "axe-after.json"), "utf8"));
      expect(validateSchema("axeResult", axe)).toEqual({ valid: true, errors: [] });
      expect(axe.framesNotChecked).toEqual([
        {
          url: outsideUrl,
          reason,
          name: "Partner offers",
          selector: ["iframe"]
        }
      ]);
      expect(lane.steps).toEqual([expect.objectContaining({ releaseVerdict: "unknown" })]);
      const report = JSON.parse(
        await readFile(
          path.join(laneDir, "start-page-outside-frame-001", "aee-report.json"),
          "utf8"
        )
      );
      expect(report.judgments).toContainEqual(
        expect.objectContaining({
          judgeId: "axe",
          verdict: "unknown",
          summary: expect.stringContaining(
            `axe did not check the frame “Partner offers” at ${outsideUrl}. ${reason}`
          )
        })
      );
      // The screenshots cover the frame, so none of the other site's page is in them.
      for (const screenshot of ["visual-viewport-after.png", "visual-full-page-after.png"]) {
        const { data } = PNG.sync.read(await readFile(path.join(artifacts, screenshot)));
        const green = data.findIndex(
          (_value, at) =>
            at % 4 === 0 && data[at] === 0 && data[at + 1] === 255 && data[at + 2] === 0
        );
        expect(green, screenshot).toBe(-1);
      }
    } finally {
      await site.close();
      await outside.close();
    }
  });
}

test("input comparison runs declared pointer and keyboard actions in isolated contexts", async ({
  browser
}, testInfo) => {
  const fixtureServer = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`
      <!doctype html>
      <html lang="en">
        <head><title>Input comparison fixture</title></head>
        <body>
          <main>
            <button id="details" type="button">Invoice details</button>
            <p id="outcome" hidden>Invoice total is $24</p>
          </main>
          <script>
            const button = document.querySelector('#details');
            const outcome = document.querySelector('#outcome');
            const reveal = () => {
              outcome.hidden = false;
              outcome.dataset.state = 'shown';
            };
            button.addEventListener('mouseenter', reveal);
            button.addEventListener('focus', reveal);
          </script>
        </body>
      </html>
    `);
  });
  const initialContextCount = browser.contexts().length;

  try {
    const comparison = await runInputComparison({
      browser,
      projectRoot: process.cwd(),
      outputDir: testInfo.outputPath("input-comparisons"),
      comparisonId: "invoice-details-equivalence",
      name: "Invoice details appear on hover and keyboard focus",
      targetUrl: `${fixtureServer.origin}/invoices`,
      allowedOrigins: [fixtureServer.origin],
      pointerActions: [
        { id: "hover-details", kind: "hover", target: { role: "button", name: "Invoice details" } }
      ],
      keyboardActions: [
        { id: "focus-details", kind: "focus", target: { role: "button", name: "Invoice details" } }
      ],
      observe: {
        target: { selector: "#outcome" },
        visible: true,
        text: true,
        attributes: ["data-state"]
      },
      expected: {
        visible: true,
        text: "Invoice total is $24",
        attributes: { "data-state": "shown" }
      }
    });

    expect(browser.contexts()).toHaveLength(initialContextCount);
    expect(comparison.status).toBe("completed");
    expect(comparison.equivalence.verdict).toBe("pass");
    expect(comparison.expectation?.verdict).toBe("pass");
    expect(comparison.lanes.pointer.steps).toHaveLength(1);
    expect(comparison.lanes.keyboard.steps).toHaveLength(1);
    expect(comparison.lanes.pointer.steps[0]?.action.id).toBe("hover-details");
    expect(comparison.lanes.keyboard.steps[0]?.action.id).toBe("focus-details");
    for (const lane of Object.values(comparison.lanes)) {
      expect(
        lane.steps[0]?.artifactFiles.some((filePath) =>
          filePath.endsWith("visual-full-page-after.png")
        )
      ).toBe(true);
      expect(
        lane.steps[0]?.artifactFiles.some((filePath) => filePath.endsWith("axe-after.json"))
      ).toBe(true);
      await Promise.all([
        access(lane.video.videoFile),
        access(lane.video.sidecarFile),
        access(lane.video.captionsFile)
      ]);
      const videoSidecar = JSON.parse(await readFile(lane.video.sidecarFile, "utf8"));
      expect(videoSidecar.status).toBe("completed");
      expect(videoSidecar.actions).toHaveLength(1);
      // Only the lane's page is recorded: not the blank page axe opens in its context.
      expect(
        (await readdir(path.dirname(lane.video.videoFile))).filter((name) => name.endsWith(".webm"))
      ).toEqual([path.basename(lane.video.videoFile)]);
    }
    await access(comparison.traceFile);
    await access(comparison.manifestFile);
    const manifest = JSON.parse(await readFile(comparison.manifestFile, "utf8"));
    expect(manifest.status).toBe("completed");
    expect(manifest.summary.available).toBe(43);
    expect(manifest.artifacts.every(({ integrity }: { integrity?: string }) => integrity)).toBe(
      true
    );
  } finally {
    await fixtureServer.close();
  }
});

test("input comparison recaptures focus and Enter as separate keyboard actions", async ({
  browser
}, testInfo) => {
  const fixtureServer = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`
      <!doctype html>
      <html lang="en">
        <head><title>Activation fixture</title></head>
        <body>
          <button id="open" type="button">Open details</button>
          <p id="result" role="status">Closed</p>
          <script>
            document.querySelector('#open').addEventListener('click', () => {
              document.querySelector('#result').textContent = 'Open';
            });
          </script>
        </body>
      </html>
    `);
  });

  try {
    const comparison = await runInputComparison({
      browser,
      projectRoot: process.cwd(),
      outputDir: testInfo.outputPath("activation-comparisons"),
      comparisonId: "click-enter-equivalence",
      name: "Details open with click and Enter",
      targetUrl: fixtureServer.origin,
      allowedOrigins: [fixtureServer.origin],
      pointerActions: [
        { id: "click-open", kind: "click", target: { role: "button", name: "Open details" } }
      ],
      keyboardActions: [
        { id: "focus-open", kind: "focus", target: { role: "button", name: "Open details" } },
        { id: "press-enter", kind: "press", key: "Enter" }
      ],
      observe: { target: { selector: "#result" }, text: true },
      expected: { text: "Open" }
    });

    expect(comparison.equivalence.verdict).toBe("pass");
    expect(comparison.expectation?.verdict).toBe("pass");
    expect(comparison.lanes.keyboard.steps.map(({ action }) => action.id)).toEqual([
      "focus-open",
      "press-enter"
    ]);
    expect(
      comparison.lanes.keyboard.steps.every(({ artifactFiles }) => artifactFiles.length > 0)
    ).toBe(true);
    const enterStep = comparison.lanes.keyboard.steps.find(
      ({ action }) => action.id === "press-enter"
    );
    const enterReportPath = enterStep?.reporterFiles.find((filePath) =>
      filePath.endsWith("aee-report.json")
    );
    const enterReport = JSON.parse(await readFile(enterReportPath!, "utf8")) as JsonReport;
    expect(enterReport.judgments).toContainEqual(
      expect.objectContaining({
        judgeId: "keyboard",
        verdict: "pass",
        summary: expect.stringContaining('a live region announced "Open" (polite)')
      })
    );
  } finally {
    await fixtureServer.close();
  }
});

/**
 * The presses audit item A3 named, in Chrome. Each is judged from what the accessibility tree and
 * Guidepup's reader report; the markup diff is recorded beside it and decides nothing.
 */
const pressScenarios: Array<{
  title: string;
  html: string;
  /** What the page's own scripts do, each run in the page in turn. */
  scripts?: Array<() => void>;
  key: "Enter" | "Space";
  target: { role: string; name: string };
  verdict: "pass" | "unknown";
  summary: string;
  markupChanged: boolean;
}> = [
  {
    title:
      "Space on a native checkbox passes from its checked state, though the markup is unchanged",
    html: `<main><label><input id="pressed" type="checkbox"> Agree</label></main>`,
    key: "Space",
    target: { role: "checkbox", name: "Agree" },
    verdict: "pass",
    summary: 'checkbox "Agree" checked changed from false to true',
    markupChanged: false
  },
  {
    title:
      "Enter on an aria-expanded toggle passes from its expanded state and the panel it controls",
    html: `<main>
      <button id="pressed" type="button" aria-expanded="false" aria-controls="details">More</button>
      <div id="details" role="region" aria-label="Details" hidden>Shipping takes two days.</div>
    </main>`,
    scripts: [
      () => {
        const button = document.querySelector("#pressed")!;
        button.addEventListener("click", () => {
          button.setAttribute("aria-expanded", "true");
          (document.querySelector("#details") as HTMLElement).hidden = false;
        });
      }
    ],
    key: "Enter",
    target: { role: "button", name: "More" },
    verdict: "pass",
    summary:
      'button "More" expanded changed from false to true; region "Details" appeared, which button "More" controls',
    markupChanged: true
  },
  {
    title:
      "Enter on a button whose only effect is a polite status message passes from the announcement",
    html: `<main>
      <button id="pressed" type="button">Save</button>
      <p role="status" id="status"></p>
    </main>`,
    scripts: [
      () => {
        document.querySelector("#pressed")!.addEventListener("click", () => {
          document.querySelector("#status")!.textContent = "Saved";
        });
      }
    ],
    key: "Enter",
    target: { role: "button", name: "Save" },
    verdict: "pass",
    summary: 'a live region announced "Saved" (polite)',
    markupChanged: true
  },
  {
    title: "Enter on a dead button while a clock elsewhere ticks is not a pass",
    html: `<main>
      <button id="pressed" type="button">Save</button>
      <p id="clock">0</p>
    </main>`,
    scripts: [
      () => {
        let ticks = 0;
        setInterval(() => {
          document.querySelector("#clock")!.textContent = String((ticks += 1));
        }, 20);
      }
    ],
    key: "Enter",
    target: { role: "button", name: "Save" },
    verdict: "unknown",
    summary: "so whether the press caused it cannot be told",
    markupChanged: true
  },
  {
    title:
      "Enter on a dead button while a polite clock announces on its own is not a pass, and names the announcement",
    html: `<main>
      <button id="pressed" type="button">Save</button>
      <section aria-live="polite" aria-label="Clock" id="clock">10:00:00</section>
    </main>`,
    scripts: [startPoliteClock],
    key: "Enter",
    target: { role: "button", name: "Save" },
    verdict: "unknown",
    // Placed in the clock's region, or, if the clock ticked between the reader's and the tree's
    // captures, not placed; either way it is named and not counted.
    summary: "was already announcing on its own while",
    markupChanged: true
  },
  {
    title:
      "Enter on a button whose status message appears while a polite clock ticks still passes from the message",
    html: `<main>
      <button id="pressed" type="button">Save</button>
      <p role="status" id="status"></p>
      <section aria-live="polite" aria-label="Clock" id="clock">10:00:00</section>
    </main>`,
    scripts: [
      () => {
        document.querySelector("#pressed")!.addEventListener("click", () => {
          document.querySelector("#status")!.textContent = "Saved";
        });
      },
      startPoliteClock
    ],
    key: "Enter",
    target: { role: "button", name: "Save" },
    verdict: "pass",
    summary: 'a live region announced "Saved" (polite))',
    markupChanged: true
  }
];

/**
 * A polite live region that announces a new time ten times a second, with nobody touching the
 * page, so it also announces between the "before" and "after" captures of every press.
 */
function startPoliteClock(): void {
  let tenths = 0;
  setInterval(() => {
    tenths += 1;
    document.querySelector("#clock")!.textContent = `10:00:${(tenths / 10).toFixed(1)}`;
  }, 100);
}

for (const scenario of pressScenarios) {
  test(`runAeeOnPage: ${scenario.title}`, async ({ page }, testInfo) => {
    await page.setContent(scenario.html);
    for (const script of scenario.scripts ?? []) await page.evaluate(script);
    await page.focus("#pressed");

    const result = await runAeeOnPage({
      page,
      projectRoot: process.cwd(),
      outputDir: testInfo.outputPath("aee-press-response-output"),
      observers: ["focus", "dom", "accessibility-tree", "virtual-screen-reader"],
      virtualScreenReader: createPortableVirtualScreenReader(page),
      judges: ["keyboard", "change-response"],
      interaction: {
        kind: scenario.key === "Enter" ? "enter" : "space",
        actor: "test",
        target: scenario.target
      },
      async performInteraction({ page: interactionPage }) {
        await interactionPage.keyboard.press(scenario.key);
      }
    });

    const report = JSON.parse(
      await readFile(
        result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"))!,
        "utf8"
      )
    ) as JsonReport;
    expect(
      report.records.find(({ observerId, phase }) => observerId === "dom" && phase === "after")
        ?.meta?.changed
    ).toBe(scenario.markupChanged);
    for (const judgeId of ["keyboard", "change-response"]) {
      expect(report.judgments).toContainEqual(
        expect.objectContaining({
          judgeId,
          verdict: scenario.verdict,
          summary: expect.stringContaining(scenario.summary)
        })
      );
    }
  });
}

test("runAeeOnPage captures redacted network activity around an interaction", async ({
  page
}, testInfo) => {
  await page.route("https://aee.test/api/save?token=private-token", async (route) => {
    await route.fulfill({
      status: 200,
      headers: {
        "access-control-allow-origin": "*",
        "content-type": "application/json"
      },
      body: JSON.stringify({ ok: true })
    });
  });

  await page.setContent(`
    <main>
      <button id="save" type="button">Save</button>
      <p id="status">Idle</p>
    </main>
  `);
  await page.locator("#save").evaluate((button) => {
    button.addEventListener("click", async () => {
      await fetch("https://aee.test/api/save?token=private-token", {
        method: "POST",
        headers: {
          authorization: "Bearer private-authorization",
          "x-api-key": "private-api-key"
        },
        body: JSON.stringify({ email: "private@example.com" })
      });
      const status = document.querySelector("#status");

      if (status) {
        status.textContent = "Saved";
      }
    });
  });

  const outputBaseDir = testInfo.outputPath("aee-network-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["network"],
    judges: ["release"],
    checkpointName: "network-click",
    interaction: {
      kind: "click",
      actor: "test",
      target: {
        role: "button",
        name: "Save"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await Promise.all([
        interactionPage.waitForResponse("https://aee.test/api/save?token=private-token"),
        interactionPage.click("#save")
      ]);
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  expect(result.artifactFiles).toHaveLength(2);
  await expect(page.locator("#status")).toHaveText("Saved");

  const beforeLogPath = result.artifactFiles.find((filePath) =>
    filePath.endsWith("network-before.json")
  );
  const afterLogPath = result.artifactFiles.find((filePath) =>
    filePath.endsWith("network-after.json")
  );
  expect(beforeLogPath).toBeTruthy();
  expect(afterLogPath).toBeTruthy();

  const beforeLog = JSON.parse(await readFile(beforeLogPath!, "utf8")) as Array<
    Record<string, unknown>
  >;
  const afterLogContent = await readFile(afterLogPath!, "utf8");
  const afterLog = JSON.parse(afterLogContent) as Array<Record<string, unknown>>;

  expect(beforeLog).toHaveLength(0);
  expect(afterLog.length).toBeGreaterThanOrEqual(2);
  expect(afterLogContent).not.toMatch(
    /private-token|private-authorization|private-api-key|private@example\.com/
  );
  expect(afterLog).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "request",
        url: "https://aee.test/api/save?token=%5BREDACTED%5D",
        method: "POST",
        postData: "[REDACTED]"
      }),
      expect.objectContaining({
        kind: "response",
        url: "https://aee.test/api/save?token=%5BREDACTED%5D",
        status: 200,
        ok: true
      })
    ])
  );

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 1,
    fail: 0,
    unknown: 0
  });
  expect(report.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observerId: "network",
        phase: "before",
        status: "ok",
        meta: expect.objectContaining({
          eventCount: 0,
          interestingEventCount: 0,
          filteredNoiseCount: 0
        })
      }),
      expect.objectContaining({
        observerId: "network",
        phase: "after",
        status: "ok",
        meta: expect.objectContaining({
          eventCount: expect.any(Number),
          interestingEventCount: expect.any(Number),
          requestCount: expect.any(Number),
          responseCount: expect.any(Number),
          matchedResponseCount: expect.any(Number),
          newEventCount: expect.any(Number),
          newInterestingEventCount: expect.any(Number),
          newRequestCount: expect.any(Number),
          newResponseCount: expect.any(Number),
          newMatchedResponseCount: expect.any(Number),
          interestingUrls: expect.arrayContaining([
            "https://aee.test/api/save?token=%5BREDACTED%5D"
          ]),
          newInterestingUrls: expect.arrayContaining([
            "https://aee.test/api/save?token=%5BREDACTED%5D"
          ])
        })
      })
    ])
  );
});

test("runAeeOnPage fails change-response judging when a click produces no observable response", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <button id="save" type="button">Save</button>
      <p id="status">Idle</p>
    </main>
  `);

  const outputBaseDir = testInfo.outputPath("aee-click-no-response-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["dom", "accessibility-tree"],
    judges: ["change-response", "release"],
    checkpointName: "click-no-response",
    interaction: {
      kind: "click",
      actor: "test",
      target: {
        role: "button",
        name: "Save"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.click("#save");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  await expect(page.locator("#status")).toHaveText("Idle");

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 0,
    fail: 2,
    unknown: 0
  });
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "change-response",
        verdict: "fail",
        summary: expect.stringContaining("No observable response followed the click interaction"),
        suggestedFix: expect.stringContaining(
          "move focus to what it opens (not only onto the clicked control), announce the result in a live region (WCAG 4.1.3 Status Messages)"
        )
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "fail"
      })
    ])
  );
});

// A click focuses the clicked button (HTML's focusing steps), and Chrome focuses the page when the
// clicked element cannot take focus. Neither is the control responding.
const clickFocusScenarios: Array<{
  title: string;
  html: string;
  script?: () => void;
  verdict: "pass" | "fail";
  summary: string;
}> = [
  {
    title: "clicking a button that does nothing is not a pass, though the click focuses it",
    html: `<main><button id="clicked" type="button">Save</button></main>`,
    verdict: "fail",
    summary: 'Focus moved onto button "Save" itself, which a click on it does by itself'
  },
  {
    title: "clicking a dead element that cannot take focus is not a pass, though it blurs a field",
    html: `<main>
      <label>Name <input id="name"></label>
      <div id="clicked" role="button">Save</div>
    </main>`,
    script: () => (document.querySelector("#name") as HTMLInputElement).focus(),
    verdict: "fail",
    summary: "Focus moved to the page itself"
  },
  {
    title: "clicking a button that moves focus into the dialog it opens passes",
    html: `<main>
      <button id="clicked" type="button">Save</button>
      <div role="dialog" aria-label="Save changes?" hidden><button id="cancel">Cancel</button></div>
    </main>`,
    script: () => {
      document.querySelector("#clicked")!.addEventListener("click", () => {
        (document.querySelector("[role=dialog]") as HTMLElement).hidden = false;
        (document.querySelector("#cancel") as HTMLButtonElement).focus();
      });
    },
    verdict: "pass",
    summary: "focus moved"
  }
];

for (const scenario of clickFocusScenarios) {
  test(`runAeeOnPage: ${scenario.title}`, async ({ page }, testInfo) => {
    await page.setContent(scenario.html);
    if (scenario.script) await page.evaluate(scenario.script);

    const result = await runAeeOnPage({
      page,
      projectRoot: process.cwd(),
      outputDir: testInfo.outputPath("aee-click-focus-output"),
      observers: ["focus", "dom", "accessibility-tree"],
      judges: ["change-response"],
      interaction: { kind: "click", actor: "test", target: { role: "button", name: "Save" } },
      async performInteraction({ page: interactionPage }) {
        await interactionPage.click("#clicked");
      }
    });

    const report = JSON.parse(
      await readFile(
        result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"))!,
        "utf8"
      )
    ) as JsonReport;
    expect(report.judgments).toContainEqual(
      expect.objectContaining({
        judgeId: "change-response",
        verdict: scenario.verdict,
        summary: expect.stringContaining(scenario.summary)
      })
    );
  });
}

test("runAeeOnPage fails keyboard judging when space does not activate a custom button", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <div id="save" role="button" tabindex="0">Save</div>
      <p id="status">Idle</p>
    </main>
  `);
  await page.focus("#save");

  const outputBaseDir = testInfo.outputPath("aee-space-no-activation-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["focus", "dom", "accessibility-tree"],
    judges: ["keyboard", "change-response", "release"],
    checkpointName: "keyboard-space-no-activation",
    interaction: {
      kind: "space",
      actor: "test",
      target: {
        role: "button",
        name: "Save"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.keyboard.press("Space");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  await expect(page.locator("#status")).toHaveText("Idle");
  await expect(page.locator("#save")).toBeFocused();

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 0,
    fail: 3,
    unknown: 0
  });
  expect(report.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observerId: "dom",
        phase: "after",
        status: "ok",
        meta: expect.objectContaining({
          changed: false
        })
      })
    ])
  );
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "keyboard",
        verdict: "fail",
        summary: expect.stringContaining("no observable activation response"),
        suggestedFix: expect.stringContaining(
          "change the control's accessibility state (checked, expanded, pressed, selected, value or name) or that of what it names with aria-controls"
        )
      }),
      expect.objectContaining({
        judgeId: "change-response",
        verdict: "fail",
        summary: expect.stringContaining("No observable response followed the space interaction"),
        suggestedFix: expect.stringContaining("A change to the page's markup alone does not count.")
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "fail"
      })
    ])
  );
});

test("runAeeOnPage passes keyboard judging when arrow-right moves focus within a tablist", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <div role="tablist" aria-label="Sections">
        <button id="tab-overview" role="tab" aria-selected="true" tabindex="0">Overview</button>
        <button id="tab-pricing" role="tab" aria-selected="false" tabindex="-1">Pricing</button>
        <button id="tab-faq" role="tab" aria-selected="false" tabindex="-1">FAQ</button>
      </div>
      <p id="status">Overview</p>
    </main>
  `);
  await page.evaluate(() => {
    const tabs = Array.from(document.querySelectorAll<HTMLElement>('[role="tab"]'));
    const status = document.querySelector("#status");

    for (const [index, tab] of tabs.entries()) {
      tab.addEventListener("keydown", (event) => {
        if (event.key !== "ArrowRight") {
          return;
        }

        event.preventDefault();
        const nextIndex = (index + 1) % tabs.length;

        tabs.forEach((candidate, candidateIndex) => {
          candidate.setAttribute("aria-selected", candidateIndex === nextIndex ? "true" : "false");
          candidate.tabIndex = candidateIndex === nextIndex ? 0 : -1;
        });

        tabs[nextIndex]?.focus();

        if (status && tabs[nextIndex]?.textContent) {
          status.textContent = tabs[nextIndex].textContent;
        }
      });
    }
  });
  await page.focus("#tab-overview");

  const outputBaseDir = testInfo.outputPath("aee-arrow-tablist-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["focus"],
    judges: ["keyboard", "release"],
    checkpointName: "keyboard-arrow-tablist",
    interaction: {
      kind: "arrow-key",
      input: "ArrowRight",
      actor: "test",
      target: {
        role: "tab",
        name: "Overview"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.keyboard.press("ArrowRight");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  await expect(page.locator("#tab-pricing")).toBeFocused();
  await expect(page.locator("#status")).toHaveText("Pricing");

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 2,
    fail: 0,
    unknown: 0
  });
  expect(report.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observerId: "focus",
        phase: "after",
        status: "ok",
        meta: expect.objectContaining({
          focusTarget: expect.objectContaining({
            role: "tab",
            compositeRole: "tablist",
            compositeItemIndex: 1,
            compositeItemCount: 3
          })
        })
      })
    ])
  );
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "keyboard",
        verdict: "pass",
        summary: expect.stringContaining("tablist")
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "pass"
      })
    ])
  );
});

test("runAeeOnPage fails keyboard judging when arrow-right does not move focus within a tablist", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <div role="tablist" aria-label="Sections">
        <button id="tab-overview" role="tab" aria-selected="true" tabindex="0">Overview</button>
        <button id="tab-pricing" role="tab" aria-selected="false" tabindex="-1">Pricing</button>
        <button id="tab-faq" role="tab" aria-selected="false" tabindex="-1">FAQ</button>
      </div>
    </main>
  `);
  await page.focus("#tab-overview");

  const outputBaseDir = testInfo.outputPath("aee-arrow-tablist-stalled-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["focus"],
    judges: ["keyboard", "release"],
    checkpointName: "keyboard-arrow-tablist-stalled",
    interaction: {
      kind: "arrow-key",
      input: "ArrowRight",
      actor: "test",
      target: {
        role: "tab",
        name: "Overview"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.keyboard.press("ArrowRight");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  await expect(page.locator("#tab-overview")).toBeFocused();

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 0,
    fail: 2,
    unknown: 0
  });
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "keyboard",
        verdict: "fail",
        summary: expect.stringContaining("did not move focus within the tablist")
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "fail"
      })
    ])
  );
});

test("runAeeOnPage passes keyboard judging when arrow-down updates aria-activedescendant in a listbox", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <div
        id="city-listbox"
        role="listbox"
        tabindex="0"
        aria-label="Cities"
        aria-activedescendant="city-tel-aviv"
      >
        <div id="city-tel-aviv" role="option" aria-selected="true">Tel Aviv</div>
        <div id="city-haifa" role="option" aria-selected="false">Haifa</div>
        <div id="city-jerusalem" role="option" aria-selected="false">Jerusalem</div>
      </div>
      <p id="status">Tel Aviv</p>
    </main>
  `);
  await page.evaluate(() => {
    const listbox = document.querySelector<HTMLElement>("#city-listbox");
    const status = document.querySelector("#status");
    const options = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]'));

    listbox?.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowDown") {
        return;
      }

      event.preventDefault();
      const currentId = listbox.getAttribute("aria-activedescendant");
      const currentIndex = Math.max(
        0,
        options.findIndex((option) => option.id === currentId)
      );
      const nextIndex = (currentIndex + 1) % options.length;
      const nextOption = options[nextIndex];

      if (!nextOption) {
        return;
      }

      listbox.setAttribute("aria-activedescendant", nextOption.id);
      options.forEach((option, index) => {
        option.setAttribute("aria-selected", index === nextIndex ? "true" : "false");
      });

      if (status && nextOption.textContent) {
        status.textContent = nextOption.textContent;
      }
    });
  });
  await page.focus("#city-listbox");

  const outputBaseDir = testInfo.outputPath("aee-activedescendant-listbox-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["focus"],
    judges: ["keyboard", "release"],
    checkpointName: "keyboard-activedescendant-listbox",
    interaction: {
      kind: "arrow-key",
      input: "ArrowDown",
      actor: "test",
      target: {
        role: "option",
        name: "Tel Aviv"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.keyboard.press("ArrowDown");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  await expect(page.locator("#city-listbox")).toBeFocused();
  await expect(page.locator("#status")).toHaveText("Haifa");

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 2,
    fail: 0,
    unknown: 0
  });
  expect(report.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observerId: "focus",
        phase: "after",
        status: "ok",
        meta: expect.objectContaining({
          focusTarget: expect.objectContaining({
            role: "listbox",
            activeDescendantId: "city-haifa",
            activeDescendant: expect.objectContaining({
              role: "option",
              compositeRole: "listbox",
              compositeItemIndex: 1,
              compositeItemCount: 3
            })
          })
        })
      })
    ])
  );
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "keyboard",
        verdict: "pass",
        summary: expect.stringContaining("listbox")
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "pass"
      })
    ])
  );
});

test("runAeeOnPage fails keyboard judging when aria-activedescendant does not change in a listbox", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <div
        id="city-listbox"
        role="listbox"
        tabindex="0"
        aria-label="Cities"
        aria-activedescendant="city-tel-aviv"
      >
        <div id="city-tel-aviv" role="option" aria-selected="true">Tel Aviv</div>
        <div id="city-haifa" role="option" aria-selected="false">Haifa</div>
        <div id="city-jerusalem" role="option" aria-selected="false">Jerusalem</div>
      </div>
    </main>
  `);
  await page.focus("#city-listbox");

  const outputBaseDir = testInfo.outputPath("aee-activedescendant-listbox-stalled-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["focus"],
    judges: ["keyboard", "release"],
    checkpointName: "keyboard-activedescendant-listbox-stalled",
    interaction: {
      kind: "arrow-key",
      input: "ArrowDown",
      actor: "test",
      target: {
        role: "option",
        name: "Tel Aviv"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.keyboard.press("ArrowDown");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  await expect(page.locator("#city-listbox")).toBeFocused();

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 0,
    fail: 2,
    unknown: 0
  });
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "keyboard",
        verdict: "fail",
        summary: expect.stringContaining("listbox")
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "fail"
      })
    ])
  );
});

test("runAeeOnPage can capture focus movement around a tab interaction", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <button id="first">First</button>
      <button id="second">Second</button>
    </main>
  `);
  await page.focus("#first");

  const outputBaseDir = testInfo.outputPath("aee-keyboard-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["dom", "focus"],
    judges: ["keyboard", "release"],
    checkpointName: "keyboard-tab",
    interaction: {
      kind: "tab",
      actor: "test",
      target: {
        role: "button",
        name: "First"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.keyboard.press("Tab");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  expect(result.artifactFiles).toHaveLength(4);
  await expect(page.locator("#second")).toBeFocused();

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 2,
    fail: 0,
    unknown: 0
  });
  expect(report.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observerId: "focus",
        phase: "before",
        status: "ok",
        meta: expect.objectContaining({
          focusTarget: expect.objectContaining({
            focusOrderIndex: 0,
            focusableCount: 2
          })
        })
      }),
      expect.objectContaining({
        observerId: "focus",
        phase: "after",
        status: "ok",
        meta: expect.objectContaining({
          focusTarget: expect.objectContaining({
            focusOrderIndex: 1,
            focusableCount: 2,
            captureType: "deep-focus-state",
            documentActiveElement: expect.objectContaining({ id: "second" }),
            deepActiveElement: expect.objectContaining({ id: "second", focusVisible: true }),
            activeElementChain: [expect.objectContaining({ context: "document", id: "second" })],
            accessibilityFocus: expect.objectContaining({
              status: "matched",
              role: "button",
              name: "Second"
            })
          })
        })
      })
    ])
  );
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "keyboard",
        verdict: "pass"
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "pass"
      })
    ])
  );
});

test("runAeeOnPage captures the deepest active element through a shadow root", async ({
  page
}, testInfo) => {
  await page.setContent(`<main><button id="before">Before</button><div id="host"></div></main>`);
  await page.evaluate(() => {
    const host = document.querySelector("#host")!;
    host.attachShadow({ mode: "open" }).innerHTML =
      `<button id="shadow-action">Shadow action</button>`;
  });
  await page.focus("#before");

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: testInfo.outputPath("deep-focus-output"),
    observers: ["focus", "accessibility-tree"],
    judges: ["release"],
    checkpointName: "shadow-focus",
    interaction: { kind: "focus", actor: "test" },
    async performInteraction() {
      await page.evaluate(() => {
        (
          document.querySelector("#host")!.shadowRoot!.querySelector("button") as HTMLElement
        ).focus();
      });
    }
  });
  const reportPath = result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"));
  const report = JSON.parse(await readFile(reportPath!, "utf8")) as JsonReport;
  const afterFocus = report.records.find(
    ({ observerId, phase }) => observerId === "focus" && phase === "after"
  );

  expect(afterFocus?.meta?.focusTarget).toEqual(
    expect.objectContaining({
      id: "shadow-action",
      documentActiveElement: expect.objectContaining({ id: "host" }),
      deepActiveElement: expect.objectContaining({ id: "shadow-action" }),
      activeElementChain: [
        expect.objectContaining({ context: "document", id: "host" }),
        expect.objectContaining({ context: "shadow-root", id: "shadow-action" })
      ],
      accessibilityFocus: expect.objectContaining({ status: "matched", name: "Shadow action" })
    })
  );
});

test("runAeeOnPage captures the deepest active element in a same-origin frame", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <button id="before">Before</button>
    <iframe id="payment-frame" srcdoc='<button id="inside">Review invoice</button>'></iframe>
  `);
  const childFrame = page.frames().find((frame) => frame !== page.mainFrame())!;
  await childFrame.locator("#inside").waitFor();
  await page.focus("#before");

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: testInfo.outputPath("frame-focus-output"),
    observers: ["focus"],
    judges: ["release"],
    checkpointName: "frame-focus",
    interaction: { kind: "focus", actor: "test" },
    async performInteraction() {
      await childFrame.focus("#inside");
    }
  });
  const reportPath = result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"));
  const report = JSON.parse(await readFile(reportPath!, "utf8")) as JsonReport;
  const afterFocus = report.records.find(
    ({ observerId, phase }) => observerId === "focus" && phase === "after"
  );

  expect(afterFocus?.meta?.focusTarget).toEqual(
    expect.objectContaining({
      id: "inside",
      documentActiveElement: expect.objectContaining({ id: "payment-frame" }),
      deepActiveElement: expect.objectContaining({ id: "inside" }),
      activeElementChain: [
        expect.objectContaining({ context: "document", id: "payment-frame" }),
        expect.objectContaining({ context: "iframe-document", id: "inside" })
      ]
    })
  );
});

test("runAeeOnPage verifies focus moves inside an opened dialog", async ({ page }, testInfo) => {
  await page.setContent(`
    <button id="open-dialog" type="button">Delete Project Alpha</button>
    <div id="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title" hidden>
      <h2 id="dialog-title">Delete Project Alpha?</h2>
      <button id="cancel" type="button">Cancel</button>
      <button type="button">Delete project</button>
    </div>
    <script>
      document.querySelector("#open-dialog").addEventListener("click", () => {
        document.querySelector("#dialog").hidden = false;
        document.querySelector("#cancel").focus();
      });
    </script>
  `);
  await page.focus("#open-dialog");

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: testInfo.outputPath("aee-dialog-focus-output"),
    observers: ["dom", "focus"],
    judges: ["focus-management", "change-response", "release"],
    checkpointName: "dialog-initial-focus",
    interaction: {
      kind: "click",
      actor: "test",
      target: { role: "button", name: "Delete Project Alpha" },
      meta: { focusExpectation: "inside-dialog" }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.getByRole("button", { name: "Delete Project Alpha" }).click();
    }
  });

  await expect(page.getByRole("button", { name: "Cancel" })).toBeFocused();
  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;

  expect(report.run.results).toEqual({ pass: 3, fail: 0, unknown: 0 });
  expect(report.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observerId: "focus",
        phase: "after",
        meta: expect.objectContaining({
          focusTarget: expect.objectContaining({
            id: "cancel",
            dialogContext: expect.objectContaining({
              id: "dialog",
              role: "dialog",
              name: "Delete Project Alpha?",
              modal: true
            })
          })
        })
      })
    ])
  );
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ judgeId: "focus-management", verdict: "pass" }),
      expect.objectContaining({ judgeId: "release", verdict: "pass" })
    ])
  );
});

test("runAeeOnPage can capture backward focus movement around a shift-tab interaction", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <button id="first">First</button>
      <button id="second">Second</button>
      <button id="third">Third</button>
    </main>
  `);
  await page.focus("#second");

  const outputBaseDir = testInfo.outputPath("aee-shift-tab-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["focus"],
    judges: ["keyboard", "release"],
    checkpointName: "keyboard-shift-tab",
    interaction: {
      kind: "shift-tab",
      actor: "test",
      target: {
        role: "button",
        name: "Second"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.keyboard.press("Shift+Tab");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  expect(result.artifactFiles).toHaveLength(2);
  await expect(page.locator("#first")).toBeFocused();

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 2,
    fail: 0,
    unknown: 0
  });
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "keyboard",
        verdict: "pass"
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "pass"
      })
    ])
  );
});

test("runAeeOnPage leaves undecided a tab that moves focus against the predicted tab order", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
      <button id="first">First</button>
      <button id="second">Second</button>
      <button id="third">Third</button>
    </main>
  `);
  await page.evaluate(() => {
    window.addEventListener(
      "keydown",
      (event) => {
        if (event.key === "Tab" && !event.shiftKey) {
          event.preventDefault();
          const target = document.querySelector<HTMLElement>("#first");
          target?.focus();
        }
      },
      { once: true }
    );
  });
  await page.focus("#second");

  const outputBaseDir = testInfo.outputPath("aee-tab-wrong-direction-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["focus"],
    judges: ["keyboard", "release"],
    checkpointName: "keyboard-tab-wrong-direction",
    interaction: {
      kind: "tab",
      actor: "test",
      target: {
        role: "button",
        name: "Second"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.keyboard.press("Tab");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  expect(result.artifactFiles).toHaveLength(2);
  await expect(page.locator("#first")).toBeFocused();

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  // The browser's Tab is what a user gets and the predicted order a model of it, so a
  // disagreement is left for review rather than failed (audit A4).
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "keyboard",
        verdict: "unknown",
        summary: expect.stringContaining("disagrees with the tab order AEE predicts")
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "unknown"
      })
    ])
  );
});

// The roadmap once put each milestone title inside its summary, bold and 10% larger than the body
// text: a sighted reader scans for those titles, and a screen reader's heading key skips them.
const summaryTitlesPage = `<!doctype html>
<html lang="en">
  <head>
    <title>Roadmap</title>
    <style>
      summary { display: flex; gap: 0.75rem; }
      .title { font-weight: 700; font-size: 1.1rem; }
    </style>
  </head>
  <body>
    <main>
      <h1>Roadmap</h1>
      <p>Each milestone opens to show its steps and how far they have got.</p>
      <details open>
        <summary><span>M1</span><span class="title">Knowledge link</span><span>0/4</span></summary>
        <p>Link each finding to the pattern that explains how to build it right.</p>
      </details>
      <details open>
        <summary><span>M2</span><span class="title">Known-answer tests</span><span>1/3</span></summary>
        <p>Pages with known issues, and the same pages with every issue fixed.</p>
      </details>
    </main>
  </body>
</html>`;

test("aee run flags titles styled as headings with no heading role, as advisory results", async ({
  browser
}, testInfo) => {
  const server = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(summaryTitlesPage);
  });
  try {
    const result = await runApprovedScenario(
      browser,
      `schemaVersion: 0.1.0
id: summary-titles
target:
  url: ${server.origin}/
standard:
  name: WCAG
  version: "2.2"
  levels: [A, AA]
profile: core
goal: Find each milestone by its title.
journeys:
  - id: milestones
    name: Milestones
    goal: Move between the milestones.
    startPath: /
    allowedActions: [focus]
    forbiddenActions: [submit-forms]
    virtualScreenReaderCommands: [start]
approval:
  required: true
`,
      testInfo
    );
    const report = JSON.parse(await readFile(result.reportFiles.json, "utf8")) as {
      verdict: string;
      synthesis: {
        status: Array<{ id: string; verdict: string; detail: string }>;
        findings: Array<{ ruleId: string; advisory: boolean; instances: Array<{ label: string }> }>;
      };
    };

    expect(report.synthesis.findings).toEqual([
      expect.objectContaining({
        ruleId: "looks-like-heading",
        advisory: true,
        instances: [
          expect.objectContaining({ label: "Knowledge link" }),
          expect.objectContaining({ label: "Known-answer tests" })
        ]
      })
    ]);
    // A heuristic about what the author meant is shown, but it never blocks release.
    expect(report.synthesis.status.find(({ id }) => id === "semantics")).toMatchObject({
      verdict: "pass",
      detail: expect.stringContaining("Advisory: Looks like a heading, but is not one")
    });
    expect(report.verdict).toBe("pass");
    expect(await readFile(result.reportFiles.html, "utf8")).toContain(
      '<span class="badge unknown">2 advisory</span>'
    );
  } finally {
    await server.close();
  }
});

// A title styled as a heading, a table whose cells have no headers, and an image with no text.
const startPageOnlyPage = `<!doctype html>
<html lang="en">
  <head>
    <title>Prices</title>
  </head>
  <body>
    <main>
      <p style="font-size: 1.6em; font-weight: bold">Price list</p>
      <table>
        <caption>Prices</caption>
        <tr><td>Item</td><td>Price</td></tr>
        <tr><td>Tea</td><td>2</td></tr>
      </table>
      <img src="/chart.png" width="80" height="40">
    </main>
  </body>
</html>`;

test("aee run checks the start page with axe when a journey has no reader commands", async ({
  browser
}, testInfo) => {
  const server = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(startPageOnlyPage);
  });
  try {
    const result = await runApprovedScenario(
      browser,
      `schemaVersion: 0.1.0
id: start-page-only
target:
  url: ${server.origin}/
standard:
  name: WCAG
  version: "2.2"
  levels: [A, AA]
profile: core
goal: Read the price list.
journeys:
  - id: prices
    name: Prices
    goal: Read the price list.
    startPath: /
    allowedActions: [focus]
    forbiddenActions: [submit-forms]
approval:
  required: true
`,
      testInfo
    );
    const report = JSON.parse(await readFile(result.reportFiles.json, "utf8")) as {
      verdict: string;
      completeness: { status: string; plannedLanes: number; completedLanes: number };
      actions: Array<{ laneId: string; driver: string; actionId: string }>;
      artifacts: Array<{ kind: string; path: string }>;
      synthesis: {
        findings: Array<{
          ruleId: string;
          advisory: boolean;
          checkpoints: Array<{ laneId: string; actionId: string }>;
        }>;
      };
    };

    // The plan's "run the pinned WCAG rule selection" runs on the start page itself, with no
    // reader command or authored action to carry it.
    expect(report.actions).toEqual([
      expect.objectContaining({
        laneId: "prices-start-page",
        driver: "page-load",
        actionId: "checkpoint-1-start-page"
      })
    ]);
    expect(report.artifacts.filter(({ kind }) => kind === "axe-result")).not.toEqual([]);
    expect(report.completeness).toMatchObject({
      status: "complete",
      plannedLanes: 2,
      completedLanes: 2
    });
    expect(report.synthesis.findings).toContainEqual(
      expect.objectContaining({
        ruleId: "image-alt",
        advisory: false,
        checkpoints: [
          expect.objectContaining({
            laneId: "prices-start-page",
            actionId: "checkpoint-1-start-page"
          })
        ]
      })
    );
    expect(report.verdict).toBe("fail");
    expect(result.headline).toMatch(/^release blocked, \d+ fix(es)? needed$/);
  } finally {
    await server.close();
  }
});
