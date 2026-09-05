import assert from "node:assert/strict";
import test from "node:test";

import type { EvidenceRecord, Judgment } from "@aee/core";

import {
  comparePointerAndKeyboardOutcomes,
  resolveObserverIdsForCapturePolicy,
  runAeeOnPage,
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
