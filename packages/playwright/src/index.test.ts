import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { EvidenceRecord, Judgment } from "@aee/core";
import { assertValidSchema } from "@aee/schemas";

import {
  aggregateEvidenceManifests,
  announcedWithoutName,
  comparePointerAndKeyboardOutcomes,
  enableExperimentalAxeRules,
  framesInsideOrigins,
  measureAgainstPixels,
  resolveObserverIdsForCapturePolicy,
  renderInteractionVideoCaptions,
  renderPortableVirtualScreenReaderTranscript,
  persistInteractionVideo,
  prepareAggregateManifest,
  runAeeOnPage,
  runInputComparison,
  runKeyboardPointerSweepLane,
  runStartPageLane,
  toSafeId,
  writeEvidenceManifest,
  verifyMotionControl,
  type CdpSession,
  type PageFrame,
  type PlaywrightPageLike
} from "./index";

test("enableExperimentalAxeRules switches on axe's experimental rules filed under WCAG A/AA", () => {
  const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];

  // axe-core 4.14's four (4.14 made label-content-name-mismatch a default rule); its
  // experimental best-practice rules stay off.
  assert.deepEqual(enableExperimentalAxeRules(wcagTags), {
    "css-orientation-lock": { enabled: true },
    "p-as-heading": { enabled: true },
    "table-fake-caption": { enabled: true },
    "td-has-header": { enabled: true }
  });
  assert.deepEqual(enableExperimentalAxeRules([]), {});
});

interface JsonReport {
  run: {
    config?: Record<string, unknown>;
  };
  records: EvidenceRecord[];
  judgments: Judgment[];
  artifacts: Array<{
    kind: string;
  }>;
}

/**
 * A page with one toggle button, "Save", whose pressed state Chrome's accessibility tree reports
 * as CDP's `Accessibility.getFullAXTree` does.
 */
function createTogglePage(): PlaywrightPageLike & { press: () => void } {
  let pressed = false;
  const html = () =>
    `<main><button id="save" type="button" aria-pressed="${pressed}">Save</button></main>`;

  return {
    url() {
      return "https://example.com/settings";
    },
    async content() {
      return html();
    },
    async snapshotAccessibilityTree() {
      return {
        nodes: [
          {
            nodeId: "7",
            ignored: false,
            role: { type: "role", value: "button" },
            name: { type: "computedString", value: "Save" },
            properties: [{ name: "pressed", value: { type: "tristate", value: String(pressed) } }],
            backendDOMNodeId: 7
          }
        ]
      };
    },
    press() {
      pressed = true;
    }
  };
}

function getJsonReport(content: string): JsonReport {
  return JSON.parse(content) as JsonReport;
}

function getReporterContent(result: Awaited<ReturnType<typeof runAeeOnPage>>): JsonReport {
  const artifact = result.reportArtifacts.find(
    (candidate) => candidate.label === "aee-report.json"
  );

  assert.ok(artifact, "Expected a JSON reporter artifact.");
  return getJsonReport(artifact.content);
}

test("framesInsideOrigins leaves out frames from another site and every frame inside them", () => {
  const session = {} as CdpSession;
  const frame = (frameId: string, url: string, parentFrameId?: string): PageFrame => ({
    frameId,
    url,
    session,
    ...(parentFrameId ? { parentFrameId } : {})
  });
  const page = {
    frames: [
      frame("top", "https://example.com/"),
      frame("ours", "https://example.com/panel", "top"),
      // Written by the frame that holds it, so it goes with that frame.
      frame("written", "about:srcdoc", "ours"),
      frame("data", "data:text/html,<p>Hi</p>", "top"),
      frame("away", "https://elsewhere.test/", "top"),
      frame("inside-away", "https://example.com/inner", "away"),
      frame("written-away", "about:blank", "away"),
      frame("failed", "chrome-error://chromewebdata/", "top")
    ],
    framesNotRead: []
  };

  const read = framesInsideOrigins(page, ["https://example.com"]);

  assert.deepEqual(
    read.frames.map(({ frameId }) => frameId),
    ["top", "ours", "written", "data"]
  );
  assert.deepEqual(read.framesNotRead, [
    {
      url: "https://elsewhere.test/",
      reason:
        "It shows a page from https://elsewhere.test, which is not an allowed origin; add it to them to check this frame."
    },
    { url: "https://example.com/inner", reason: "It is inside a frame that was not read." },
    { url: "about:blank", reason: "It is inside a frame that was not read." },
    {
      url: "chrome-error://chromewebdata/",
      reason: "It shows Chrome's error page: its page did not load, or was stopped."
    }
  ]);
});

test("comparePointerAndKeyboardOutcomes detects inaccessible hover-only behavior", async () => {
  let visibleText = "";
  const comparison = await comparePointerAndKeyboardOutcomes({
    async reset() {
      visibleText = "";
    },
    async performPointerInteraction() {
      visibleText = "Revenue increased 18 percent";
    },
    async performKeyboardInteraction() {},
    async captureOutcome() {
      return { visibleText };
    }
  });

  assert.equal(comparison.verdict, "fail");
  assert.deepEqual(comparison.pointerOutcome, {
    visibleText: "Revenue increased 18 percent"
  });
  assert.deepEqual(comparison.keyboardOutcome, { visibleText: "" });
});

test("comparePointerAndKeyboardOutcomes passes equivalent interaction outcomes", async () => {
  let expanded = false;
  const comparison = await comparePointerAndKeyboardOutcomes({
    async reset() {
      expanded = false;
    },
    async performPointerInteraction() {
      expanded = true;
    },
    async performKeyboardInteraction() {
      expanded = true;
    },
    async captureOutcome() {
      return { expanded };
    }
  });

  assert.equal(comparison.verdict, "pass");
});

test("runInputComparison saves a deterministic trace for declared click and Enter paths", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aee-input-comparison-"));
  let closedContexts = 0;
  const browser = {
    async newContext() {
      let focusedSelector: string | undefined;
      let resultText = "Closed";
      const nodes = new Map<string, { ownerDocument: { activeElement: unknown } }>();
      const nodeFor = (selector: string) => {
        const node = nodes.get(selector) ?? { ownerDocument: { activeElement: undefined } };
        node.ownerDocument.activeElement = focusedSelector === selector ? node : undefined;
        nodes.set(selector, node);
        return node;
      };
      const locatorFor = (selector: string) => ({
        async hover() {},
        async click() {
          if (selector === "#open") resultText = "Open";
        },
        async focus() {
          focusedSelector = selector;
        },
        async isVisible() {
          return true;
        },
        async textContent() {
          return selector === "#result" ? `  ${resultText}\n` : "Open details";
        },
        async getAttribute(name: string) {
          return name === "data-state" ? resultText.toLowerCase() : null;
        },
        async evaluate<T>(callback: (node: { ownerDocument: { activeElement: unknown } }) => T) {
          return callback(nodeFor(selector));
        }
      });
      const page = {
        url() {
          return "https://example.com/invoices";
        },
        async goto() {},
        async content() {
          return `<button id="open">Open details</button><p id="result">${resultText}</p>`;
        },
        video() {
          return {
            async saveAs(filePath: string) {
              await writeFile(filePath, new Uint8Array([26, 45, 223, 163]));
            },
            async delete() {}
          };
        },
        locator: locatorFor,
        getByRole() {
          return locatorFor("#open");
        },
        keyboard: {
          async press(key: string) {
            if (key === "Enter" && focusedSelector === "#open") resultText = "Open";
          }
        },
        async snapshotScreenshot() {
          return new Uint8Array([1]);
        },
        async snapshotAccessibilityTree() {
          return { role: "WebArea", name: "Invoices" };
        },
        async snapshotFocusTarget() {
          return focusedSelector ? { id: "open", role: "button", name: "Open details" } : null;
        },
        async runAxeAnalysis() {
          return {
            testEngine: { name: "axe-core", version: "4.14.0" },
            testRunner: { name: "axe" },
            testEnvironment: { userAgent: "unit-test" },
            toolOptions: { runOnly: { type: "tag", values: ["wcag22aa"] } },
            timestamp: "2026-09-14T00:00:00.000Z",
            url: "https://example.com/invoices",
            violations: [],
            passes: [],
            incomplete: [],
            inapplicable: []
          };
        }
      };

      return {
        async newPage() {
          return page;
        },
        async storageState() {
          return { cookies: [], origins: [] };
        },
        async close() {
          closedContexts += 1;
        }
      };
    }
  };

  try {
    const result = await runInputComparison({
      browser,
      projectRoot: tempRoot,
      comparisonId: "unit-click-enter",
      name: "Open details with click and Enter",
      targetUrl: "https://example.com/invoices",
      allowedOrigins: ["https://example.com"],
      pointerActions: [{ id: "click-open", kind: "click", target: { selector: "#open" } }],
      keyboardActions: [
        { id: "focus-open", kind: "focus", target: { selector: "#open" } },
        { id: "press-enter", kind: "press", key: "Enter" }
      ],
      observe: {
        target: { selector: "#result" },
        url: true,
        text: true,
        attributes: ["data-state"]
      },
      expected: { text: "Open", attributes: { "data-state": "open" } }
    });

    assert.equal(result.equivalence.verdict, "pass");
    assert.equal(result.expectation?.verdict, "pass");
    assert.equal(result.lanes.keyboard.steps.length, 2);
    assert.equal(closedContexts, 3);
    const storedTrace = JSON.parse(await readFile(result.traceFile, "utf8"));
    assert.equal(storedTrace.initialState.strategy, "shared-playwright-storage-state");
    const storedManifest = JSON.parse(await readFile(result.manifestFile, "utf8"));
    assert.equal(storedManifest.status, "completed");
    assert.equal(storedManifest.summary.available, 55);
    assert.ok(storedManifest.artifacts.every(({ integrity }: { integrity?: string }) => integrity));
    assert.match(await readFile(result.lanes.keyboard.video.captionsFile, "utf8"), /Press Enter/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("renderPortableVirtualScreenReaderTranscript reads a transcript with no live-region announcements", () => {
  // Live-region announcements came after the first transcripts, so the schema keeps them optional.
  const transcript: unknown = {
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.3.0",
    speechEngine: "@guidepup/virtual-screen-reader 0.33.0",
    mode: "guide",
    fidelity: "semantic-simulation",
    physicalAssistiveTechnology: false,
    pageUrl: "https://example.test/",
    generatedAt: "2026-01-01T00:00:00.000Z",
    entries: [
      {
        sequence: 1,
        timestamp: "2026-01-01T00:00:00.000Z",
        command: "next-item",
        announcement: "button, Save",
        focusMoved: false
      }
    ]
  };
  assertValidSchema("virtualScreenReaderTranscript", transcript);

  const text = renderPortableVirtualScreenReaderTranscript(transcript);

  assert.match(text, /1\. next-item: button, Save/);
  assert.doesNotMatch(text, /Live-region announcements/);
});

test("renderInteractionVideoCaptions produces an accessible action timeline", () => {
  const captions = renderInteractionVideoCaptions([
    {
      id: "open-menu",
      sequence: 1,
      label: "Press Enter",
      startedAt: "2026-09-14T00:00:00.100Z",
      finishedAt: "2026-09-14T00:00:00.350Z",
      offsetMs: 100,
      durationMs: 250
    }
  ]);

  assert.equal(captions, "WEBVTT\n\n1\n00:00:00.100 --> 00:00:00.350\nPress Enter\n");
});

test("persistInteractionVideo refuses symbolic-link output targets", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aee-video-root-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "aee-video-outside-"));
  const laneDir = path.join(tempRoot, "keyboard");
  const outsideFile = path.join(outsideRoot, "outside.webm");
  await mkdir(laneDir, { recursive: true });
  await writeFile(outsideFile, "unchanged", "utf8");
  await symlink(outsideFile, path.join(laneDir, "video.webm"));

  try {
    await assert.rejects(
      persistInteractionVideo({
        video: { async saveAs() {} },
        rootDir: tempRoot,
        laneDir,
        laneId: "keyboard",
        driver: "keyboard",
        status: "completed",
        startedAt: "2026-09-14T00:00:00.000Z",
        finishedAt: "2026-09-14T00:00:01.000Z",
        actions: []
      }),
      /cannot be a symbolic link/
    );
    assert.equal(await readFile(outsideFile, "utf8"), "unchanged");
  } finally {
    await Promise.all([
      rm(tempRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true })
    ]);
  }
});

test("runStartPageLane records a failed lane when the browser cannot open its context", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aee-start-page-"));
  // As when the browser has crashed, disconnected or run out of memory.
  const browserError = new Error("The browser could not open a context.");
  const browser = {
    async newContext(): Promise<never> {
      throw browserError;
    }
  };

  try {
    await assert.rejects(
      runStartPageLane({
        browser,
        projectRoot: tempRoot,
        outputDir: "aee-output",
        laneId: "read-start-page",
        targetUrl: "https://example.com/",
        allowedOrigins: ["https://example.com"]
      }),
      browserError
    );
    const manifest = JSON.parse(
      await readFile(path.join(tempRoot, "aee-output", "read-start-page", "manifest.json"), "utf8")
    ) as { status: string; lanes: Array<{ id: string; driver: string; status: string }> };
    assert.equal(manifest.status, "partial");
    assert.deepEqual(
      manifest.lanes.map(({ id, driver, status }) => ({ id, driver, status })),
      [{ id: "read-start-page", driver: "page-load", status: "failed" }]
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("runKeyboardPointerSweepLane records a failed lane when the browser cannot open its contexts", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aee-sweep-"));
  // As when the browser has crashed, disconnected or run out of memory.
  const browserError = new Error("The browser could not open a context.");
  const browser = {
    async newContext(): Promise<never> {
      throw browserError;
    }
  };

  try {
    await assert.rejects(
      runKeyboardPointerSweepLane({
        browser,
        projectRoot: tempRoot,
        outputDir: "aee-output",
        laneId: "sweep-start-page",
        targetUrl: "https://example.com/",
        allowedOrigins: ["https://example.com"],
        activateControls: false
      }),
      browserError
    );
    const laneDir = path.join(tempRoot, "aee-output", "sweep-start-page");
    const manifest = JSON.parse(await readFile(path.join(laneDir, "manifest.json"), "utf8")) as {
      status: string;
      lanes: Array<{ id: string; driver: string; status: string }>;
    };
    assert.equal(manifest.status, "partial");
    assert.deepEqual(
      manifest.lanes.map(({ id, driver, status }) => ({ id, driver, status })),
      [{ id: "sweep-start-page", driver: "keyboard-pointer-sweep", status: "failed" }]
    );
    const sweep = JSON.parse(
      await readFile(path.join(laneDir, "keyboard-pointer-sweep.json"), "utf8")
    ) as { status: string; diagnostics: string[] };
    assert.equal(sweep.status, "failed");
    assert.deepEqual(sweep.diagnostics, [browserError.message]);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("writeEvidenceManifest hashes available files and marks required omissions", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aee-manifest-"));
  const runDir = path.join(tempRoot, "run-001");
  const artifactDir = path.join(runDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });
  const reportFile = path.join(runDir, "aee-report.json");
  const focusFile = path.join(artifactDir, "focus-before.json");
  await Promise.all([
    writeFile(reportFile, "{}", "utf8"),
    writeFile(path.join(runDir, "aee-report.md"), "# Report", "utf8"),
    writeFile(focusFile, '{"role":"button"}', "utf8"),
    writeFile(path.join(runDir, "run.json"), "{}", "utf8"),
    writeFile(path.join(runDir, "bundle.json"), "{}", "utf8")
  ]);

  try {
    const { manifest, manifestFile } = await writeEvidenceManifest({
      assessmentId: "manifest-test",
      rootDir: tempRoot,
      lanes: [
        {
          id: "keyboard-lane",
          driver: "keyboard",
          status: "completed",
          actions: [
            {
              id: "focus-save",
              sequence: 1,
              runId: "run-001",
              status: "completed",
              reporterFiles: [reportFile],
              artifactFiles: [focusFile],
              requiredArtifactBasenames: ["focus-before.json", "axe-after.json"]
            }
          ]
        }
      ]
    });

    assert.equal(manifest.status, "partial");
    assert.equal(manifest.summary.available, 5);
    assert.equal(manifest.summary.missing, 1);
    assert.equal(
      manifest.artifacts.find(({ path: filePath }) => filePath.endsWith("axe-after.json"))?.status,
      "missing"
    );
    const focus = manifest.artifacts.find(({ path: filePath }) =>
      filePath.endsWith("focus-before.json")
    );
    assert.match(focus?.integrity ?? "", /^sha256:[a-f0-9]{64}$/);
    assert.equal(path.isAbsolute(focus?.path ?? ""), false);
    assert.equal(
      JSON.parse(await readFile(manifestFile, "utf8")).privacy.reviewedForSharing,
      false
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("writeEvidenceManifest refuses files outside the assessment root", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aee-manifest-root-"));
  try {
    await assert.rejects(
      () =>
        writeEvidenceManifest({
          assessmentId: "unsafe-manifest-test",
          rootDir: tempRoot,
          lanes: [
            {
              id: "pointer-lane",
              driver: "pointer",
              status: "completed",
              actions: []
            }
          ],
          supplementalFiles: [{ path: path.resolve(tempRoot, "../outside.json") }]
        }),
      /must remain inside its root/
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("writeEvidenceManifest does not follow evidence symlinks", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aee-manifest-symlink-"));
  const outsideRoot = await mkdtemp(path.join(os.tmpdir(), "aee-manifest-outside-"));
  const outsideFile = path.join(outsideRoot, "private.json");
  const linkedFile = path.join(tempRoot, "linked.json");
  await writeFile(outsideFile, '{"secret":"not-indexed"}', "utf8");
  await symlink(outsideFile, linkedFile);

  try {
    const { manifest } = await writeEvidenceManifest({
      assessmentId: "symlink-manifest-test",
      rootDir: tempRoot,
      lanes: [
        {
          id: "pointer-lane",
          driver: "pointer",
          status: "completed",
          actions: []
        }
      ],
      supplementalFiles: [{ path: linkedFile }]
    });

    assert.equal(manifest.status, "partial");
    assert.equal(manifest.artifacts[0]?.status, "failed");
    assert.equal(manifest.artifacts[0]?.integrity, undefined);
    assert.deepEqual(manifest.artifacts[0]?.diagnostics, ["Symbolic-link evidence is not read."]);
  } finally {
    await Promise.all([
      rm(tempRoot, { recursive: true, force: true }),
      rm(outsideRoot, { recursive: true, force: true })
    ]);
  }
});

test("aggregateEvidenceManifests re-hashes child evidence into one scenario manifest", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aee-aggregate-manifest-"));
  const childRoot = path.join(tempRoot, "keyboard-lane");
  const artifactFile = path.join(childRoot, "evidence.json");
  await mkdir(childRoot, { recursive: true });
  await writeFile(artifactFile, '{"state":"before"}', "utf8");

  try {
    const child = await writeEvidenceManifest({
      assessmentId: "child-assessment",
      rootDir: childRoot,
      lanes: [{ id: "keyboard", driver: "keyboard", status: "completed", actions: [] }],
      supplementalFiles: [{ path: artifactFile, kind: "custom", phase: "lane" }]
    });
    const childIntegrity = child.manifest.artifacts[0]?.integrity;
    await writeFile(artifactFile, '{"state":"after"}', "utf8");

    const aggregate = await aggregateEvidenceManifests({
      assessmentId: "scenario-assessment",
      rootDir: tempRoot,
      childManifestFiles: [child.manifestFile],
      scenarioId: "scenario-assessment",
      scenarioDigest: `sha256:${"a".repeat(64)}`,
      profile: "core"
    });
    const artifact = aggregate.manifest.artifacts.find(({ path: filePath }) =>
      filePath.endsWith("evidence.json")
    );

    assert.equal(aggregate.manifest.status, "completed");
    assert.equal(aggregate.manifest.lanes[0]?.id, "keyboard");
    assert.notEqual(artifact?.integrity, childIntegrity);
    assert.ok(
      aggregate.manifest.artifacts.some(({ kind }) => kind === "evidence-manifest"),
      "Expected the child manifest itself to be indexed."
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("prepareAggregateManifest states its counts before the reports are written, then reads them", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aee-prepared-manifest-"));
  const childRoot = path.join(tempRoot, "keyboard-lane");
  const artifactFile = path.join(childRoot, "evidence.json");
  const reportFile = path.join(tempRoot, "report.json");
  await mkdir(childRoot, { recursive: true });
  await writeFile(artifactFile, '{"state":"after"}', "utf8");

  try {
    const child = await writeEvidenceManifest({
      assessmentId: "child-assessment",
      rootDir: childRoot,
      lanes: [{ id: "keyboard", driver: "keyboard", status: "completed", actions: [] }],
      supplementalFiles: [{ path: artifactFile, kind: "custom", phase: "lane" }]
    });
    const prepared = await prepareAggregateManifest({
      assessmentId: "scenario-assessment",
      rootDir: tempRoot,
      childManifestFiles: [child.manifestFile],
      scenarioId: "scenario-assessment",
      scenarioDigest: `sha256:${"a".repeat(64)}`,
      profile: "core",
      supplementalFiles: [{ path: reportFile, kind: "json-report", phase: "assessment" }],
      filesToWrite: [reportFile]
    });

    // The report is counted before it exists, as the report itself has to state the counts.
    assert.equal(prepared.status, "completed");
    assert.deepEqual(prepared.summary, { total: 3, available: 3, missing: 0, failed: 0 });
    await assert.rejects(prepared.write(), /cannot be read back: report\.json/);

    await writeFile(reportFile, JSON.stringify(prepared.summary), "utf8");
    const { manifest } = await prepared.write();
    assert.equal(manifest.status, prepared.status);
    assert.deepEqual(manifest.summary, prepared.summary);
    const report = manifest.artifacts.find(({ path: filePath }) => filePath === "report.json");
    assert.equal(report?.status, "available");
    assert.match(report?.integrity ?? "", /^sha256:/);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("verifyMotionControl distinguishes stopped and continuing motion", async () => {
  let stopped = false;
  const passing = await verifyMotionControl({
    settleMs: 0,
    async sample() {
      return { activeAnimations: stopped ? 0 : 1, signature: stopped ? "paused" : "moving" };
    },
    async requestStop() {
      stopped = true;
    }
  });

  assert.equal(passing.verdict, "pass");

  let frame = 0;
  const failing = await verifyMotionControl({
    settleMs: 0,
    async sample() {
      frame += 1;
      return { activeAnimations: 1, signature: `frame-${frame}` };
    },
    async requestStop() {}
  });

  assert.equal(failing.verdict, "fail");
});

test("resolveObserverIdsForCapturePolicy filters disabled capture observers", () => {
  const selectedObservers = resolveObserverIdsForCapturePolicy(
    ["dom", "accessibility-tree", "visual", "focus"],
    {
      includeDomSnapshot: false,
      includeAccessibilityTree: false,
      includeScreenshots: false,
      stabilizeAfterInteractionMs: 0,
      watchWithoutInputMs: 0
    }
  );

  assert.deepEqual(selectedObservers, ["focus"]);
});

test("runAeeOnPage rejects run IDs that can escape the output directory", async () => {
  const page = createTogglePage();

  await assert.rejects(
    () =>
      runAeeOnPage({
        page,
        projectRoot: process.cwd(),
        outputDir: "aee-output",
        runId: "../escaped",
        writeReports: false
      }),
    /Invalid runId/
  );
});

test("runAeeOnPage can miss a delayed response when stabilization is disabled", async () => {
  const page = createTogglePage();

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    writeReports: false,
    observers: ["dom", "accessibility-tree"],
    judges: ["change-response", "release"],
    interaction: {
      kind: "click",
      actor: "test",
      target: {
        role: "button",
        name: "Save"
      }
    },
    policy: {
      capture: {
        stabilizeAfterInteractionMs: 0
      }
    },
    async performInteraction() {
      setTimeout(() => page.press(), 20);
    }
  });

  const report = getReporterContent(result);
  const changeResponseJudgment = report.judgments.find(
    (judgment) => judgment.judgeId === "change-response"
  );

  assert.equal(changeResponseJudgment?.verdict, "fail");
  assert.match(changeResponseJudgment?.summary ?? "", /no observable response/i);

  await new Promise((resolve) => setTimeout(resolve, 30));
});

test("runAeeOnPage honors capture policy filters and stabilization waits", async () => {
  const page = createTogglePage();

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    writeReports: false,
    observers: ["dom", "accessibility-tree", "visual"],
    judges: ["change-response", "release"],
    interaction: {
      kind: "click",
      actor: "test",
      target: {
        role: "button",
        name: "Save"
      }
    },
    policy: {
      name: "stable-no-screenshots",
      capture: {
        includeScreenshots: false,
        stabilizeAfterInteractionMs: 40
      }
    },
    async performInteraction() {
      setTimeout(() => page.press(), 20);
    }
  });

  const report = getReporterContent(result);
  const changeResponseJudgment = report.judgments.find(
    (judgment) => judgment.judgeId === "change-response"
  );

  assert.equal(changeResponseJudgment?.verdict, "pass");
  assert.match(
    changeResponseJudgment?.summary ?? "",
    /button "Save" pressed changed from false to true/
  );
  assert.match(changeResponseJudgment?.summary ?? "", /supporting evidence only/);
  assert.deepEqual(
    report.records.map((record) => record.observerId),
    ["dom", "accessibility-tree", "dom", "accessibility-tree"]
  );
  assert.equal(report.artifacts.length, 0);
  assert.deepEqual(report.run.config?.selectedObservers, ["dom", "accessibility-tree"]);
  assert.deepEqual(report.run.config?.capturePolicy, {
    includeScreenshots: false,
    includeAccessibilityTree: true,
    includeDomSnapshot: true,
    stabilizeAfterInteractionMs: 40,
    watchWithoutInputMs: 1500
  });
});

test("announcedWithoutName flags the roles WAI-ARIA 1.2 requires to be named, as Chrome names them", () => {
  const unnamed = (role: string) => announcedWithoutName({ role });
  // ARIA 1.2's "Accessible Name Required: True" roles a hand-kept list left out. Chrome calls `img`
  // "image".
  for (const role of [
    "meter",
    "progressbar",
    "radiogroup",
    "tree",
    "treegrid",
    "treeitem",
    "grid",
    "table",
    "tabpanel",
    "tooltip",
    "region",
    "columnheader",
    "rowheader",
    "application",
    "graphics-document",
    "graphics-symbol",
    "button",
    "link",
    "heading",
    "dialog",
    "alertdialog",
    "image"
  ]) {
    assert.equal(unnamed(role), true, role);
  }
  // ARIA 1.2 names a tab from its content and does not require a name; nor a group, a text or a
  // generic container.
  for (const role of ["tab", "group", "generic", "text", "list", "paragraph"]) {
    assert.equal(unnamed(role), false, role);
  }
  assert.equal(announcedWithoutName({ role: "progressbar", name: "Upload" }), false);
});

test("toSafeId joins the words of any text into a short hyphenated id", () => {
  assert.equal(toSafeId("After goto"), "after-goto");
  assert.equal(toSafeId("  --Dialog: open!--  "), "dialog-open");
  assert.equal(toSafeId(`${"a".repeat(59)} b`), "a".repeat(59));
  assert.equal(toSafeId("-".repeat(100_000)), "item");
  assert.equal(toSafeId("!!!", "test"), "test");
});

test("contrast measured from the pixels behind a text passes, fails or stays for a person", () => {
  const grey: [number, number, number, number] = [0x77, 0x77, 0x77, 255];
  const measure = (pixels: Array<[number, number, number]>, text = grey) =>
    measureAgainstPixels(text, pixels, 4.5);
  // #777 has 4.68:1 on black and 4.47:1 on white, either side of the 4.5:1 that text needs.
  assert.deepEqual(
    measure([
      [0, 0, 0],
      [0, 0, 0]
    ]),
    {
      verdict: "pass",
      requiredRatio: 4.5,
      foreground: "#777777",
      lowest: { ratio: 4.68, background: "#000000" },
      highest: { ratio: 4.68, background: "#000000" }
    }
  );
  assert.equal(
    measure([
      [255, 255, 255],
      [0xe1, 0xe1, 0xe1]
    ])?.verdict,
    "fail"
  );
  // Enough contrast over part of what is behind it and too little over the rest: a person decides.
  const mixed = measure([
    [255, 255, 255],
    [0, 0, 0]
  ]);
  assert.equal(mixed?.verdict, "undecided");
  assert.deepEqual([mixed?.lowest.background, mixed?.highest.background], ["#ffffff", "#000000"]);
  // A see-through text is blended onto each pixel first: half-transparent black on white is grey.
  assert.equal(measure([[255, 255, 255]], [0, 0, 0, 255])?.verdict, "pass");
  assert.equal(measure([[255, 255, 255]], [0, 0, 0, 128])?.verdict, "fail");
  assert.equal(measure([]), undefined);
});
