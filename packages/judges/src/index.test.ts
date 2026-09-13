import assert from "node:assert/strict";
import test from "node:test";

import { DEFAULT_POLICY, type EvidenceBundle, type Judgment } from "@aee/core";

import { createDefaultJudgePlugins } from "./index";

function createBundle(
  records: EvidenceBundle["records"],
  interactionOverrides?: Partial<EvidenceBundle["interaction"]>
): EvidenceBundle {
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
      },
      ...interactionOverrides
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

test("axe judge fails violations and preserves incomplete checks as unresolved context", async () => {
  const judge = createDefaultJudgePlugins(["axe"])[0];
  const bundle = createBundle([
    {
      id: "record-axe-after",
      runId: "run-1",
      observerId: "axe",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      artifacts: [
        {
          id: "axe-after:artifact",
          kind: "axe-result",
          path: "/tmp/axe-after.json",
          mediaType: "application/json"
        }
      ],
      meta: {
        violations: 2,
        incomplete: 1,
        violationRuleIds: ["aria-required-parent", "color-contrast"],
        incompleteRuleIds: ["link-in-text-block"]
      }
    }
  ]);

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "fail");
  assert.match(judgment?.summary ?? "", /2 violations/);
  assert.match(judgment?.summary ?? "", /1 check remains incomplete/);
  assert.deepEqual(
    judgment?.findings?.map(({ ruleId }) => ruleId),
    ["aria-required-parent", "color-contrast"]
  );
});

test("axe judge returns unknown when only incomplete checks remain", async () => {
  const judge = createDefaultJudgePlugins(["axe"])[0];
  const bundle = createBundle([
    {
      id: "record-axe-after",
      runId: "run-1",
      observerId: "axe",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      meta: {
        violations: 0,
        incomplete: 1,
        incompleteRuleIds: ["color-contrast"]
      }
    }
  ]);

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "unknown");
  assert.match(judgment?.summary ?? "", /requires review/);
});

test("focus-management judge fails when a dialog opens but focus stays on its trigger", async () => {
  const judge = createDefaultJudgePlugins(["focus-management"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-focus-before",
        runId: "run-1",
        observerId: "focus",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z",
        meta: {
          focusTarget: { tagName: "button", id: "delete-project", name: "Delete project" }
        }
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          focusTarget: { tagName: "button", id: "delete-project", name: "Delete project" }
        }
      }
    ],
    {
      kind: "click",
      meta: { focusExpectation: "inside-dialog" },
      target: { role: "button", name: "Delete project" }
    }
  );

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "fail");
  assert.equal(judgment?.findings?.[0]?.ruleId, "dialog-initial-focus");
  assert.match(judgment?.summary ?? "", /focus remained outside/i);
});

test("focus-management judge passes when focus moves inside the opened dialog", async () => {
  const judge = createDefaultJudgePlugins(["focus-management"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-focus-before",
        runId: "run-1",
        observerId: "focus",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z",
        meta: {
          focusTarget: { tagName: "button", id: "delete-project", name: "Delete project" }
        }
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          focusTarget: {
            tagName: "button",
            id: "cancel-delete",
            name: "Cancel",
            dialogContext: {
              tagName: "div",
              id: "delete-dialog",
              role: "dialog",
              name: "Delete project?",
              ariaModal: true
            }
          }
        }
      }
    ],
    {
      kind: "click",
      meta: { focusExpectation: "inside-dialog" },
      target: { role: "button", name: "Delete project" }
    }
  );

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "pass");
  assert.match(judgment?.summary ?? "", /inside the opened dialog/i);
});

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

test("keyboard judge passes enter activation when an activatable control produces DOM change", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-focus-before",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "focus",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z",
        meta: {
          focusTarget: {
            tagName: "button",
            id: "save",
            name: "Save"
          }
        }
      },
      {
        id: "record-dom-before",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.010Z"
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          focusTarget: {
            tagName: "button",
            id: "save",
            name: "Save"
          }
        }
      },
      {
        id: "record-dom-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.120Z",
        meta: {
          changed: true
        },
        changes: [
          {
            path: "dom.html",
            summary: "DOM markup changed after the interaction.",
            impact: "major"
          }
        ]
      }
    ],
    {
      kind: "enter",
      target: {
        role: "button",
        name: "Save"
      }
    }
  );

  const [judgment] = await keyboardJudge!.judge(bundle, {
    runId: "run-1"
  });

  assert.equal(judgment.verdict, "pass");
  assert.match(judgment.summary, /DOM changed/);
  assert.match(judgment.summary, /Focus stayed/);
});

test("keyboard judge fails space activation when an activatable control has no observable response", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-focus-before",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "focus",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z",
        meta: {
          focusTarget: {
            tagName: "div",
            id: "custom-button",
            role: "button",
            name: "Save"
          }
        }
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          focusTarget: {
            tagName: "div",
            id: "custom-button",
            role: "button",
            name: "Save"
          }
        }
      },
      {
        id: "record-dom-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.120Z",
        meta: {
          changed: false
        },
        changes: [
          {
            path: "dom.html",
            summary: "DOM markup did not change after the interaction.",
            impact: "none"
          }
        ]
      }
    ],
    {
      kind: "space",
      target: {
        role: "button",
        name: "Save"
      }
    }
  );

  const [judgment] = await keyboardJudge!.judge(bundle, {
    runId: "run-1"
  });

  assert.equal(judgment.verdict, "fail");
  assert.match(judgment.summary, /no observable activation response/);
  assert.equal(judgment.severity, "high");
});

test("keyboard judge passes arrow-key navigation within a tablist when focus moves to the next tab", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-focus-before",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "focus",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z",
        meta: {
          focusTarget: {
            tagName: "button",
            id: "tab-overview",
            role: "tab",
            name: "Overview",
            compositeRole: "tablist",
            compositeItemIndex: 0,
            compositeItemCount: 3
          }
        }
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          focusTarget: {
            tagName: "button",
            id: "tab-pricing",
            role: "tab",
            name: "Pricing",
            compositeRole: "tablist",
            compositeItemIndex: 1,
            compositeItemCount: 3
          }
        }
      }
    ],
    {
      kind: "arrow-key",
      input: "ArrowRight",
      target: {
        role: "tab",
        name: "Overview"
      }
    }
  );

  const [judgment] = await keyboardJudge!.judge(bundle, {
    runId: "run-1"
  });

  assert.equal(judgment.verdict, "pass");
  assert.match(judgment.summary, /moved focus within the tablist/);
  assert.match(judgment.summary, /ArrowRight/);
});

test("keyboard judge fails arrow-key navigation when focus stalls in a tablist", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-focus-before",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "focus",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z",
        meta: {
          focusTarget: {
            tagName: "button",
            id: "tab-overview",
            role: "tab",
            name: "Overview",
            compositeRole: "tablist",
            compositeItemIndex: 0,
            compositeItemCount: 3
          }
        }
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          focusTarget: {
            tagName: "button",
            id: "tab-overview",
            role: "tab",
            name: "Overview",
            compositeRole: "tablist",
            compositeItemIndex: 0,
            compositeItemCount: 3
          }
        }
      }
    ],
    {
      kind: "arrow-key",
      input: "ArrowRight",
      target: {
        role: "tab",
        name: "Overview"
      }
    }
  );

  const [judgment] = await keyboardJudge!.judge(bundle, {
    runId: "run-1"
  });

  assert.equal(judgment.verdict, "fail");
  assert.match(judgment.summary, /did not move focus within the tablist/);
  assert.equal(judgment.severity, "high");
});

test("keyboard judge passes arrow-key navigation when aria-activedescendant changes within a listbox", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-focus-before",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "focus",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z",
        meta: {
          focusTarget: {
            tagName: "div",
            id: "city-listbox",
            role: "listbox",
            name: "Cities",
            activeDescendantId: "city-tel-aviv",
            activeDescendant: {
              tagName: "div",
              id: "city-tel-aviv",
              role: "option",
              name: "Tel Aviv",
              compositeRole: "listbox",
              compositeItemIndex: 0,
              compositeItemCount: 3
            }
          }
        }
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          focusTarget: {
            tagName: "div",
            id: "city-listbox",
            role: "listbox",
            name: "Cities",
            activeDescendantId: "city-haifa",
            activeDescendant: {
              tagName: "div",
              id: "city-haifa",
              role: "option",
              name: "Haifa",
              compositeRole: "listbox",
              compositeItemIndex: 1,
              compositeItemCount: 3
            }
          }
        }
      }
    ],
    {
      kind: "arrow-key",
      input: "ArrowDown",
      target: {
        role: "option",
        name: "Tel Aviv"
      }
    }
  );

  const [judgment] = await keyboardJudge!.judge(bundle, {
    runId: "run-1"
  });

  assert.equal(judgment.verdict, "pass");
  assert.match(judgment.summary, /listbox/);
  assert.match(judgment.summary, /ArrowDown/);
});

test("change-response judge passes when a click interaction changes the DOM", async () => {
  const judge = createDefaultJudgePlugins(["change-response"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-dom-before",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z"
      },
      {
        id: "record-dom-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          changed: true
        },
        changes: [
          {
            path: "dom.html",
            summary: "DOM markup changed after the interaction.",
            impact: "major"
          }
        ]
      }
    ],
    {
      kind: "click",
      target: {
        role: "button",
        name: "Save"
      }
    }
  );

  const [judgment] = await judge!.judge(bundle, {
    runId: "run-1"
  });

  assert.equal(judgment.verdict, "pass");
  assert.match(judgment.summary, /DOM changed/);
});

test("change-response judge fails when a click interaction has no observable response", async () => {
  const judge = createDefaultJudgePlugins(["change-response"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-dom-before",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z"
      },
      {
        id: "record-dom-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          changed: false
        },
        changes: [
          {
            path: "dom.html",
            summary: "DOM markup did not change after the interaction.",
            impact: "none"
          }
        ]
      }
    ],
    {
      kind: "click",
      target: {
        role: "button",
        name: "Save"
      }
    }
  );

  const [judgment] = await judge!.judge(bundle, {
    runId: "run-1"
  });

  assert.equal(judgment.verdict, "fail");
  assert.match(judgment.summary, /No observable response followed the click interaction/);
  assert.equal(judgment.severity, "high");
});

test("change-response judge passes when an enter activation changes the DOM", async () => {
  const judge = createDefaultJudgePlugins(["change-response"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-dom-before",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z"
      },
      {
        id: "record-dom-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          changed: true
        },
        changes: [
          {
            path: "dom.html",
            summary: "DOM markup changed after the interaction.",
            impact: "major"
          }
        ]
      }
    ],
    {
      kind: "enter",
      target: {
        role: "button",
        name: "Save"
      }
    }
  );

  const [judgment] = await judge!.judge(bundle, {
    runId: "run-1"
  });

  assert.equal(judgment.verdict, "pass");
  assert.match(judgment.summary, /enter interaction/);
  assert.match(judgment.summary, /DOM changed/);
});

test("change-response judge fails when a space activation has no observable response", async () => {
  const judge = createDefaultJudgePlugins(["change-response"])[0];
  const bundle = createBundle(
    [
      {
        id: "record-dom-before",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z"
      },
      {
        id: "record-dom-after",
        runId: "run-1",
        checkpointId: "checkpoint-1",
        interactionId: "interaction-1",
        observerId: "dom",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: {
          changed: false
        },
        changes: [
          {
            path: "dom.html",
            summary: "DOM markup did not change after the interaction.",
            impact: "none"
          }
        ]
      }
    ],
    {
      kind: "space",
      target: {
        role: "button",
        name: "Save"
      }
    }
  );

  const [judgment] = await judge!.judge(bundle, {
    runId: "run-1"
  });

  assert.equal(judgment.verdict, "fail");
  assert.match(judgment.summary, /No observable response followed the space interaction/);
  assert.match(judgment.suggestedFix ?? "", /space interaction activates the target/i);
});
