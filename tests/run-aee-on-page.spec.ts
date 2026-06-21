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
      byteLength?: number;
      eventCount?: number;
      focusOrderIndex?: number;
      focusableCount?: number;
    };
  }>;
  judgments: Array<{
    judgeId: string;
    verdict: string;
    summary?: string;
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

test("runAeeOnPage can capture screenshots around a click interaction", async ({ page }, testInfo) => {
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
  expect(result.artifactFiles).toHaveLength(2);
  await expect(page.locator("#status")).toHaveText("Saved");

  const screenshotBuffers = await Promise.all(result.artifactFiles.map((filePath) => readFile(filePath)));
  for (const [index, screenshotBuffer] of screenshotBuffers.entries()) {
    expect(result.artifactFiles[index]?.endsWith(".png")).toBe(true);
    expect(screenshotBuffer.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    );
  }

  const jsonReportPath = result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"));
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
          byteLength: expect.any(Number)
        })
      }),
      expect.objectContaining({
        observerId: "visual",
        phase: "after",
        status: "ok",
        meta: expect.objectContaining({
          byteLength: expect.any(Number)
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

test("runAeeOnPage can capture network activity around an interaction", async ({ page }, testInfo) => {
  await page.route("https://aee.test/api/save", async (route) => {
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
      await fetch("https://aee.test/api/save");
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
        interactionPage.waitForResponse("https://aee.test/api/save"),
        interactionPage.click("#save")
      ]);
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  expect(result.artifactFiles).toHaveLength(2);
  await expect(page.locator("#status")).toHaveText("Saved");

  const beforeLogPath = result.artifactFiles.find((filePath) => filePath.endsWith("network-before.json"));
  const afterLogPath = result.artifactFiles.find((filePath) => filePath.endsWith("network-after.json"));
  expect(beforeLogPath).toBeTruthy();
  expect(afterLogPath).toBeTruthy();

  const beforeLog = JSON.parse(await readFile(beforeLogPath!, "utf8")) as Array<Record<string, unknown>>;
  const afterLog = JSON.parse(await readFile(afterLogPath!, "utf8")) as Array<Record<string, unknown>>;

  expect(beforeLog).toHaveLength(0);
  expect(afterLog.length).toBeGreaterThanOrEqual(2);
  expect(afterLog).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "request",
        url: "https://aee.test/api/save",
        method: "GET"
      }),
      expect.objectContaining({
        kind: "response",
        url: "https://aee.test/api/save",
        status: 200,
        ok: true
      })
    ])
  );

  const jsonReportPath = result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"));
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
          eventCount: 0
        })
      }),
      expect.objectContaining({
        observerId: "network",
        phase: "after",
        status: "ok",
        meta: expect.objectContaining({
          eventCount: expect.any(Number)
        })
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
            focusableCount: 2
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

test("runAeeOnPage can capture backward focus movement around a shift-tab interaction", async ({ page }, testInfo) => {
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

  const jsonReportPath = result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"));
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

test("runAeeOnPage fails keyboard judging when tab moves focus backward", async ({ page }, testInfo) => {
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

  const jsonReportPath = result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"));
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
        summary: expect.stringContaining("wrong direction")
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "fail"
      })
    ])
  );
});
