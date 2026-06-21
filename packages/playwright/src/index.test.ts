import assert from "node:assert/strict";
import test from "node:test";

import type { EvidenceRecord, Judgment } from "@aee/core";

import { resolveObserverIdsForCapturePolicy, runAeeOnPage, type PlaywrightPageLike } from "./index";

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

function createMutablePage(initialHtml: string): PlaywrightPageLike & { setHtml: (html: string) => void } {
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
  const artifact = result.reportArtifacts.find((candidate) => candidate.label === "aee-report.json");

  assert.ok(artifact, "Expected a JSON reporter artifact.");
  return getJsonReport(artifact.content);
}

test("resolveObserverIdsForCapturePolicy filters disabled capture observers", () => {
  const selectedObservers = resolveObserverIdsForCapturePolicy(["dom", "accessibility-tree", "visual", "focus"], {
    includeDomSnapshot: false,
    includeAccessibilityTree: false,
    includeScreenshots: false,
    stabilizeAfterInteractionMs: 0
  });

  assert.deepEqual(selectedObservers, ["focus"]);
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
  const changeResponseJudgment = report.judgments.find((judgment) => judgment.judgeId === "change-response");

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
  const changeResponseJudgment = report.judgments.find((judgment) => judgment.judgeId === "change-response");

  assert.equal(changeResponseJudgment?.verdict, "pass");
  assert.match(changeResponseJudgment?.summary ?? "", /dom changed/i);
  assert.deepEqual(report.records.map((record) => record.observerId), ["dom", "dom"]);
  assert.equal(report.artifacts.length, 0);
  assert.deepEqual(report.run.config?.selectedObservers, ["dom"]);
  assert.deepEqual(report.run.config?.capturePolicy, {
    includeScreenshots: false,
    includeAccessibilityTree: false,
    includeDomSnapshot: true,
    stabilizeAfterInteractionMs: 40
  });
});
