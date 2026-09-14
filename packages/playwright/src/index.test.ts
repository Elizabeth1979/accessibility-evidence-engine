import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { EvidenceRecord, Judgment } from "@aee/core";

import {
  comparePointerAndKeyboardOutcomes,
  resolveObserverIdsForCapturePolicy,
  runAeeOnPage,
  runInputComparison,
  writeEvidenceManifest,
  verifyMotionControl,
  type PlaywrightPageLike
} from "./index";

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

function createMutablePage(
  initialHtml: string
): PlaywrightPageLike & { setHtml: (html: string) => void } {
  let html = initialHtml;

  return {
    url() {
      return "https://example.com/settings";
    },
    async content() {
      return html;
    },
    setHtml(nextHtml: string) {
      html = nextHtml;
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
          return focusedSelector ? { role: "button", name: "Open details" } : null;
        },
        async runAxeAnalysis() {
          return {
            testEngine: { name: "axe-core", version: "4.13.0" },
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
    assert.ok(storedManifest.artifacts.every(({ integrity }: { integrity?: string }) => integrity));
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
      stabilizeAfterInteractionMs: 0
    }
  );

  assert.deepEqual(selectedObservers, ["focus"]);
});

test("runAeeOnPage rejects run IDs that can escape the output directory", async () => {
  const page = createMutablePage("<main>Safe output</main>");

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

test("runAeeOnPage can miss delayed DOM changes when stabilization is disabled", async () => {
  const page = createMutablePage(`
    <main>
      <button id="save" type="button">Save</button>
      <p id="status">Idle</p>
    </main>
  `);

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    writeReports: false,
    observers: ["dom"],
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
      setTimeout(() => {
        page.setHtml(`
          <main>
            <button id="save" type="button">Save</button>
            <p id="status">Saved</p>
          </main>
        `);
      }, 20);
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
  const page = createMutablePage(`
    <main>
      <button id="save" type="button">Save</button>
      <p id="status">Idle</p>
    </main>
  `);

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
      name: "stable-dom-only",
      capture: {
        includeAccessibilityTree: false,
        includeScreenshots: false,
        stabilizeAfterInteractionMs: 40
      }
    },
    async performInteraction() {
      setTimeout(() => {
        page.setHtml(`
          <main>
            <button id="save" type="button">Save</button>
            <p id="status">Saved</p>
          </main>
        `);
      }, 20);
    }
  });

  const report = getReporterContent(result);
  const changeResponseJudgment = report.judgments.find(
    (judgment) => judgment.judgeId === "change-response"
  );

  assert.equal(changeResponseJudgment?.verdict, "pass");
  assert.match(changeResponseJudgment?.summary ?? "", /dom changed/i);
  assert.deepEqual(
    report.records.map((record) => record.observerId),
    ["dom", "dom"]
  );
  assert.equal(report.artifacts.length, 0);
  assert.deepEqual(report.run.config?.selectedObservers, ["dom"]);
  assert.deepEqual(report.run.config?.capturePolicy, {
    includeScreenshots: false,
    includeAccessibilityTree: false,
    includeDomSnapshot: true,
    stabilizeAfterInteractionMs: 40
  });
});
