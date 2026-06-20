import { access, readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { runAeeOnPage } from "@aee/playwright";

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
    };
  }>;
  judgments: Array<{
    judgeId: string;
    verdict: string;
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
  expect(result.artifactFiles).toHaveLength(4);

  await Promise.all([
    ...result.reporterFiles.map((filePath) => access(filePath)),
    ...result.artifactFiles.map((filePath) => access(filePath))
  ]);

  const jsonReportPath = result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"));
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 2,
    fail: 0,
    unknown: 0
  });
  expect(report.records).toHaveLength(4);
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

test("runAeeOnPage can capture focus movement around a tab interaction", async ({ page }, testInfo) => {
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

  const jsonReportPath = result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"));
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
        status: "ok"
      }),
      expect.objectContaining({
        observerId: "focus",
        phase: "after",
        status: "ok"
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
