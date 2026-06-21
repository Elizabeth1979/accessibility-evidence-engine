import assert from "node:assert/strict";
import test from "node:test";

import type { ReporterInput } from "@aee/core";

import { createMarkdownReporter } from "./index";

const sampleArtifacts = [
  {
    id: "artifact-focus-before",
    kind: "dom-snapshot" as const,
    path: "/tmp/focus-before.html",
    mediaType: "text/html",
    description: "DOM before keyboard interaction"
  },
  {
    id: "artifact-focus-after",
    kind: "dom-snapshot" as const,
    path: "/tmp/focus-after.html",
    mediaType: "text/html",
    description: "DOM after keyboard interaction"
  },
  {
    id: "artifact-screenshot-after",
    kind: "screenshot" as const,
    path: "/tmp/after.png",
    mediaType: "image/png",
    description: "Post-interaction screenshot"
  }
];

const sampleRecords = [
  {
    id: "record-focus-before",
    runId: "run-1",
    checkpointId: "checkpoint-1",
    interactionId: "interaction-1",
    observerId: "focus",
    phase: "before" as const,
    status: "ok" as const,
    timestamp: "2026-06-21T09:00:00.000Z",
    confidence: 0.95,
    summary: "Focus started on the Continue button.",
    beforeStateRef: sampleArtifacts[0],
    artifacts: [sampleArtifacts[0]]
  },
  {
    id: "record-focus-after",
    runId: "run-1",
    checkpointId: "checkpoint-1",
    interactionId: "interaction-1",
    observerId: "focus",
    phase: "after" as const,
    status: "ok" as const,
    timestamp: "2026-06-21T09:00:01.000Z",
    confidence: 0.95,
    summary: "Focus remained on the Continue button after tab.",
    afterStateRef: sampleArtifacts[1],
    artifacts: [sampleArtifacts[2]]
  },
  {
    id: "record-visual-after",
    runId: "run-1",
    checkpointId: "checkpoint-1",
    interactionId: "interaction-1",
    observerId: "visual",
    phase: "after" as const,
    status: "ok" as const,
    timestamp: "2026-06-21T09:00:01.200Z",
    confidence: 0.8,
    summary: "Visual evidence captured after the interaction.",
    rawRef: sampleArtifacts[2]
  },
  {
    id: "record-screen-reader-after",
    runId: "run-1",
    checkpointId: "checkpoint-1",
    interactionId: "interaction-1",
    observerId: "guidepup-screen-reader",
    phase: "after" as const,
    status: "unsupported" as const,
    timestamp: "2026-06-21T09:00:01.300Z",
    diagnostics: ["Guidepup is not available in this environment."]
  }
];

const sampleFindings = [
  {
    id: "finding-focus-stalled",
    message: "Keyboard interaction did not advance focus to the next target.",
    severity: "high" as const,
    ruleId: "keyboard-focus-order",
    evidenceRecordIds: ["record-focus-before", "record-focus-after"],
    artifactIds: ["artifact-focus-before", "artifact-focus-after"],
    suggestedFix: "Ensure focus moves to the next interactive control when Tab is pressed."
  }
];

const sampleJudgments = [
  {
    id: "keyboard:interaction-1",
    judgeId: "keyboard",
    judgeVersion: "0.1.0",
    scope: "interaction" as const,
    verdict: "fail" as const,
    summary: "Keyboard interaction stalled on the same element.",
    severity: "high" as const,
    confidence: 0.95,
    evidenceRecordIds: ["record-focus-before", "record-focus-after"],
    artifactIds: ["artifact-focus-before", "artifact-focus-after"],
    findings: sampleFindings,
    suggestedFix: "Ensure focus moves to the next interactive control when Tab is pressed."
  },
  {
    id: "release:interaction-1",
    judgeId: "release",
    judgeVersion: "0.1.0",
    scope: "interaction" as const,
    verdict: "fail" as const,
    summary: "Release gate failed because one blocking judgment met the current policy threshold.",
    severity: "high" as const,
    confidence: 0.75,
    evidenceRecordIds: ["record-focus-before", "record-focus-after", "record-visual-after"],
    suggestedFix: "Resolve blocking accessibility judgments before release."
  },
  {
    id: "screen-reader:interaction-1",
    judgeId: "screen-reader",
    judgeVersion: "0.1.0",
    scope: "interaction" as const,
    verdict: "unknown" as const,
    summary: "Screen reader evidence is unavailable in this environment.",
    severity: "medium" as const,
    confidence: 0.6,
    evidenceRecordIds: ["record-screen-reader-after"]
  }
];

const sampleInput: ReporterInput = {
  run: {
    id: "run-1",
    version: "0.1.0",
    startedAt: "2026-06-21T09:00:00.000Z",
    finishedAt: "2026-06-21T09:00:02.000Z",
    status: "completed",
    results: {
      pass: 0,
      fail: 2,
      unknown: 1
    },
    environment: {
      mode: "playwright-page"
    },
    config: {
      policyName: "default"
    }
  },
  bundles: [
    {
      runId: "run-1",
      interaction: {
        id: "interaction-1",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        timestamp: "2026-06-21T09:00:00.500Z",
        actor: "test",
        kind: "tab",
        target: {
          role: "button",
          name: "Continue"
        }
      },
      checkpoint: {
        id: "checkpoint-1",
        runId: "run-1",
        name: "checkout-form",
        url: "https://example.com/checkout",
        timestamp: "2026-06-21T09:00:00.000Z",
        trigger: "manual"
      },
      records: sampleRecords,
      artifacts: sampleArtifacts,
      correlation: {
        strategy: "observer-record-grouping",
        participatingObserverIds: ["focus", "visual"],
        notes: ["Artifacts were grouped by interaction boundary."]
      }
    }
  ],
  records: sampleRecords,
  judgments: sampleJudgments,
  findings: sampleFindings,
  artifacts: sampleArtifacts
};

test("createMarkdownReporter renders bundle evidence, observer coverage, and artifact summaries", async () => {
  const reporter = createMarkdownReporter();
  const [artifact] = await reporter.render(sampleInput);

  assert.equal(artifact.label, "aee-report.md");
  assert.match(artifact.content, /## Run Summary/);
  assert.match(artifact.content, /\| Verdicts \| pass 0, fail 2, unknown 1 \|/);
  assert.match(artifact.content, /## Triage/);
  assert.match(artifact.content, /### Blocking Judgments/);
  assert.match(artifact.content, /Release gate failed because one blocking judgment met the current policy threshold\./);
  assert.match(artifact.content, /### Unresolved Signals/);
  assert.match(artifact.content, /Screen reader evidence is unavailable in this environment\./);
  assert.match(artifact.content, /Guidepup is not available in this environment\./);
  assert.match(artifact.content, /### Suggested Fixes/);
  assert.match(artifact.content, /Resolve blocking accessibility judgments before release\./);
  assert.match(artifact.content, /## Observer Coverage/);
  assert.match(artifact.content, /\| focus \| 2 \| 2 \| 0 \| 0 \| 0 \| 0 \| 3 \|/);
  assert.match(artifact.content, /\| guidepup-screen-reader \| 1 \| 0 \| 1 \| 0 \| 0 \| 0 \| 0 \|/);
  assert.match(artifact.content, /## Artifact Summary/);
  assert.match(artifact.content, /\| dom-snapshot \| 2 \|/);
  assert.match(artifact.content, /\| screenshot \| 1 \|/);
  assert.match(artifact.content, /## Bundle 1: `tab` on button "Continue"/);
  assert.match(artifact.content, /\| Participating observers \| focus, visual \|/);
  assert.match(artifact.content, /Keyboard interaction stalled on the same element\./);
  assert.match(artifact.content, /Ensure focus moves to the next interactive control when Tab is pressed\./);
  assert.match(artifact.content, /\/tmp\/after\.png/);
});
