import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_POLICY,
  type AccessibilityChanges,
  type EvidenceBundle,
  type Judgment
} from "@aee/core";

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

interface TreeNode {
  backendDOMNodeId: number;
  role: string;
  name?: string;
  description?: string;
  ignored?: boolean;
  ignoredReasons?: string[];
  properties?: Array<{ name: string; value: { type: string; value?: unknown } }>;
}

const LEVEL_1 = [{ name: "level", value: { type: "integer", value: 1 } }];

function createSemanticSupportRecords(treeNodes: TreeNode[]): EvidenceBundle["records"] {
  const semanticNodes = treeNodes.map(({ ignored = false, properties = [], ...node }) => ({
    ...node,
    ignored,
    properties
  }));
  return [
    {
      id: "record-dom-after",
      runId: "run-1",
      observerId: "dom",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      artifacts: [
        {
          id: "dom-after",
          kind: "dom-snapshot",
          path: "/tmp/dom-after.html",
          mediaType: "text/html"
        }
      ]
    },
    {
      id: "record-accessibility-after",
      runId: "run-1",
      observerId: "accessibility-tree",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      artifacts: [
        {
          id: "accessibility-after",
          kind: "accessibility-tree",
          path: "/tmp/accessibility-tree-after.json",
          mediaType: "application/json"
        }
      ],
      meta: { semanticNodes, semanticIndexTruncated: false }
    },
    {
      id: "record-visual-after",
      runId: "run-1",
      observerId: "visual",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      artifacts: [
        {
          id: "visual-full-page-after",
          kind: "screenshot",
          path: "/tmp/visual-full-page-after.png",
          mediaType: "image/png"
        }
      ]
    }
  ];
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

test("axe judge reports best-practice results as advisory findings that never fail", async () => {
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
        incomplete: 0,
        violationRuleIds: [],
        advisoryRuleIds: ["empty-heading"],
        incompleteRuleIds: []
      }
    }
  ]);

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "pass");
  assert.match(judgment?.summary ?? "", /1 best-practice result is advisory \(empty-heading\)/);
  assert.deepEqual(
    judgment?.findings?.map(({ ruleId, severity, tags }) => ({ ruleId, severity, tags })),
    [{ ruleId: "empty-heading", severity: "low", tags: ["best-practice"] }]
  );
});

test("screen-reader judge passes virtual navigation that does not move DOM focus", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];
  const bundle = createBundle([
    {
      id: "record-reader-after",
      runId: "run-1",
      observerId: "virtual-screen-reader",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      meta: {
        newEntryCount: 1,
        focusMovedCount: 0,
        lastAnnouncement: "Invoices, heading, level 1",
        lastItem: {
          role: "heading",
          name: "Invoices",
          level: 1,
          nodePath: "main > h1",
          visualBounds: { x: 20, y: 40, width: 240, height: 48 },
          backendDOMNodeId: 7,
          properties: LEVEL_1
        }
      }
    },
    ...createSemanticSupportRecords([
      { backendDOMNodeId: 7, role: "heading", name: "Invoices", properties: LEVEL_1 }
    ])
  ]);

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "pass");
  assert.match(judgment?.summary ?? "", /without moving DOM focus/);
  assert.match(
    judgment?.summary ?? "",
    /The element it read has the same role, name, description, value and states in the accessibility tree captured at this checkpoint/
  );
  assert.match(judgment?.summary ?? "", /not pixel meaning or VoiceOver\/NVDA fidelity/);
});

test("screen-reader judge fails when the same element is named differently, even if another node has the name", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];
  const bundle = createBundle([
    {
      id: "record-reader-after",
      runId: "run-1",
      observerId: "virtual-screen-reader",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      meta: {
        newEntryCount: 1,
        focusMovedCount: 0,
        lastAnnouncement: "Invoices, heading, level 1",
        lastItem: {
          role: "heading",
          name: "Invoices",
          level: 1,
          nodePath: "main > h1",
          visualBounds: { x: 20, y: 40, width: 240, height: 48 },
          backendDOMNodeId: 7,
          properties: LEVEL_1
        }
      }
    },
    ...createSemanticSupportRecords([
      { backendDOMNodeId: 7, role: "heading", name: "Payments", properties: LEVEL_1 },
      // A different element with the read name and level does not stand in for the one read.
      { backendDOMNodeId: 8, role: "heading", name: "Invoices", properties: LEVEL_1 }
    ])
  ]);

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "fail");
  assert.equal(judgment?.findings?.[0]?.ruleId, "portable-reader-semantic-agreement");
  assert.match(
    judgment?.summary ?? "",
    /describes that same element differently: name “Invoices” when read, “Payments” in the tree/
  );
});

function readButtonBundle(
  item: Record<string, unknown>,
  treeNodes: TreeNode[],
  announcement = "Filters, button, collapsed"
) {
  return createBundle([
    {
      id: "record-reader-after",
      runId: "run-1",
      observerId: "virtual-screen-reader",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      meta: {
        newEntryCount: 1,
        focusMovedCount: 0,
        lastAnnouncement: announcement,
        lastItem: {
          role: "button",
          name: "Filters",
          nodePath: "main > button",
          visualBounds: { x: 20, y: 40, width: 120, height: 32 },
          ...item
        }
      }
    },
    ...createSemanticSupportRecords(treeNodes)
  ]);
}

const COLLAPSED = [{ name: "expanded", value: { type: "booleanOrUndefined", value: false } }];
const EXPANDED = [{ name: "expanded", value: { type: "booleanOrUndefined", value: true } }];

test("screen-reader judge fails when a state of the element read differs in the tree", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];

  const [judgment] = await judge!.judge(
    readButtonBundle({ backendDOMNodeId: 3, properties: COLLAPSED }, [
      { backendDOMNodeId: 3, role: "button", name: "Filters", properties: EXPANDED }
    ]),
    { runId: "run-1" }
  );

  assert.equal(judgment?.verdict, "fail");
  assert.match(
    judgment?.summary ?? "",
    /expanded \{"type":"booleanOrUndefined","value":false\} when read, \{"type":"booleanOrUndefined","value":true\} in the tree/
  );
});

test("screen-reader judge fails when the description of the element read differs in the tree", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];

  const [judgment] = await judge!.judge(
    readButtonBundle(
      { backendDOMNodeId: 3, description: "Opens the filter panel", properties: [] },
      [{ backendDOMNodeId: 3, role: "button", name: "Filters" }]
    ),
    { runId: "run-1" }
  );

  assert.equal(judgment?.verdict, "fail");
  assert.match(
    judgment?.summary ?? "",
    /description “Opens the filter panel” when read, none in the tree/
  );
});

test("screen-reader judge fails when the tree leaves out the element read, with Chrome's reason", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];

  const [judgment] = await judge!.judge(
    readButtonBundle({ backendDOMNodeId: 3, properties: [] }, [
      {
        backendDOMNodeId: 3,
        role: "button",
        name: "Filters",
        ignored: true,
        ignoredReasons: ["ariaHiddenElement"]
      }
    ]),
    { runId: "run-1" }
  );

  assert.equal(judgment?.verdict, "fail");
  assert.match(judgment?.summary ?? "", /the tree leaves it out \(ariaHiddenElement\)/);
});

test("screen-reader judge fails when the element read is not in the checkpoint's tree", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];

  const [judgment] = await judge!.judge(
    readButtonBundle({ backendDOMNodeId: 3, properties: [] }, [
      { backendDOMNodeId: 4, role: "button", name: "Filters" }
    ]),
    { runId: "run-1" }
  );

  assert.equal(judgment?.verdict, "fail");
  assert.match(
    judgment?.summary ?? "",
    /that element is not in the tree captured at this checkpoint/
  );
});

test("screen-reader judge leaves undecided an item that names no DOM node", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];

  const [judgment] = await judge!.judge(
    readButtonBundle({ properties: [] }, [
      { backendDOMNodeId: 3, role: "button", name: "Filters" }
    ]),
    { runId: "run-1" }
  );

  assert.equal(judgment?.verdict, "unknown");
  assert.match(judgment?.summary ?? "", /names no DOM node/);
});

test("screen-reader judge matches a summary the reader calls a button to Chromium's DisclosureTriangle", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];

  const [judgment] = await judge!.judge(
    readButtonBundle({ backendDOMNodeId: 3, properties: COLLAPSED }, [
      { backendDOMNodeId: 3, role: "DisclosureTriangle", name: "Filters", properties: COLLAPSED }
    ]),
    { runId: "run-1" }
  );

  assert.equal(judgment?.verdict, "pass");
});

function readTextBundle(treeNodes: TreeNode[]) {
  return createBundle([
    {
      id: "record-reader-after",
      runId: "run-1",
      observerId: "virtual-screen-reader",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      meta: {
        newEntryCount: 1,
        focusMovedCount: 0,
        lastAnnouncement: "Project Alpha",
        lastItem: {
          role: "text",
          text: "Project Alpha",
          nodePath: "main > article > header > strong",
          visualBounds: { x: 20, y: 40, width: 120, height: 20 },
          backendDOMNodeId: 12
        }
      }
    },
    ...createSemanticSupportRecords(treeNodes)
  ]);
}

test("screen-reader judge matches text the reader reads on its own to the tree's StaticText", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];

  const [judgment] = await judge!.judge(
    readTextBundle([{ backendDOMNodeId: 12, role: "StaticText", name: "Project  Alpha" }]),
    { runId: "run-1" }
  );

  assert.equal(judgment?.verdict, "pass");
});

test("screen-reader judge fails text the reader reads that the tree does not hold", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];

  const [judgment] = await judge!.judge(
    readTextBundle([{ backendDOMNodeId: 12, role: "StaticText", name: "Project Beta" }]),
    { runId: "run-1" }
  );

  assert.equal(judgment?.verdict, "fail");
  assert.equal(judgment?.findings?.[0]?.ruleId, "portable-reader-semantic-agreement");
});

test("screen-reader judge leaves undecided an announcement that disagrees with the browser's name", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];
  const bundle = createBundle([
    {
      id: "record-reader-after",
      runId: "run-1",
      observerId: "virtual-screen-reader",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      meta: {
        newEntryCount: 1,
        focusMovedCount: 0,
        lastAnnouncement: "button, Pay",
        lastItem: {
          role: "button",
          name: "Pay invoice",
          nodePath: "main > button",
          visualBounds: { x: 20, y: 40, width: 120, height: 32 },
          backendDOMNodeId: 5,
          properties: []
        }
      }
    },
    ...createSemanticSupportRecords([{ backendDOMNodeId: 5, role: "button", name: "Pay invoice" }])
  ]);

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "unknown");
  assert.match(judgment?.summary ?? "", /disagree on its accessible name/);
});

test("screen-reader judge returns unknown when same-checkpoint visual evidence is absent", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];
  const records = [
    {
      id: "record-reader-after",
      runId: "run-1",
      observerId: "virtual-screen-reader",
      phase: "after" as const,
      status: "ok" as const,
      timestamp: "2026-09-13T00:00:00.000Z",
      meta: {
        newEntryCount: 1,
        focusMovedCount: 0,
        lastAnnouncement: "Invoices, heading, level 1",
        lastItem: {
          role: "heading",
          name: "Invoices",
          level: 1,
          nodePath: "main > h1",
          visualBounds: { x: 20, y: 40, width: 240, height: 48 },
          backendDOMNodeId: 7,
          properties: LEVEL_1
        }
      }
    },
    ...createSemanticSupportRecords([
      { backendDOMNodeId: 7, role: "heading", name: "Invoices", properties: LEVEL_1 }
    ]).filter(({ observerId }) => observerId !== "visual")
  ];

  const [judgment] = await judge!.judge(createBundle(records), { runId: "run-1" });

  assert.equal(judgment?.verdict, "unknown");
  assert.match(judgment?.summary ?? "", /same-checkpoint visual evidence is missing/);
});

test("screen-reader judge fails when virtual navigation moves DOM focus", async () => {
  const judge = createDefaultJudgePlugins(["screen-reader"])[0];
  const bundle = createBundle([
    {
      id: "record-reader-after",
      runId: "run-1",
      observerId: "virtual-screen-reader",
      phase: "after",
      status: "ok",
      timestamp: "2026-09-13T00:00:00.000Z",
      meta: {
        newEntryCount: 1,
        focusMovedCount: 1,
        lastAnnouncement: "Pay, button"
      }
    }
  ]);

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "fail");
  assert.match(judgment?.summary ?? "", /must remain separate/);
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

test("focus-management judge fails when a reveal-only interaction moves focus", async () => {
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
        meta: { focusTarget: { nodePath: "button#trigger", id: "trigger" } }
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: { focusTarget: { nodePath: "a#unexpected", id: "unexpected" } }
      }
    ],
    {
      kind: "hover",
      meta: { focusExpectation: "preserve" },
      target: { role: "button", name: "More information" }
    }
  );

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "fail");
  assert.equal(judgment?.findings?.[0]?.ruleId, "focus-preservation");
});

test("focus-management judge matches the deepest focused target", async () => {
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
        meta: { focusTarget: { nodePath: "body", tagName: "body" } }
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
            id: "host",
            deepActiveElement: {
              nodePath: "button#save",
              id: "save",
              role: "button",
              name: "Save"
            }
          }
        }
      }
    ],
    {
      kind: "focus",
      meta: { focusExpectation: "target" },
      target: { role: "button", name: "Save" }
    }
  );

  const [judgment] = await judge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "pass");
  assert.match(judgment?.summary ?? "", /requested target/i);
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

type PressRecord = EvidenceBundle["records"][number];

function pressRecord(
  id: string,
  observerId: string,
  phase: PressRecord["phase"],
  meta?: Record<string, unknown>
): PressRecord {
  return {
    id,
    runId: "run-1",
    checkpointId: "checkpoint-1",
    interactionId: "interaction-1",
    observerId,
    phase,
    status: "ok",
    timestamp: phase === "before" ? "2026-06-21T10:00:01.000Z" : "2026-06-21T10:00:01.100Z",
    ...(meta ? { meta } : {})
  };
}

/** Focus stays on the pressed control, as it does for a checkbox, a toggle or a Save button. */
function focusStaysOn(focusTarget: Record<string, unknown>): PressRecord[] {
  return [
    pressRecord("record-focus-before", "focus", "before", { focusTarget }),
    pressRecord("record-focus-after", "focus", "after", { focusTarget })
  ];
}

function accessibilityAfter(accessibilityChanges: AccessibilityChanges): PressRecord {
  return pressRecord("record-accessibility-after", "accessibility-tree", "after", {
    accessibilityChanges
  });
}

function markupAfter(changed: boolean): PressRecord {
  return pressRecord("record-dom-after", "dom", "after", { changed });
}

function politeAnnouncements(texts: string[]) {
  return texts.map((text, index) => ({
    sequence: index + 1,
    timestamp: "2026-06-21T10:00:01.050Z",
    politeness: "polite",
    text
  }));
}

function readerAfter(texts: string[]): PressRecord {
  return pressRecord("record-reader-after", "virtual-screen-reader", "after", {
    newLiveRegionAnnouncements: politeAnnouncements(texts)
  });
}

/** What the reader heard while the page was left untouched before the press. */
function readerBefore(texts: string[]): PressRecord {
  return pressRecord("record-reader-before", "virtual-screen-reader", "before", {
    liveRegionAnnouncementsWithoutInput: politeAnnouncements(texts)
  });
}

/** What Chrome's tree showed changing on its own while the page was left untouched. */
function accessibilityBefore(accessibilityChangesWithoutInput: AccessibilityChanges): PressRecord {
  return pressRecord("record-accessibility-before", "accessibility-tree", "before", {
    accessibilityChangesWithoutInput
  });
}

/** A polite clock, `<p aria-live="polite" aria-label="Clock">`, showing the given time. */
function clockRegion(time: string) {
  return {
    nodeId: 51,
    role: "paragraph",
    name: "Clock",
    politeness: "polite" as const,
    text: time
  };
}

/** The clock ticking from one time to the next, as Chrome's tree reports it. */
function clockTicks(from: string, to: string): AccessibilityChanges["changes"] {
  return [{ nodeId: 52, role: "StaticText", name: to, kind: "name", before: from, after: to }];
}

const statusRegion = {
  nodeId: 61,
  role: "status",
  politeness: "polite" as const,
  text: "Saved"
};

const agreeCheckbox = { nodeId: 11, role: "checkbox", name: "Agree" };
const moreButton = { nodeId: 21, role: "button", name: "More" };
const saveButton = { nodeId: 31, role: "button", name: "Save" };

/** The four presses AEE's audit item A3 named, as the observers record them in Chrome. */
const pressScenarios: Array<{
  title: string;
  kind: "enter" | "space";
  focusTarget: Record<string, unknown>;
  records: PressRecord[];
}> = [
  {
    title: "Space on a native checkbox ticks it; the markup does not change",
    kind: "space",
    focusTarget: { tagName: "input", type: "checkbox", role: "checkbox", name: "Agree" },
    records: [
      accessibilityAfter({
        focusedBefore: agreeCheckbox,
        focusedAfter: agreeCheckbox,
        changes: [
          { ...agreeCheckbox, kind: "state", state: "checked", before: "false", after: "true" }
        ],
        truncated: false
      }),
      markupAfter(false)
    ]
  },
  {
    title: "Enter on an aria-expanded toggle opens the panel it controls",
    kind: "enter",
    focusTarget: { tagName: "button", role: "button", name: "More" },
    records: [
      accessibilityAfter({
        focusedBefore: moreButton,
        focusedAfter: moreButton,
        changes: [
          { ...moreButton, kind: "state", state: "expanded", before: false, after: true },
          {
            nodeId: 22,
            role: "region",
            name: "Details",
            kind: "shown",
            controlledBy: [moreButton]
          },
          { nodeId: 23, role: "StaticText", name: "Shipping takes two days", kind: "shown" }
        ],
        truncated: false
      }),
      markupAfter(true)
    ]
  },
  {
    title: "Enter on a button whose only effect is a polite status message",
    kind: "enter",
    focusTarget: { tagName: "button", role: "button", name: "Save" },
    records: [
      accessibilityAfter({
        focusedBefore: saveButton,
        focusedAfter: saveButton,
        changes: [{ nodeId: 32, role: "StaticText", name: "Saved", kind: "shown" }],
        truncated: false
      }),
      readerAfter(["Saved"]),
      markupAfter(true)
    ]
  },
  {
    title: "Enter on a dead button while a clock elsewhere ticks",
    kind: "enter",
    focusTarget: { tagName: "button", role: "button", name: "Save" },
    records: [
      accessibilityAfter({
        focusedBefore: saveButton,
        focusedAfter: saveButton,
        changes: [
          { nodeId: 42, role: "StaticText", name: "10:01", kind: "shown" },
          { nodeId: 41, role: "StaticText", name: "10:00", kind: "hidden" }
        ],
        truncated: false
      }),
      markupAfter(true)
    ]
  },
  {
    title: "Enter on a dead button while a polite clock announces on its own",
    kind: "enter",
    focusTarget: { tagName: "button", role: "button", name: "Save" },
    records: [
      readerBefore(["10:00:02"]),
      accessibilityBefore({
        changes: clockTicks("10:00:01", "10:00:02"),
        truncated: false,
        liveRegions: [clockRegion("10:00:02")]
      }),
      accessibilityAfter({
        focusedBefore: saveButton,
        focusedAfter: saveButton,
        changes: clockTicks("10:00:02", "10:00:03"),
        truncated: false,
        liveRegions: [clockRegion("10:00:03")]
      }),
      readerAfter(["10:00:03"]),
      markupAfter(true)
    ]
  },
  {
    title: "Enter on a Save button whose status message appears while a polite clock ticks",
    kind: "enter",
    focusTarget: { tagName: "button", role: "button", name: "Save" },
    records: [
      readerBefore(["10:00:02"]),
      accessibilityBefore({
        changes: clockTicks("10:00:01", "10:00:02"),
        truncated: false,
        liveRegions: [clockRegion("10:00:02")]
      }),
      accessibilityAfter({
        focusedBefore: saveButton,
        focusedAfter: saveButton,
        changes: [
          ...clockTicks("10:00:02", "10:00:03"),
          { nodeId: 62, role: "StaticText", name: "Saved", kind: "shown" }
        ],
        truncated: false,
        liveRegions: [clockRegion("10:00:03"), statusRegion]
      }),
      readerAfter(["10:00:03", "Saved"]),
      markupAfter(true)
    ]
  },
  {
    title:
      "Enter on a dead button after the page announced on its own, with no tree to place the announcement",
    kind: "enter",
    focusTarget: { tagName: "button", role: "button", name: "Save" },
    records: [
      readerBefore(["Ticker: 3 new"]),
      accessibilityAfter({
        focusedBefore: saveButton,
        focusedAfter: saveButton,
        changes: [],
        truncated: false
      }),
      readerAfter(["Ticker: 4 new"])
    ]
  }
];

const expectedPressOutcomes: Array<{ verdict: Judgment["verdict"]; summary: RegExp }> = [
  { verdict: "pass", summary: /checkbox "Agree" checked changed from false to true/ },
  {
    verdict: "pass",
    summary:
      /button "More" expanded changed from false to true; region "Details" appeared, which button "More" controls/
  },
  { verdict: "pass", summary: /a live region announced "Saved" \(polite\)/ },
  // Not a fail: the page did change, and nothing says the press did not cause it. Not a pass:
  // nothing ties the change to the press. The judge says what changed and leaves it undecided.
  { verdict: "unknown", summary: /StaticText "10:01" appeared.*cannot be told/ },
  // The clock's announcement is named and not counted; with nothing else, the press is undecided.
  {
    verdict: "unknown",
    summary:
      /A live region announced "10:00:03" \(polite\) after the press, but that region, paragraph "Clock", was already announcing on its own while the page was left untouched \(before the press it said "10:00:02"\), so it is not counted/
  },
  // The status message comes from a region that was quiet before the press, so it still counts.
  {
    verdict: "pass",
    summary:
      /a live region announced "Saved" \(polite\)\).*A live region announced "10:00:03" \(polite\) after the press, but that region, paragraph "Clock", was already announcing/
  },
  {
    verdict: "unknown",
    summary:
      /announced "Ticker: 4 new" \(polite\) after the press, but the page was already announcing on its own.*"Ticker: 3 new".*does not show which live region/
  }
];

for (const judgeId of ["keyboard", "change-response"]) {
  pressScenarios.forEach((scenario, index) => {
    const expected = expectedPressOutcomes[index]!;
    test(`${judgeId} judge: ${scenario.title} -> ${expected.verdict}`, async () => {
      const judge = createDefaultJudgePlugins([judgeId])[0]!;
      const bundle = createBundle([...focusStaysOn(scenario.focusTarget), ...scenario.records], {
        kind: scenario.kind,
        target: { role: String(scenario.focusTarget.role), name: String(scenario.focusTarget.name) }
      });

      const [judgment] = await judge.judge(bundle, { runId: "run-1" });

      assert.equal(judgment?.verdict, expected.verdict);
      assert.match(judgment?.summary ?? "", expected.summary);
      if (expected.verdict === "pass") {
        assert.ok(
          judgment?.evidenceRecordIds.some((id) =>
            ["record-accessibility-after", "record-reader-after"].includes(id)
          )
        );
      }
    });
  });
}

test("the press judges name every announcement a self-announcing region made after the press, in one sentence", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0]!;
  const bundle = createBundle(
    [
      ...focusStaysOn({ tagName: "button", role: "button", name: "Save" }),
      readerBefore(["10:00:02"]),
      accessibilityBefore({
        changes: clockTicks("10:00:01", "10:00:02"),
        truncated: false,
        liveRegions: [clockRegion("10:00:02")]
      }),
      accessibilityAfter({
        focusedBefore: saveButton,
        focusedAfter: saveButton,
        changes: clockTicks("10:00:03", "10:00:04"),
        truncated: false,
        liveRegions: [clockRegion("10:00:03 10:00:04")]
      }),
      readerAfter(["10:00:03", "10:00:04"])
    ],
    { kind: "enter", target: { role: "button", name: "Save" } }
  );

  const [judgment] = await keyboardJudge.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "unknown");
  assert.match(
    judgment?.summary ?? "",
    /A live region announced "10:00:03" \(polite\), "10:00:04" \(polite\) after the press, but that region, paragraph "Clock", was already announcing on its own .*so they are not counted/
  );
  assert.equal(judgment?.summary.match(/A live region announced/g)?.length, 1);
  assert.ok(judgment?.evidenceRecordIds.includes("record-reader-before"));
  assert.ok(judgment?.evidenceRecordIds.includes("record-accessibility-before"));
});

test("keyboard judge fails a dead button even when unrelated markup changed", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0]!;
  const bundle = createBundle(
    [
      ...focusStaysOn({ tagName: "div", role: "button", name: "Save" }),
      accessibilityAfter({ focusedBefore: saveButton, changes: [], truncated: false }),
      // An injected script tag changes the markup and nothing a person perceives.
      markupAfter(true)
    ],
    { kind: "space", target: { role: "button", name: "Save" } }
  );

  const [judgment] = await keyboardJudge.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "fail");
  assert.equal(judgment?.severity, "high");
  assert.match(judgment?.summary ?? "", /no observable activation response/);
  assert.match(judgment?.summary ?? "", /supporting evidence only/);
  assert.match(
    judgment?.findings?.[0]?.message ?? "",
    /accessibility state, what it controls, focus, live regions and the network/
  );
});

test("keyboard judge leaves a press undecided when only the markup is known to have changed", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0]!;
  const bundle = createBundle(
    [...focusStaysOn({ tagName: "button", id: "save", name: "Save" }), markupAfter(true)],
    { kind: "enter", target: { role: "button", name: "Save" } }
  );

  const [judgment] = await keyboardJudge.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "unknown");
  assert.match(judgment?.summary ?? "", /needs the accessibility tree before and after/);
  assert.ok(judgment?.evidenceRecordIds.includes("record-dom-after"));
});

test("keyboard judge passes a press that renames the pressed control", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0]!;
  const playButton = { nodeId: 51, role: "button", name: "Pause" };
  const bundle = createBundle(
    [
      ...focusStaysOn({ tagName: "button", name: "Play" }),
      accessibilityAfter({
        focusedBefore: playButton,
        changes: [{ ...playButton, kind: "name", before: "Play", after: "Pause" }],
        truncated: false
      })
    ],
    { kind: "space", target: { role: "button", name: "Play" } }
  );

  const [judgment] = await keyboardJudge.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "pass");
  assert.match(judgment?.summary ?? "", /button name changed from "Play" to "Pause"/);
  assert.match(judgment?.summary ?? "", /Focus stayed/);
});

test("keyboard judge leaves Space on a link untested instead of reporting a false failure", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0];
  const focusTarget = { tagName: "a", role: "link", name: "Details" };
  const bundle = createBundle(
    [
      {
        id: "record-focus-before",
        runId: "run-1",
        observerId: "focus",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z",
        meta: { focusTarget }
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: { focusTarget }
      }
    ],
    { kind: "space", target: { role: "link", name: "Details" } }
  );

  const [judgment] = await keyboardJudge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment.verdict, "unknown");
  assert.match(judgment.summary, /Space is not an evaluated activation key/);
  assert.match(judgment.summary, /Evaluated key: Enter/);
  assert.match(judgment.summary, /remains untested/);
});

test("keyboard judge leaves activation of an already selected tab explicitly untested", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0];
  const focusTarget = {
    tagName: "button",
    role: "tab",
    name: "Overview",
    ariaSelected: true
  };
  const bundle = createBundle(
    [
      {
        id: "record-focus-before",
        runId: "run-1",
        observerId: "focus",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z",
        meta: { focusTarget }
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: { focusTarget }
      }
    ],
    { kind: "enter", target: { role: "tab", name: "Overview" } }
  );

  const [judgment] = await keyboardJudge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment.verdict, "unknown");
  assert.match(judgment.summary, /already active tab/);
  assert.match(judgment.summary, /more specific expected outcome/);
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

test("keyboard judge applies Home to the first item in a listbox", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0];
  const focusRecord = (phase: "before" | "after", index: number, name: string) => ({
    id: `record-focus-${phase}`,
    runId: "run-1",
    observerId: "focus",
    phase,
    status: "ok" as const,
    timestamp: "2026-06-21T10:00:01.000Z",
    meta: {
      focusTarget: {
        tagName: "div",
        role: "option",
        name,
        compositeRole: "listbox",
        compositeOrientation: "vertical",
        compositeItemIndex: index,
        compositeItemCount: 3
      }
    }
  });
  const bundle = createBundle(
    [focusRecord("before", 2, "Third"), focusRecord("after", 0, "First")],
    { kind: "arrow-key", input: "Home", target: { role: "option", name: "Third" } }
  );

  const [judgment] = await keyboardJudge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment.verdict, "pass");
  assert.match(judgment.summary, /Home navigation moved focus within the listbox/);
});

test("keyboard judge leaves a horizontal key on a vertical tablist explicitly untested", async () => {
  const keyboardJudge = createDefaultJudgePlugins(["keyboard"])[0];
  const target = {
    tagName: "button",
    role: "tab",
    name: "Overview",
    compositeRole: "tablist",
    compositeOrientation: "vertical",
    compositeItemIndex: 0,
    compositeItemCount: 2
  };
  const bundle = createBundle(
    [
      {
        id: "record-focus-before",
        runId: "run-1",
        observerId: "focus",
        phase: "before",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.000Z",
        meta: { focusTarget: target }
      },
      {
        id: "record-focus-after",
        runId: "run-1",
        observerId: "focus",
        phase: "after",
        status: "ok",
        timestamp: "2026-06-21T10:00:01.100Z",
        meta: { focusTarget: target }
      }
    ],
    { kind: "arrow-key", input: "ArrowRight", target: { role: "tab", name: "Overview" } }
  );

  const [judgment] = await keyboardJudge!.judge(bundle, { runId: "run-1" });

  assert.equal(judgment.verdict, "unknown");
  assert.match(judgment.summary, /not evaluated.*vertical tablist/);
  assert.match(judgment.summary, /ArrowUp, ArrowDown, Home, End/);
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

test("change-response judge passes a click that presses the clicked toggle", async () => {
  const judge = createDefaultJudgePlugins(["change-response"])[0]!;
  const muteButton = { nodeId: 61, role: "button", name: "Mute" };
  const bundle = createBundle(
    [
      accessibilityAfter({
        focusedAfter: muteButton,
        changes: [
          { ...muteButton, kind: "state", state: "pressed", before: "false", after: "true" }
        ],
        truncated: false
      }),
      markupAfter(true)
    ],
    { kind: "click", target: { role: "button", name: "Mute" } }
  );

  const [judgment] = await judge.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "pass");
  assert.match(judgment?.summary ?? "", /button "Mute" pressed changed from false to true/);
  assert.match(judgment?.summary ?? "", /supporting evidence only/);
});

test("change-response judge fails a click when nothing a person perceives changed", async () => {
  const judge = createDefaultJudgePlugins(["change-response"])[0]!;
  const bundle = createBundle(
    [accessibilityAfter({ changes: [], truncated: false }), markupAfter(false)],
    { kind: "click", target: { role: "button", name: "Save" } }
  );

  const [judgment] = await judge.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "fail");
  assert.match(judgment?.summary ?? "", /No observable response followed the click interaction/);
  assert.equal(judgment?.severity, "high");
});

test("change-response judge leaves a press undecided when only the markup changed", async () => {
  const judge = createDefaultJudgePlugins(["change-response"])[0]!;
  const bundle = createBundle([markupAfter(true)], {
    kind: "click",
    target: { role: "button", name: "Save" }
  });

  const [judgment] = await judge.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "unknown");
  assert.match(judgment?.summary ?? "", /needs the accessibility tree before and after/);
});

test("change-response judge fails a space activation with no response and says how to fix it", async () => {
  const judge = createDefaultJudgePlugins(["change-response"])[0]!;
  const bundle = createBundle(
    [
      ...focusStaysOn({ tagName: "div", role: "button", name: "Save" }),
      accessibilityAfter({ focusedBefore: saveButton, changes: [], truncated: false })
    ],
    { kind: "space", target: { role: "button", name: "Save" } }
  );

  const [judgment] = await judge.judge(bundle, { runId: "run-1" });

  assert.equal(judgment?.verdict, "fail");
  assert.match(judgment?.summary ?? "", /No observable response followed the space interaction/);
  assert.match(judgment?.suggestedFix ?? "", /space interaction activates the target/i);
});
