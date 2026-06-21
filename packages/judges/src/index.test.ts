import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_POLICY, type EvidenceBundle, type Judgment } from "@aee/core";

import { createDefaultJudgePlugins } from "./index";

function createBundle(records: EvidenceBundle["records"]): EvidenceBundle {
  return {
    runId: "run-1",
    interaction: {
      id: "interaction-1",
      runId: "run-1",
      checkpointId: "checkpoint-1",
      timestamp: "2026-06-21T10:00:01.000Z",
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
      name: "checkout",
      url: "https://example.com/checkout",
      timestamp: "2026-06-21T10:00:00.000Z",
      trigger: "manual"
    },
    records,
    artifacts: [],
    correlation: {
      strategy: "observer-record-grouping",
      participatingObserverIds: [...new Set(records.map((record) => record.observerId))]
    }
  };
}

function createJudgment(overrides: Partial<Judgment>): Judgment {
  return {
    id: overrides.id ?? "judgment-1",
    judgeId: overrides.judgeId ?? "keyboard",
    judgeVersion: overrides.judgeVersion ?? "0.1.0",
    scope: overrides.scope ?? "interaction",
    verdict: overrides.verdict ?? "pass",
    summary: overrides.summary ?? "Sample judgment",
    severity: overrides.severity,
    confidence: overrides.confidence,
    evidenceRecordIds: overrides.evidenceRecordIds ?? ["record-focus-before"],
    artifactIds: overrides.artifactIds,
    findings: overrides.findings,
    rationale: overrides.rationale,
    suggestedFix: overrides.suggestedFix,
    tags: overrides.tags
  };
}

test("release judge fails when a prior judgment crosses the default policy threshold", async () => {
  const releaseJudge = createDefaultJudgePlugins(["release"])[0];
  const bundle = createBundle([
    {
      id: "record-focus-before",
      runId: "run-1",
      checkpointId: "checkpoint-1",
      interactionId: "interaction-1",
      observerId: "focus",
      phase: "before",
      status: "ok",
      timestamp: "2026-06-21T10:00:01.100Z"
    }
  ]);

  const [judgment] = await releaseJudge!.judge(bundle, {
    runId: "run-1",
    policyName: "default",
    releasePolicy: DEFAULT_POLICY.release,
    priorJudgments: [
      createJudgment({
        id: "keyboard:interaction-1",
        verdict: "fail",
        severity: "high",
        confidence: 0.95,
        summary: "Keyboard focus moved in the wrong direction."
      })
    ]
  });

  assert.equal(judgment.verdict, "fail");
  assert.match(judgment.summary, /blocking judgment/);
  assert.deepEqual(judgment.evidenceRecordIds, ["record-focus-before"]);
});

test("release judge ignores low-confidence blockers and can fail on unresolved unknowns by policy", async () => {
  const releaseJudge = createDefaultJudgePlugins(["release"])[0];
  const bundle = createBundle([
    {
      id: "record-screen-reader",
      runId: "run-1",
      checkpointId: "checkpoint-1",
      interactionId: "interaction-1",
      observerId: "screen-reader",
      phase: "after",
      status: "unsupported",
      timestamp: "2026-06-21T10:00:01.300Z"
    }
  ]);

  const [judgment] = await releaseJudge!.judge(bundle, {
    runId: "run-1",
    policyName: "strict",
    releasePolicy: {
      ...DEFAULT_POLICY.release,
      unknownBehavior: "fail"
    },
    priorJudgments: [
      createJudgment({
        id: "keyboard:interaction-1",
        verdict: "fail",
        severity: "high",
        confidence: 0.2,
        summary: "Low-confidence blocking signal."
      }),
      createJudgment({
        id: "screen-reader:interaction-1",
        judgeId: "screen-reader",
        verdict: "unknown",
        severity: "medium",
        confidence: 0.9,
        summary: "Screen reader evidence is inconclusive.",
        evidenceRecordIds: ["record-screen-reader"]
      })
    ]
  });

  assert.equal(judgment.verdict, "fail");
  assert.match(judgment.summary, /unknown judgment/);
  assert.match(judgment.summary, /unsupported observer/);
  assert.deepEqual(judgment.evidenceRecordIds, ["record-screen-reader"]);
});
