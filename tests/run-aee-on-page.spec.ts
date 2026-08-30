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
  expect(result.artifactFiles).toHaveLength(2);
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

test("runAeeOnPage passes keyboard judging when enter activates a focused button", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
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
    });
  });
  await page.focus("#save");

  const outputBaseDir = testInfo.outputPath("aee-enter-activation-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["focus", "dom"],
    judges: ["keyboard", "change-response", "release"],
    checkpointName: "keyboard-enter-activation",
    interaction: {
      kind: "enter",
      actor: "test",
      target: {
        role: "button",
        name: "Save"
      }
    },
    async performInteraction({ page: interactionPage }) {
      await interactionPage.keyboard.press("Enter");
    }
  });

  expect(result.reporterFiles).toHaveLength(2);
  await expect(page.locator("#status")).toHaveText("Saved");
  await expect(page.locator("#save")).toBeFocused();

  const jsonReportPath = result.reporterFiles.find((filePath) =>
    filePath.endsWith("aee-report.json")
  );
  expect(jsonReportPath).toBeTruthy();

  const report = JSON.parse(await readFile(jsonReportPath!, "utf8")) as JsonReport;
  expect(report.run.status).toBe("completed");
  expect(report.run.results).toEqual({
    pass: 3,
    fail: 0,
    unknown: 0
  });
  expect(report.records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        observerId: "dom",
        phase: "after",
        status: "ok",
        meta: expect.objectContaining({
          changed: true,
          previousByteLength: expect.any(Number)
        })
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
        verdict: "pass",
        summary: expect.stringContaining("DOM changed")
      }),
      expect.objectContaining({
        judgeId: "change-response",
        verdict: "pass",
        summary: expect.stringContaining("enter interaction")
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "pass"
      })
    ])
  );
});

test("runAeeOnPage passes change-response judging when a click updates the DOM", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main>
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
    });
  });

  const outputBaseDir = testInfo.outputPath("aee-click-response-output");
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: outputBaseDir,
    observers: ["dom"],
    judges: ["change-response", "release"],
    checkpointName: "click-response",
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
  await expect(page.locator("#status")).toHaveText("Saved");

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
        observerId: "dom",
        phase: "after",
        status: "ok",
        meta: expect.objectContaining({
          changed: true
        })
      })
    ])
  );
  expect(report.judgments).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        judgeId: "change-response",
        verdict: "pass",
        summary: expect.stringContaining("DOM changed")
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "pass"
      })
    ])
  );
});

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
    observers: ["dom"],
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
        summary: expect.stringContaining("No observable response followed the click interaction")
      }),
      expect.objectContaining({
        judgeId: "release",
        verdict: "fail"
      })
    ])
  );
});

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
    observers: ["focus", "dom"],
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
        summary: expect.stringContaining("no observable activation response")
      }),
      expect.objectContaining({
        judgeId: "change-response",
        verdict: "fail",
        summary: expect.stringContaining("No observable response followed the space interaction")
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

test("runAeeOnPage fails keyboard judging when tab moves focus backward", async ({
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
