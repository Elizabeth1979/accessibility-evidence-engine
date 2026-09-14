import { access, readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  createPortableVirtualScreenReader,
  runInputComparison,
  runAeeOnPage,
  runVirtualScreenReaderLane
} from "@aee/playwright";

async function startHtmlServer(
  handler: Parameters<typeof createServer>[0]
): Promise<{ origin: string; close(): Promise<void> }> {
  const server: Server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
    }
  };
}

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

test("runAeeOnPage preserves raw axe 4.13 WCAG results", async ({ page }, testInfo) => {
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

  expect(result.artifactFiles).toHaveLength(2);
  const rawResults = await Promise.all(
    result.artifactFiles.map(async (filePath) => JSON.parse(await readFile(filePath, "utf8")))
  );

  for (const rawResult of rawResults) {
    expect(rawResult.testEngine.version).toBe("4.13.0");
    expect(rawResult.violations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "button-name" })])
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
          announcement: "Invoices, heading, level 1",
          domFocusBefore: "#pay",
          domFocusAfter: "#pay",
          focusMoved: false
        })
      ]
    })
  );
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
  expect((await reader.command("next-heading")).announcement).toBe("Dashboard, heading, level 1");
  expect((await reader.command("next-heading")).announcement).toBe("Invoices, heading, level 2");
  expect((await reader.command("previous-heading")).announcement).toBe(
    "Dashboard, heading, level 1"
  );
  expect((await reader.command("next-landmark")).announcement).toBe("Account, navigation");
  expect((await reader.command("next-control")).announcement).toBe("Profile, link");
  expect((await reader.command("read-current")).announcement).toBe("Profile, link");
  expect((await reader.command("previous-item")).item?.role).toBe("navigation");
  expect((await reader.command("next-item")).item?.role).toBe("link");
  await expect(page.locator("#stable-focus")).toBeFocused();

  const transcript = await reader.snapshot();
  expect(transcript.entries).toHaveLength(9);
  expect(transcript.entries.every(({ focusMoved }) => !focusMoved)).toBe(true);
});

test("virtual-reader lane owns an isolated context and recaptures every command", async ({
  browser
}, testInfo) => {
  const fixtureServer = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(`
      <!doctype html>
      <html lang="en">
        <head><title>Lane fixture</title></head>
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
      "Invoices, heading, level 1",
      "Pay invoice, button"
    ]);
    expect(lane.transcript.entries.every(({ focusMoved }) => !focusMoved)).toBe(true);
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
    }
    await access(comparison.traceFile);
    await access(comparison.manifestFile);
    const manifest = JSON.parse(await readFile(comparison.manifestFile, "utf8"));
    expect(manifest.status).toBe("completed");
    expect(manifest.summary.available).toBe(39);
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
          <p id="result">Closed</p>
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
  } finally {
    await fixtureServer.close();
  }
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
              ariaModal: true
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
