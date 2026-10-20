import {
  DEFAULT_POLICY,
  focusPlace,
  readerFocusOf,
  spokenRoleOf,
  TEXT_ROLE,
  type AccessibilityChange,
  type AccessibilityChanges,
  type AccessibilityNodeRef,
  type EvidenceBundle,
  type EvidenceRecord,
  type Finding,
  type JudgePlugin,
  type Judgment,
  type LiveRegionAnnouncement,
  type LiveRegionRef,
  type TargetDescriptor
} from "@aee/core";

const KEYBOARD_JUDGE_VERSION = "0.4.1";
const CHANGE_RESPONSE_JUDGE_VERSION = "0.4.1";

export const defaultJudgeManifests = [
  {
    id: "structure",
    displayName: "Structure Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: ["evidence-completeness"]
  },
  {
    id: "keyboard",
    displayName: "Keyboard Judge",
    version: KEYBOARD_JUDGE_VERSION,
    kind: "judge" as const,
    capabilities: [
      "focus-order",
      "tab-flow",
      "role-aware-keyboard-activation",
      "composite-key-matrix"
    ]
  },
  {
    id: "focus-management",
    displayName: "Focus Management Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: ["dialog-focus-transfer"]
  },
  {
    id: "interaction",
    displayName: "Interaction Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: []
  },
  {
    id: "screen-reader",
    displayName: "Screen Reader Judge",
    version: "0.3.0",
    kind: "judge" as const,
    capabilities: [
      "virtual-cursor-focus-separation",
      "transcript-presence",
      "dom-aom-semantic-agreement",
      "rendered-visual-presence"
    ]
  },
  {
    id: "visual",
    displayName: "Visual Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: []
  },
  {
    id: "change-response",
    displayName: "Change Response Judge",
    version: CHANGE_RESPONSE_JUDGE_VERSION,
    kind: "judge" as const,
    capabilities: ["observable-change-detection"]
  },
  {
    id: "axe",
    displayName: "axe Results Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: ["axe-violation-gating", "axe-incomplete-propagation"]
  },
  {
    id: "release",
    displayName: "Release Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: ["policy-gating"]
  }
];

export function createUnknownJudge(judgeId: string): JudgePlugin {
  const manifest = defaultJudgeManifests.find((candidate) => candidate.id === judgeId);

  if (!manifest) {
    throw new Error(`Unknown judge manifest: ${judgeId}`);
  }

  return {
    manifest,
    async judge(bundle: EvidenceBundle): Promise<Judgment[]> {
      return [
        {
          id: `${judgeId}:${bundle.interaction.id}`,
          judgeId,
          judgeVersion: "0.1.0",
          scope: "interaction",
          verdict: "unknown",
          summary: "Judge scaffold only. No production logic has been implemented yet.",
          evidenceRecordIds: bundle.records.map((record) => record.id)
        }
      ];
    }
  };
}

export function createBuiltinJudge(judgeId: string): JudgePlugin {
  if (judgeId === "structure") {
    return createStructureJudge();
  }

  if (judgeId === "keyboard") {
    return createKeyboardJudge();
  }

  if (judgeId === "focus-management") {
    return createFocusManagementJudge();
  }

  if (judgeId === "screen-reader") {
    return createScreenReaderJudge();
  }

  if (judgeId === "change-response") {
    return createChangeResponseJudge();
  }

  if (judgeId === "axe") {
    return createAxeJudge();
  }

  if (judgeId === "release") {
    return createReleaseJudge();
  }

  return createUnknownJudge(judgeId);
}

export function createDefaultJudgePlugins(
  judgeIds: string[] = defaultJudgeManifests.map((manifest) => manifest.id)
): JudgePlugin[] {
  return judgeIds.map((judgeId) => createBuiltinJudge(judgeId));
}

function createStructureJudge(): JudgePlugin {
  const manifest = defaultJudgeManifests.find((candidate) => candidate.id === "structure");

  if (!manifest) {
    throw new Error("Missing structure judge manifest.");
  }

  return {
    manifest,
    async judge(bundle: EvidenceBundle): Promise<Judgment[]> {
      const domOk = bundle.records.some(
        (record) => record.observerId === "dom" && record.status === "ok"
      );
      const accessibilityOk = bundle.records.some(
        (record) => record.observerId === "accessibility-tree" && record.status === "ok"
      );

      const verdict = domOk && accessibilityOk ? "pass" : "fail";
      const summary =
        verdict === "pass"
          ? "Structural evidence inputs were captured from both the DOM and accessibility tree."
          : "Structural evidence inputs are incomplete. Expected both DOM and accessibility tree capture.";

      return [
        {
          id: `structure:${bundle.interaction.id}`,
          judgeId: "structure",
          judgeVersion: "0.1.0",
          scope: "interaction",
          verdict,
          summary,
          severity: verdict === "pass" ? "info" : "medium",
          confidence: 0.9,
          evidenceRecordIds: bundle.records.map((record) => record.id)
        }
      ];
    }
  };
}

function createKeyboardJudge(): JudgePlugin {
  const manifest = defaultJudgeManifests.find((candidate) => candidate.id === "keyboard");

  if (!manifest) {
    throw new Error("Missing keyboard judge manifest.");
  }

  return {
    manifest,
    async judge(bundle: EvidenceBundle): Promise<Judgment[]> {
      if (bundle.interaction.kind === "tab" || bundle.interaction.kind === "shift-tab") {
        return judgeTabFocusTransition(bundle);
      }

      if (bundle.interaction.kind === "arrow-key") {
        return judgeCompositeArrowNavigation(bundle);
      }

      if (bundle.interaction.kind === "enter" || bundle.interaction.kind === "space") {
        return judgeKeyboardActivation(bundle);
      }

      return [
        buildKeyboardUnknownJudgment(
          bundle,
          "Keyboard judge currently evaluates tab navigation, roving arrow-key navigation, and enter/space activation only.",
          "info",
          0.5
        )
      ];
    }
  };
}

function createFocusManagementJudge(): JudgePlugin {
  const manifest = defaultJudgeManifests.find((candidate) => candidate.id === "focus-management");

  if (!manifest) {
    throw new Error("Missing focus-management judge manifest.");
  }

  return {
    manifest,
    async judge(bundle: EvidenceBundle): Promise<Judgment[]> {
      const expectation = getStringMetaField(bundle.interaction.meta, "focusExpectation");

      if (!expectation || !["inside-dialog", "preserve", "target"].includes(expectation)) {
        return [
          {
            id: `focus-management:${bundle.interaction.id}`,
            judgeId: "focus-management",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "unknown",
            summary:
              'Focus-management judge requires interaction.meta.focusExpectation to be "inside-dialog", "preserve", or "target".',
            severity: "info",
            confidence: 0.5,
            evidenceRecordIds: bundle.records.map((record) => record.id)
          }
        ];
      }

      const beforeRecord = findFocusRecord(bundle.records, "before");
      const afterRecord = findFocusRecord(bundle.records, "after");

      if (!beforeRecord || !afterRecord) {
        return [
          {
            id: `focus-management:${bundle.interaction.id}`,
            judgeId: "focus-management",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "unknown",
            summary:
              "Focus-management judge requires focus observer evidence before and after the interaction.",
            severity: "medium",
            confidence: 0.75,
            evidenceRecordIds: bundle.records.map((record) => record.id)
          }
        ];
      }

      const beforeTarget = getFocusTarget(beforeRecord);
      const afterTarget = getFocusTarget(afterRecord);
      if (expectation === "preserve") {
        return judgePreservedFocus(bundle, beforeRecord, afterRecord, beforeTarget, afterTarget);
      }
      if (expectation === "target") {
        return judgeFocusedTarget(bundle, beforeRecord, afterRecord, beforeTarget, afterTarget);
      }
      const beforeDialog = isRecord(beforeTarget) ? beforeTarget.dialogContext : undefined;
      const afterDialog = isRecord(afterTarget) ? afterTarget.dialogContext : undefined;
      const evidenceRecordIds = [beforeRecord.id, afterRecord.id];
      const artifactIds = collectArtifactIds([beforeRecord, afterRecord]);

      if (isRecord(beforeDialog)) {
        return [
          {
            id: `focus-management:${bundle.interaction.id}`,
            judgeId: "focus-management",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "unknown",
            summary:
              "Focus was already inside a dialog before the interaction, so an initial dialog-focus transfer could not be evaluated.",
            severity: "medium",
            confidence: 0.85,
            evidenceRecordIds,
            artifactIds,
            tags: ["focus-management", "dialog", "interaction-state"]
          }
        ];
      }

      if (!isRecord(afterDialog)) {
        const suggestedFix =
          "When the modal opens, move focus to an appropriate element inside it, such as its heading or least-destructive action.";
        const finding: Finding = {
          id: `focus-management:${bundle.interaction.id}:dialog-focus-not-moved`,
          message: "The interaction opened a dialog but focus did not move inside it.",
          severity: "high",
          ruleId: "dialog-initial-focus",
          target: bundle.interaction.target,
          evidenceRecordIds,
          artifactIds,
          suggestedFix,
          tags: ["focus-management", "dialog", "interaction-state"]
        };

        return [
          {
            id: `focus-management:${bundle.interaction.id}`,
            judgeId: "focus-management",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "fail",
            summary: `Dialog opened, but focus remained outside it. Before: ${describeFocusTarget(beforeTarget)}. After: ${describeFocusTarget(afterTarget)}.`,
            severity: "high",
            confidence: 0.95,
            evidenceRecordIds,
            artifactIds,
            findings: [finding],
            suggestedFix,
            tags: ["focus-management", "dialog", "interaction-state"]
          }
        ];
      }

      const dialogName = getStringField(afterDialog, "name");
      return [
        {
          id: `focus-management:${bundle.interaction.id}`,
          judgeId: "focus-management",
          judgeVersion: "0.1.0",
          scope: "interaction",
          verdict: "pass",
          summary: `Focus moved from ${describeFocusTarget(beforeTarget)} to ${describeFocusTarget(afterTarget)} inside the opened dialog${dialogName ? ` "${dialogName}"` : ""}.`,
          severity: "info",
          confidence: 0.95,
          evidenceRecordIds,
          artifactIds,
          tags: ["focus-management", "dialog", "interaction-state"]
        }
      ];
    }
  };
}

function judgePreservedFocus(
  bundle: EvidenceBundle,
  beforeRecord: EvidenceRecord,
  afterRecord: EvidenceRecord,
  beforeTarget: unknown,
  afterTarget: unknown
): Judgment[] {
  const evidenceRecordIds = [beforeRecord.id, afterRecord.id];
  const artifactIds = collectArtifactIds([beforeRecord, afterRecord]);
  const preserved = focusIdentity(beforeTarget) === focusIdentity(afterTarget);
  const suggestedFix = preserved
    ? undefined
    : "Do not move DOM focus for an interaction that only reveals or announces supplemental information.";
  const finding: Finding | undefined = preserved
    ? undefined
    : {
        id: `focus-management:${bundle.interaction.id}:unexpected-focus-move`,
        message: "The interaction moved focus even though focus was expected to remain unchanged.",
        severity: "high",
        ruleId: "focus-preservation",
        target: bundle.interaction.target,
        evidenceRecordIds,
        artifactIds,
        suggestedFix,
        tags: ["focus-management", "interaction-state"]
      };

  return [
    {
      id: `focus-management:${bundle.interaction.id}`,
      judgeId: "focus-management",
      judgeVersion: "0.2.0",
      scope: "interaction",
      verdict: preserved ? "pass" : "fail",
      summary: preserved
        ? `Focus remained on ${describeFocusTarget(beforeTarget)} as required.`
        : `Focus unexpectedly moved from ${describeFocusTarget(beforeTarget)} to ${describeFocusTarget(afterTarget)}.`,
      severity: preserved ? "info" : "high",
      confidence: 0.98,
      evidenceRecordIds,
      artifactIds,
      ...(finding ? { findings: [finding] } : {}),
      ...(suggestedFix ? { suggestedFix } : {}),
      tags: ["focus-management", "interaction-state"]
    }
  ];
}

function judgeFocusedTarget(
  bundle: EvidenceBundle,
  beforeRecord: EvidenceRecord,
  afterRecord: EvidenceRecord,
  beforeTarget: unknown,
  afterTarget: unknown
): Judgment[] {
  const evidenceRecordIds = [beforeRecord.id, afterRecord.id];
  const artifactIds = collectArtifactIds([beforeRecord, afterRecord]);
  const expectedTarget = bundle.interaction.target;
  const matched = focusMatchesTarget(afterTarget, expectedTarget);

  if (typeof matched === "string") {
    return [
      {
        id: `focus-management:${bundle.interaction.id}`,
        judgeId: "focus-management",
        judgeVersion: "0.3.0",
        scope: "interaction",
        verdict: "unknown",
        summary: `The captured focus target cannot be deterministically matched to the requested target. ${matched}`,
        severity: "medium",
        confidence: 0.8,
        evidenceRecordIds,
        artifactIds,
        tags: ["focus-management", "interaction-state"]
      }
    ];
  }

  const focusedAt = readerFocusOf(getDeepFocusTarget(afterTarget));
  const suggestedFix = matched
    ? undefined
    : "After the focus action, ensure document.activeElement resolves to the requested control.";
  const finding: Finding | undefined = matched
    ? undefined
    : {
        id: `focus-management:${bundle.interaction.id}:target-not-focused`,
        message: "The requested control did not receive focus.",
        severity: "high",
        ruleId: "focus-target",
        target: expectedTarget,
        evidenceRecordIds,
        artifactIds,
        suggestedFix,
        tags: ["focus-management", "interaction-state"]
      };
  return [
    {
      id: `focus-management:${bundle.interaction.id}`,
      judgeId: "focus-management",
      judgeVersion: "0.3.0",
      scope: "interaction",
      verdict: matched ? "pass" : "fail",
      summary: matched
        ? `Focus resolved to the requested target ${describeFocusTarget(afterTarget)}.`
        : `Focus did not resolve to the requested target${expectedTarget?.selector ? ` (selector ${expectedTarget.selector})` : ""}. Before: ${describeFocusTarget(beforeTarget)}. After: ${describeFocusTarget(afterTarget)}${focusedAt ? ` at ${focusPlace(focusedAt)}` : ""}.`,
      severity: matched ? "info" : "high",
      confidence: 0.98,
      evidenceRecordIds,
      artifactIds,
      ...(finding ? { findings: [finding] } : {}),
      ...(suggestedFix ? { suggestedFix } : {}),
      tags: ["focus-management", "interaction-state"]
    }
  ];
}

function focusIdentity(focusTarget: unknown): string {
  const target = getDeepFocusTarget(focusTarget);
  if (!isRecord(target)) return "none";
  return JSON.stringify({
    nodePath: getStringField(target, "nodePath"),
    id: getStringField(target, "id"),
    role: getStringField(target, "role"),
    name: getStringField(target, "name")
  });
}

/**
 * Whether focus is on the requested target: true or false, or why that cannot be told. Role and
 * name are compared with the accessibility tree's. A selector is not compared as text with the
 * focused element's path, since two elements can have the same path in their own documents and one
 * element can be selected in many ways: the focus observer resolves it in the page and records
 * whether the element it selects is the one with focus (`requestedTarget`).
 */
function focusMatchesTarget(
  focusTarget: unknown,
  expectedTarget: EvidenceBundle["interaction"]["target"]
): boolean | string {
  const target = getDeepFocusTarget(focusTarget);
  if (!isRecord(target)) return "No element was recorded with focus.";
  if (!expectedTarget) return "The interaction names no requested target.";
  // Role and name come from the accessibility tree; without it, whether they match is unknown.
  const role = getStringField(target, "role");
  const name = getStringField(target, "name");
  if ((expectedTarget.role && role === undefined) || (expectedTarget.name && name === undefined)) {
    return "The focused element's role or name was not read from the accessibility tree.";
  }
  if (expectedTarget.role && role !== expectedTarget.role) return false;
  if (expectedTarget.name && name !== expectedTarget.name) return false;
  if (expectedTarget.selector) {
    const requested = isRecord(focusTarget) ? focusTarget.requestedTarget : undefined;
    if (!isRecord(requested) || requested.selector !== expectedTarget.selector) {
      return `The focus record does not say whether the element ${expectedTarget.selector} selects is the one with focus, and the selector's text cannot be compared with the focused element's path.`;
    }
    if (requested.status === "focused") return true;
    if (requested.status === "not-focused") return false;
    return (
      getStringField(requested, "reason") ??
      `Whether the element ${expectedTarget.selector} selects has focus could not be told.`
    );
  }
  return expectedTarget.role || expectedTarget.name
    ? true
    : "The requested target has no role, name or selector.";
}

function getDeepFocusTarget(focusTarget: unknown): unknown {
  return isRecord(focusTarget) && isRecord(focusTarget.deepActiveElement)
    ? focusTarget.deepActiveElement
    : focusTarget;
}

/**
 * Where focus landed, as a focus record shows it. When no element of a document has focus, the
 * browser names the document's `<body>` (or `<html>`) as its active element (HTML's
 * `activeElement`), so a `<body>` alone does not say that anything has focus:
 * - `element`: an element has focus, or a `<body>` with a place in the tab order, such as a frame
 *   with nothing to focus, which Chrome's Tab stops on and whose `<body>` is then active;
 * - `lost`: no element has focus while the page still has it: nothing was recorded, or a `<body>`
 *   with no place in the counted tab order while `document.hasFocus()` is true;
 * - `left-page`: a `<body>` while the page itself has no focus (`document.hasFocus()` false), as
 *   after Tab from the last tab stop moves focus to the browser's own controls;
 * - `undecided`: a `<body>` the record cannot tell apart from those.
 */
type FocusLanding =
  | { kind: "element" }
  | { kind: "lost" }
  | { kind: "left-page" }
  | { kind: "undecided"; reason: string };

function focusLandingOf(focusTarget: unknown): FocusLanding {
  if (!isRecord(focusTarget)) return { kind: "lost" };
  const element = getDeepFocusTarget(focusTarget);
  const tagName = getStringField(element, "tagName");
  if (tagName !== "body" && tagName !== "html") return { kind: "element" };
  if (getNumericField(element, "focusOrderIndex") !== undefined) return { kind: "element" };
  if (focusTarget.documentHasFocus === false) return { kind: "left-page" };
  if (focusTarget.documentHasFocus !== true) {
    return {
      kind: "undecided",
      reason:
        "The focus record does not say whether the page still had focus, so focus on a document's <body> cannot be told apart from focus leaving the page for the browser's own controls."
    };
  }
  if (getNumericField(element, "focusableCount") === undefined) {
    return {
      kind: "undecided",
      reason:
        "The page's tab order could not be counted, so whether this <body> is a tab stop (a frame with nothing to focus) or focus was lost cannot be told."
    };
  }
  return { kind: "lost" };
}

/** What a focus record's `<body>` stands for, which its tag alone does not say. */
function describeFocusLanding(focusTarget: Record<string, unknown>): string {
  const landing = focusLandingOf(focusTarget);
  if (landing.kind === "lost") return " (no element has focus)";
  if (landing.kind === "left-page") return " (the page no longer has focus)";
  const element = getDeepFocusTarget(focusTarget);
  if (
    landing.kind !== "element" ||
    !["body", "html"].includes(getStringField(element, "tagName") ?? "")
  ) {
    return "";
  }
  return isRecord(element) && Array.isArray(element.framePath)
    ? " (its frame has nothing to focus, so the frame is a tab stop itself)"
    : " (a tab stop itself)";
}

function describeUndecidedLanding(landing: Exclude<FocusLanding, { kind: "element" | "lost" }>) {
  return landing.kind === "left-page"
    ? "The page no longer had focus, so where focus went cannot be told from the page."
    : landing.reason;
}

function judgeTabFocusTransition(bundle: EvidenceBundle): Judgment[] {
  const beforeRecord = findFocusRecord(bundle.records, "before");
  const afterRecord = findFocusRecord(bundle.records, "after");

  if (!beforeRecord || !afterRecord) {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        "Keyboard judge requires focus observer evidence before and after the interaction.",
        "medium",
        0.75
      )
    ];
  }

  const beforeTarget = getFocusTarget(beforeRecord);
  const afterTarget = getFocusTarget(afterRecord);
  const beforeKey = serializeFocusTarget(beforeTarget);
  const afterKey = serializeFocusTarget(afterTarget);
  const beforeOrderIndex = getNumericField(beforeTarget, "focusOrderIndex");
  const afterOrderIndex = getNumericField(afterTarget, "focusOrderIndex");
  const focusableCount =
    getNumericField(beforeTarget, "focusableCount") ??
    getNumericField(afterTarget, "focusableCount");

  const landing = focusLandingOf(afterTarget);

  if (landing.kind === "lost") {
    const finding: Finding = {
      id: `keyboard:${bundle.interaction.id}:focus-lost`,
      message: "Keyboard interaction left the page without a focused target.",
      severity: "high",
      ruleId: "keyboard-focus-presence",
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
      suggestedFix: "Ensure a visible, interactive control retains focus after keyboard navigation."
    };

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: KEYBOARD_JUDGE_VERSION,
        scope: "interaction",
        verdict: "fail",
        summary: `Keyboard interaction lost focus. Before: ${describeFocusTarget(beforeTarget)}. After: ${describeFocusTarget(afterTarget)}.`,
        severity: "high",
        confidence: 0.95,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [finding],
        suggestedFix: finding.suggestedFix
      }
    ];
  }

  if (landing.kind === "undecided") {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        `Keyboard focus moved from ${describeFocusTarget(beforeTarget)} to ${describeFocusTarget(afterTarget)}. ${landing.reason}`,
        "medium",
        0.75,
        [beforeRecord.id, afterRecord.id]
      )
    ];
  }

  if (landing.kind === "left-page") {
    return judgeTabOutOfPage(bundle, beforeRecord, afterRecord, beforeOrderIndex, focusableCount);
  }

  if (beforeKey === afterKey) {
    const finding: Finding = {
      id: `keyboard:${bundle.interaction.id}:focus-stalled`,
      message: "Tab interaction did not move focus to a new target.",
      severity: "medium",
      ruleId: "keyboard-focus-transition",
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
      suggestedFix: "Ensure the next tabbable control receives focus after keyboard navigation."
    };

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: KEYBOARD_JUDGE_VERSION,
        scope: "interaction",
        verdict: "fail",
        summary: `Keyboard focus did not advance. Before: ${describeFocusTarget(beforeTarget)}. After: ${describeFocusTarget(afterTarget)}.`,
        severity: "medium",
        confidence: 0.9,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [finding],
        suggestedFix: finding.suggestedFix
      }
    ];
  }

  const directionVerdict = evaluateDirection(
    bundle.interaction.kind as "tab" | "shift-tab",
    beforeOrderIndex,
    afterOrderIndex,
    focusableCount
  );

  if (directionVerdict === "wrong-direction") {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        `${describeTabKey(bundle)} moved focus from ${describeFocusTarget(beforeTarget)} at ${describeTabPlace(beforeOrderIndex!, focusableCount!)} to ${describeFocusTarget(afterTarget)} at ${describeTabPlace(afterOrderIndex!, focusableCount!)}. That disagrees with the tab order AEE predicts. ${TAB_ORDER_PREDICTION_LIMITS}`,
        "medium",
        0.6,
        [beforeRecord.id, afterRecord.id]
      )
    ];
  }

  const directionText =
    bundle.interaction.kind === "shift-tab" ? "moved backward" : "advanced forward";
  const orderingSuffix =
    directionVerdict === "direction-unverified"
      ? " Focus order metadata was unavailable, so direction was inferred from the target change only."
      : "";

  return [
    {
      id: `keyboard:${bundle.interaction.id}`,
      judgeId: "keyboard",
      judgeVersion: KEYBOARD_JUDGE_VERSION,
      scope: "interaction",
      verdict: "pass",
      summary: `Keyboard focus ${directionText} from ${describeFocusTarget(beforeTarget)} to ${describeFocusTarget(afterTarget)}.${orderingSuffix}`,
      severity: "info",
      confidence: directionVerdict === "direction-unverified" ? 0.75 : 0.95,
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord])
    }
  ];
}

/**
 * Why a Tab that disagrees with the predicted tab order is left undecided rather than failed: the
 * browser's Tab is what a keyboard user gets, and the prediction is a model of it.
 */
const TAB_ORDER_PREDICTION_LIMITS =
  "The browser's Tab is what a keyboard user gets, and the prediction can be wrong: Chrome, for one, puts a popover's content right after the control that opened it, where tabbable keeps document order. Whether the page moved focus out of order cannot be told from this evidence.";

function describeTabKey(bundle: EvidenceBundle): "Tab" | "Shift+Tab" {
  return bundle.interaction.kind === "shift-tab" ? "Shift+Tab" : "Tab";
}

function describeTabPlace(orderIndex: number, focusableCount: number): string {
  return `place ${orderIndex + 1} of ${focusableCount} in the tab order`;
}

/**
 * Judges a Tab or Shift+Tab after which the page no longer has focus. The browser's Tab moves
 * focus out of the page, to its own controls, from the last tab stop, and Shift+Tab from the
 * first, so either is the page's tab order working. From any other tab stop it disagrees with the
 * predicted order.
 */
function judgeTabOutOfPage(
  bundle: EvidenceBundle,
  beforeRecord: EvidenceRecord,
  afterRecord: EvidenceRecord,
  beforeOrderIndex: number | undefined,
  focusableCount: number | undefined
): Judgment[] {
  const beforeTarget = getFocusTarget(beforeRecord);
  const key = describeTabKey(bundle);
  const evidenceRecordIds = [beforeRecord.id, afterRecord.id];
  const pass = (summary: string, confidence: number): Judgment[] => [
    {
      id: `keyboard:${bundle.interaction.id}`,
      judgeId: "keyboard",
      judgeVersion: KEYBOARD_JUDGE_VERSION,
      scope: "interaction",
      verdict: "pass",
      summary,
      severity: "info",
      confidence,
      evidenceRecordIds,
      artifactIds: collectArtifactIds([beforeRecord, afterRecord])
    }
  ];

  if (beforeOrderIndex === undefined || focusableCount === undefined) {
    return pass(
      `Keyboard focus left the page for the browser's own controls after ${key} from ${describeFocusTarget(beforeTarget)}. Focus order metadata was unavailable, so whether that was the page's ${key === "Tab" ? "last" : "first"} tab stop was not checked.`,
      0.75
    );
  }

  const edge = key === "Tab" ? focusableCount - 1 : 0;
  if (beforeOrderIndex === edge) {
    return pass(
      `Keyboard focus left the page for the browser's own controls ${key === "Tab" ? "after the page's last" : "before the page's first"} tab stop (place ${edge + 1} of ${focusableCount}), as the browser's ${key} does. Before: ${describeFocusTarget(beforeTarget)}.`,
      0.95
    );
  }

  return [
    buildKeyboardUnknownJudgment(
      bundle,
      `${key} moved focus out of the page, to the browser's own controls, from ${describeFocusTarget(beforeTarget)} at ${describeTabPlace(beforeOrderIndex, focusableCount)}. That disagrees with the tab order AEE predicts, which has more tab stops ${key === "Tab" ? "after" : "before"} it. ${TAB_ORDER_PREDICTION_LIMITS}`,
      "medium",
      0.6,
      evidenceRecordIds
    )
  ];
}

function getRoleActivationExpectation(
  focusTarget: unknown,
  interactionKind: "enter" | "space"
): { status: "evaluated" | "unsupported" | "unknown"; expectedKeys: string[] } {
  if (!isRecord(focusTarget)) return { status: "unknown", expectedKeys: [] };
  const role = getStringField(focusTarget, "role");
  const tagName = getStringField(focusTarget, "tagName");
  const type = getStringField(focusTarget, "type");
  const keysByRole: Record<string, Array<"enter" | "space">> = {
    button: ["enter", "space"],
    link: ["enter"],
    checkbox: ["space"],
    radio: ["space"],
    switch: ["space"],
    menuitem: ["enter", "space"],
    menuitemcheckbox: ["enter", "space"],
    menuitemradio: ["enter", "space"],
    tab: ["enter", "space"]
  };
  let expected = role ? keysByRole[role] : undefined;
  if (!expected && tagName === "button") expected = ["enter", "space"];
  if (!expected && tagName === "summary") expected = ["enter", "space"];
  if (!expected && tagName === "a") expected = ["enter"];
  if (!expected && tagName === "input") {
    expected = ["button", "submit", "reset", "image"].includes(type ?? "")
      ? ["enter", "space"]
      : ["checkbox", "radio"].includes(type ?? "")
        ? ["space"]
        : undefined;
  }
  if (!expected) return { status: "unknown", expectedKeys: [] };
  return {
    status: expected.includes(interactionKind) ? "evaluated" : "unsupported",
    expectedKeys: expected.map(formatKeyboardKey)
  };
}

function formatKeyboardKey(key: "enter" | "space"): "Enter" | "Space" {
  return key === "enter" ? "Enter" : "Space";
}

function judgeKeyboardActivation(bundle: EvidenceBundle): Judgment[] {
  const beforeRecord = findFocusRecord(bundle.records, "before");
  const afterRecord = findFocusRecord(bundle.records, "after");

  if (!beforeRecord || !afterRecord) {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        "Keyboard activation checks require focus observer evidence before and after the interaction.",
        "medium",
        0.75
      )
    ];
  }

  const beforeTarget = getFocusTarget(beforeRecord);
  const afterTarget = getFocusTarget(afterRecord);
  const beforeKey = serializeFocusTarget(beforeTarget);
  const afterKey = serializeFocusTarget(afterTarget);
  const activationKind = bundle.interaction.kind as "enter" | "space";
  const activationExpectation = getRoleActivationExpectation(beforeTarget, activationKind);

  if (activationExpectation.status !== "evaluated") {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        activationExpectation.status === "unsupported"
          ? `${formatKeyboardKey(activationKind)} is not an evaluated activation key for ${describeFocusTarget(beforeTarget)}. Evaluated key${activationExpectation.expectedKeys.length === 1 ? "" : "s"}: ${activationExpectation.expectedKeys.join(", ")}. This authored key/control combination remains untested rather than being treated as an accessibility failure.`
          : `No deterministic Enter/Space activation matrix entry exists for ${describeFocusTarget(beforeTarget)}.`,
        "info",
        1,
        [beforeRecord.id, afterRecord.id]
      )
    ];
  }

  if (!isActivatableKeyboardTarget(bundle.interaction.target, beforeTarget)) {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        "Keyboard activation checks currently apply to activatable controls only.",
        "info",
        0.6,
        [beforeRecord.id, afterRecord.id]
      )
    ];
  }

  if (
    isRecord(beforeTarget) &&
    ((beforeTarget.role === "tab" && beforeTarget.selected === true) ||
      (beforeTarget.role === "radio" && beforeTarget.checked === true))
  ) {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        `${formatKeyboardKey(activationKind)} was applied to an already active ${String(beforeTarget.role)}. No additional observable change is required, so this action remains untested unless the scenario declares a more specific expected outcome.`,
        "info",
        1,
        [beforeRecord.id, afterRecord.id]
      )
    ];
  }

  const landing = focusLandingOf(afterTarget);

  if (landing.kind === "undecided" || landing.kind === "left-page") {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        `After keyboard ${bundle.interaction.kind} on ${describeFocusTarget(beforeTarget)}, focus was on ${describeFocusTarget(afterTarget)}. ${describeUndecidedLanding(landing)}`,
        "medium",
        0.7,
        [beforeRecord.id, afterRecord.id]
      )
    ];
  }

  if (landing.kind === "lost") {
    const finding: Finding = {
      id: `keyboard:${bundle.interaction.id}:activation-focus-lost`,
      message: "Keyboard activation left the page without a focused target.",
      severity: "high",
      ruleId: "keyboard-activation-focus-presence",
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
      suggestedFix:
        "Keep focus on the activated control or move it intentionally to the resulting UI."
    };

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: KEYBOARD_JUDGE_VERSION,
        scope: "interaction",
        verdict: "fail",
        summary: `Keyboard activation lost focus. Before: ${describeFocusTarget(beforeTarget)}. After: ${describeFocusTarget(afterTarget)}.`,
        severity: "high",
        confidence: 0.95,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [finding],
        suggestedFix: finding.suggestedFix
      }
    ];
  }

  const response = collectPressResponse(bundle);
  const activationSignals = response.signals;
  const undecided = activationSignals.length === 0 ? describeUndecidedPress(response) : undefined;

  if (undecided) {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        `Keyboard ${bundle.interaction.kind} on ${describeFocusTarget(beforeTarget)} showed no response of its own. ${undecided}${describeSupportingEvidence(response)}`,
        "medium",
        0.7,
        [
          beforeRecord.id,
          afterRecord.id,
          ...response.unattributed.evidenceRecordIds,
          ...response.ownAnnouncements.evidenceRecordIds,
          ...response.markupRecords.map((record) => record.id)
        ]
      )
    ];
  }

  if (activationSignals.length === 0) {
    const evidenceRecords = [
      beforeRecord,
      afterRecord,
      ...(response.accessibilityRecord ? [response.accessibilityRecord] : []),
      ...response.markupRecords
    ];
    const evidenceRecordIds = evidenceRecords.map((record) => record.id);
    const artifactIds = collectArtifactIds(evidenceRecords);
    const suggestedFix = `Ensure ${bundle.interaction.kind} activates the focused control and responds in a way a keyboard or screen-reader user perceives: ${describePerceivableResponses()}`;

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: KEYBOARD_JUDGE_VERSION,
        scope: "interaction",
        verdict: "fail",
        summary: `Keyboard ${bundle.interaction.kind} produced no observable activation response for ${describeFocusTarget(beforeTarget)}.${describeSupportingEvidence(response)}`,
        severity: "high",
        confidence: 0.9,
        evidenceRecordIds,
        artifactIds,
        findings: [
          {
            id: `keyboard:${bundle.interaction.id}:activation-no-response`,
            message: `Expected ${bundle.interaction.kind} to activate the focused control, but its accessibility state, what it controls, focus, live regions and the network all stayed the same.`,
            severity: "high",
            ruleId: "keyboard-activation-response",
            evidenceRecordIds,
            artifactIds,
            suggestedFix
          }
        ],
        suggestedFix
      }
    ];
  }

  const evidenceRecordIds = [
    ...new Set(activationSignals.flatMap((signal) => signal.evidenceRecordIds))
  ];
  const artifactIds = [...new Set(activationSignals.flatMap((signal) => signal.artifactIds))];
  const focusOutcome =
    beforeKey === afterKey
      ? `Focus stayed on ${describeFocusTarget(afterTarget)}.`
      : `Focus moved from ${describeFocusTarget(beforeTarget)} to ${describeFocusTarget(afterTarget)}.`;

  return [
    {
      id: `keyboard:${bundle.interaction.id}`,
      judgeId: "keyboard",
      judgeVersion: KEYBOARD_JUDGE_VERSION,
      scope: "interaction",
      verdict: "pass",
      summary: `Keyboard ${bundle.interaction.kind} produced observable activation signals (${activationSignals.map((signal) => signal.label).join(", ")}). ${focusOutcome}${describeSupportingEvidence(response)}`,
      severity: "info",
      confidence: 0.9,
      evidenceRecordIds,
      artifactIds: artifactIds.length > 0 ? artifactIds : undefined
    }
  ];
}

function judgeCompositeArrowNavigation(bundle: EvidenceBundle): Judgment[] {
  const beforeRecord = findFocusRecord(bundle.records, "before");
  const afterRecord = findFocusRecord(bundle.records, "after");

  if (!beforeRecord || !afterRecord) {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        "Arrow-key checks require focus observer evidence before and after the interaction.",
        "medium",
        0.75
      )
    ];
  }

  const beforeTarget = getCompositeNavigationTarget(beforeRecord);
  const afterTarget = getCompositeNavigationTarget(afterRecord);
  const beforeKey = serializeFocusTarget(beforeTarget);
  const afterKey = serializeFocusTarget(afterTarget);
  const arrowKey = getArrowKey(bundle);

  if (!arrowKey) {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        "Arrow-key checks require interaction.input or interaction.meta.key to specify the pressed arrow key.",
        "medium",
        0.7,
        [beforeRecord.id, afterRecord.id]
      )
    ];
  }

  const compositeRole = getCompositeNavigationRole(
    bundle.interaction.target,
    beforeTarget,
    afterTarget
  );
  if (!compositeRole) {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        "Arrow-key checks currently apply to detectable roving-focus composites such as tablists, radiogroups, listboxes, menus, trees, and grids.",
        "info",
        0.65,
        [beforeRecord.id, afterRecord.id]
      )
    ];
  }

  const compositeOrientation =
    getStringField(beforeTarget, "compositeOrientation") ??
    getStringField(afterTarget, "compositeOrientation");
  const navigationExpectation = getCompositeNavigationExpectation(
    compositeRole,
    compositeOrientation,
    arrowKey
  );
  if (navigationExpectation.status !== "evaluated") {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        `${arrowKey} is not evaluated as a deterministic focus-movement key for a ${compositeOrientation ? `${compositeOrientation} ` : ""}${compositeRole}. Evaluated keys: ${navigationExpectation.expectedKeys.join(", ") || "none"}. Complex expand, collapse, and popup behavior requires an explicit outcome assertion.`,
        "info",
        1,
        [beforeRecord.id, afterRecord.id]
      )
    ];
  }

  // Where DOM focus landed, which an active descendant is a place inside.
  const landing = focusLandingOf(getFocusTarget(afterRecord));

  if (landing.kind === "undecided" || landing.kind === "left-page") {
    return [
      buildKeyboardUnknownJudgment(
        bundle,
        `After ${arrowKey} in the ${compositeRole}, focus was on ${describeFocusTarget(afterTarget)}. ${describeUndecidedLanding(landing)}`,
        "medium",
        0.7,
        [beforeRecord.id, afterRecord.id]
      )
    ];
  }

  if (landing.kind === "lost") {
    const finding: Finding = {
      id: `keyboard:${bundle.interaction.id}:composite-focus-lost`,
      message: "Arrow-key navigation left the composite widget without a focused target.",
      severity: "high",
      ruleId: "keyboard-composite-focus-presence",
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
      suggestedFix:
        "Keep focus within the composite widget while arrow-key navigation is in progress."
    };

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: KEYBOARD_JUDGE_VERSION,
        scope: "interaction",
        verdict: "fail",
        summary: `Arrow-key navigation lost focus within the ${compositeRole}. Before: ${describeFocusTarget(beforeTarget)}. After: ${describeFocusTarget(afterTarget)}.`,
        severity: "high",
        confidence: 0.95,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [finding],
        suggestedFix: finding.suggestedFix
      }
    ];
  }

  const stationaryEndpointIsValid =
    (arrowKey === "Home" || arrowKey === "End") &&
    evaluateCompositeArrowDirection(
      arrowKey,
      getNumericField(beforeTarget, "compositeItemIndex"),
      getNumericField(afterTarget, "compositeItemIndex"),
      getNumericField(beforeTarget, "compositeItemCount") ??
        getNumericField(afterTarget, "compositeItemCount")
    ) === "correct-direction";

  if (beforeKey === afterKey && !stationaryEndpointIsValid) {
    const finding: Finding = {
      id: `keyboard:${bundle.interaction.id}:composite-focus-stalled`,
      message: "Arrow-key navigation did not move focus to another item in the composite widget.",
      severity: "high",
      ruleId: "keyboard-composite-focus-transition",
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
      suggestedFix: `Ensure ${arrowKey} moves focus to another item in the ${compositeRole}.`
    };

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: KEYBOARD_JUDGE_VERSION,
        scope: "interaction",
        verdict: "fail",
        summary: `Arrow-key navigation did not move focus within the ${compositeRole}. Before: ${describeFocusTarget(beforeTarget)}. After: ${describeFocusTarget(afterTarget)}.`,
        severity: "high",
        confidence: 0.9,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [finding],
        suggestedFix: finding.suggestedFix
      }
    ];
  }

  if (!isSameCompositeNavigationContext(beforeTarget, afterTarget, compositeRole)) {
    const finding: Finding = {
      id: `keyboard:${bundle.interaction.id}:composite-focus-escaped`,
      message: "Arrow-key navigation moved focus outside the expected composite widget items.",
      severity: "high",
      ruleId: "keyboard-composite-focus-scope",
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
      suggestedFix: `Keep ${arrowKey} navigation scoped to peer items in the ${compositeRole}.`
    };

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: KEYBOARD_JUDGE_VERSION,
        scope: "interaction",
        verdict: "fail",
        summary: `Arrow-key navigation moved focus outside the expected ${compositeRole}. Before: ${describeFocusTarget(beforeTarget)}. After: ${describeFocusTarget(afterTarget)}.`,
        severity: "high",
        confidence: 0.9,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [finding],
        suggestedFix: finding.suggestedFix
      }
    ];
  }

  const directionVerdict = evaluateCompositeArrowDirection(
    arrowKey,
    getNumericField(beforeTarget, "compositeItemIndex"),
    getNumericField(afterTarget, "compositeItemIndex"),
    getNumericField(beforeTarget, "compositeItemCount") ??
      getNumericField(afterTarget, "compositeItemCount")
  );

  if (directionVerdict === "wrong-direction") {
    const suggestedFix = `Ensure ${arrowKey} follows the item order within the ${compositeRole}.`;

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: KEYBOARD_JUDGE_VERSION,
        scope: "interaction",
        verdict: "fail",
        summary: `Arrow-key navigation moved in the wrong direction within the ${compositeRole}. Before: ${describeFocusTarget(beforeTarget)}. After: ${describeFocusTarget(afterTarget)}.`,
        severity: "high",
        confidence: 0.95,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [
          {
            id: `keyboard:${bundle.interaction.id}:composite-wrong-direction`,
            message: `Expected ${arrowKey} to move focus in the matching direction within the ${compositeRole}, but it moved differently.`,
            severity: "high",
            ruleId: "keyboard-composite-focus-direction",
            evidenceRecordIds: [beforeRecord.id, afterRecord.id],
            artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
            suggestedFix
          }
        ],
        suggestedFix
      }
    ];
  }

  const directionSuffix =
    directionVerdict === "direction-unverified"
      ? " Composite item ordering metadata was unavailable, so direction was inferred from the focus move only."
      : "";

  return [
    {
      id: `keyboard:${bundle.interaction.id}`,
      judgeId: "keyboard",
      judgeVersion: KEYBOARD_JUDGE_VERSION,
      scope: "interaction",
      verdict: "pass",
      summary: `${arrowKey} navigation ${beforeKey === afterKey ? "kept focus at the requested endpoint" : "moved focus"} within the ${compositeRole} from ${describeFocusTarget(beforeTarget)} to ${describeFocusTarget(afterTarget)}.${directionSuffix}`,
      severity: "info",
      confidence: directionVerdict === "direction-unverified" ? 0.75 : 0.95,
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord])
    }
  ];
}

function createChangeResponseJudge(): JudgePlugin {
  const manifest = defaultJudgeManifests.find((candidate) => candidate.id === "change-response");

  if (!manifest) {
    throw new Error("Missing change-response judge manifest.");
  }

  return {
    manifest,
    async judge(bundle: EvidenceBundle): Promise<Judgment[]> {
      if (!supportsChangeResponseInteraction(bundle.interaction.kind)) {
        return [
          {
            id: `change-response:${bundle.interaction.id}`,
            judgeId: "change-response",
            judgeVersion: CHANGE_RESPONSE_JUDGE_VERSION,
            scope: "interaction",
            verdict: "unknown",
            summary:
              "Change-response judge currently evaluates click, enter, space, and submit interactions only.",
            severity: "info",
            confidence: 0.5,
            evidenceRecordIds: bundle.records.map((record) => record.id)
          }
        ];
      }

      if (!isResponseExpectedForInteraction(bundle.interaction, bundle.records)) {
        return [
          {
            id: `change-response:${bundle.interaction.id}`,
            judgeId: "change-response",
            judgeVersion: CHANGE_RESPONSE_JUDGE_VERSION,
            scope: "interaction",
            verdict: "unknown",
            summary:
              "Change-response judge could not determine whether this interaction was expected to trigger a visible or network response.",
            severity: "info",
            confidence: 0.6,
            evidenceRecordIds: bundle.records.map((record) => record.id)
          }
        ];
      }

      const response = collectPressResponse(bundle);
      const observedSignals = response.signals;

      if (observedSignals.length === 0) {
        const undecided = describeUndecidedPress(response);
        if (undecided) {
          return [
            {
              id: `change-response:${bundle.interaction.id}`,
              judgeId: "change-response",
              judgeVersion: CHANGE_RESPONSE_JUDGE_VERSION,
              scope: "interaction",
              verdict: "unknown",
              summary: `No response of its own followed the ${bundle.interaction.kind} interaction on ${describeTarget(bundle.interaction.target)}. ${undecided}${describeFocusLoss(response, bundle.interaction.kind)}${describeSupportingEvidence(response)}`,
              severity: "medium",
              confidence: 0.7,
              evidenceRecordIds: bundle.records.map((record) => record.id)
            }
          ];
        }

        const evidenceRecords = [
          response.accessibilityRecord!,
          ...(response.clickFocus?.records ?? []),
          ...response.markupRecords
        ];
        const evidenceRecordIds = evidenceRecords.map((record) => record.id);
        const artifactIds = collectArtifactIds(evidenceRecords);
        const suggestedFix = buildChangeResponseSuggestedFix(bundle.interaction.kind);

        return [
          {
            id: `change-response:${bundle.interaction.id}`,
            judgeId: "change-response",
            judgeVersion: CHANGE_RESPONSE_JUDGE_VERSION,
            scope: "interaction",
            verdict: "fail",
            summary: `No observable response followed the ${bundle.interaction.kind} interaction on ${describeTarget(bundle.interaction.target)}.${describeFocusLoss(response, bundle.interaction.kind)}${describeSupportingEvidence(response)}`,
            severity: "high",
            confidence: 0.9,
            evidenceRecordIds,
            artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
            findings: [
              {
                id: `change-response:${bundle.interaction.id}:no-response`,
                message: `Expected ${bundle.interaction.kind} to change the control's accessibility state or what it controls, move focus elsewhere, update a live region or reach the network, but none of that happened.`,
                severity: "high",
                ruleId: "interaction-response-observable",
                evidenceRecordIds,
                artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
                suggestedFix
              }
            ],
            suggestedFix
          }
        ];
      }

      return [
        {
          id: `change-response:${bundle.interaction.id}`,
          judgeId: "change-response",
          judgeVersion: CHANGE_RESPONSE_JUDGE_VERSION,
          scope: "interaction",
          verdict: "pass",
          summary: `Observed response signals after the ${bundle.interaction.kind} interaction (${observedSignals.map((signal) => signal.label).join(", ")}).${describeFocusLoss(response, bundle.interaction.kind)}${describeSupportingEvidence(response)}`,
          severity: "info",
          confidence: 0.9,
          evidenceRecordIds: [
            ...new Set(observedSignals.flatMap((signal) => signal.evidenceRecordIds))
          ],
          artifactIds: [...new Set(observedSignals.flatMap((signal) => signal.artifactIds))]
        }
      ];
    }
  };
}

function createScreenReaderJudge(): JudgePlugin {
  const manifest = defaultJudgeManifests.find((candidate) => candidate.id === "screen-reader");

  if (!manifest) {
    throw new Error("Missing screen-reader judge manifest.");
  }

  return {
    manifest,
    async judge(bundle: EvidenceBundle): Promise<Judgment[]> {
      const record = bundle.records.find(
        (candidate) =>
          candidate.observerId === "virtual-screen-reader" &&
          candidate.phase === "after" &&
          candidate.status === "ok"
      );

      if (!record) {
        return [
          {
            id: `screen-reader:${bundle.interaction.id}`,
            judgeId: "screen-reader",
            judgeVersion: "0.3.0",
            scope: "interaction",
            verdict: "unknown",
            summary:
              "Screen-reader judgment requires a successful portable virtual-reader transcript after the command.",
            severity: "medium",
            confidence: 1,
            evidenceRecordIds: bundle.records
              .filter((candidate) => candidate.observerId === "virtual-screen-reader")
              .map((candidate) => candidate.id),
            artifactIds: collectArtifactIds(
              bundle.records.filter((candidate) => candidate.observerId === "virtual-screen-reader")
            )
          }
        ];
      }

      const newEntryCount = getNumberMetaField(record.meta, "newEntryCount") ?? 0;
      const focusMovedCount = getNumberMetaField(record.meta, "focusMovedCount") ?? 0;
      const lastAnnouncement = getStringMetaField(record.meta, "lastAnnouncement");
      const artifactIds = collectArtifactIds([record]);

      if (focusMovedCount > 0) {
        return [
          {
            id: `screen-reader:${bundle.interaction.id}`,
            judgeId: "screen-reader",
            judgeVersion: "0.3.0",
            scope: "interaction",
            verdict: "fail",
            summary: `The virtual-reader command moved DOM focus during ${focusMovedCount} transcript entr${focusMovedCount === 1 ? "y" : "ies"}; virtual cursor movement and focus movement must remain separate.`,
            severity: "high",
            confidence: 1,
            evidenceRecordIds: [record.id],
            artifactIds,
            suggestedFix:
              "Remove focus-changing behavior from virtual-reader navigation and test explicit focus actions separately."
          }
        ];
      }

      if (newEntryCount === 0 || !lastAnnouncement) {
        return [
          {
            id: `screen-reader:${bundle.interaction.id}`,
            judgeId: "screen-reader",
            judgeVersion: "0.3.0",
            scope: "interaction",
            verdict: "unknown",
            summary:
              "No new announced virtual-reader command was present after the interaction, so the result cannot be evaluated.",
            severity: "medium",
            confidence: 1,
            evidenceRecordIds: [record.id],
            artifactIds
          }
        ];
      }

      const lastItem = isRecord(record.meta?.lastItem) ? record.meta.lastItem : undefined;
      const supportingRecords = ["dom", "accessibility-tree", "visual"].map((observerId) =>
        bundle.records.find(
          (candidate) =>
            candidate.observerId === observerId &&
            candidate.phase === "after" &&
            candidate.status === "ok"
        )
      );
      const missingObservers = ["dom", "accessibility-tree", "visual"].filter(
        (_observerId, index) => !supportingRecords[index]
      );
      const availableSupportingRecords = supportingRecords.filter(
        (candidate): candidate is EvidenceRecord => Boolean(candidate)
      );
      const correlatedRecords = [record, ...availableSupportingRecords];

      if (!lastItem || missingObservers.length > 0) {
        return [
          {
            id: `screen-reader:${bundle.interaction.id}`,
            judgeId: "screen-reader",
            judgeVersion: "0.3.0",
            scope: "interaction",
            verdict: "unknown",
            summary: lastItem
              ? `Portable-reader semantic agreement cannot be evaluated because same-checkpoint ${missingObservers.join(", ")} evidence is missing.`
              : `The portable reader announced “${lastAnnouncement}”, but no semantic target was present to compare with the DOM, accessibility tree, and full-page visual context.`,
            severity: "medium",
            confidence: 1,
            evidenceRecordIds: correlatedRecords.map(({ id }) => id),
            artifactIds: collectArtifactIds(correlatedRecords)
          }
        ];
      }

      const domRecord = supportingRecords[0]!;
      const accessibilityRecord = supportingRecords[1]!;
      const visualRecord = supportingRecords[2]!;
      const domSnapshotPresent = recordHasArtifact(domRecord, "dom-snapshot");
      const fullPageVisualPresent = recordHasArtifactPath(visualRecord, "full-page");
      const renderedBoundsPresent = hasPositiveVisualBounds(lastItem.visualBounds);
      const treeComparison = compareWithCheckpointNode(
        accessibilityRecord.meta?.semanticNodes,
        lastItem
      );
      const accessibilityIndexTruncated = accessibilityRecord.meta?.semanticIndexTruncated === true;

      if (!domSnapshotPresent || !fullPageVisualPresent || !renderedBoundsPresent) {
        const unavailable = [
          !domSnapshotPresent ? "full DOM snapshot" : undefined,
          !fullPageVisualPresent ? "full-page screenshot" : undefined,
          !renderedBoundsPresent ? "non-zero rendered bounds" : undefined
        ].filter((value): value is string => Boolean(value));
        return [
          {
            id: `screen-reader:${bundle.interaction.id}`,
            judgeId: "screen-reader",
            judgeVersion: "0.3.0",
            scope: "interaction",
            verdict: "unknown",
            summary: `The portable-reader target could not be fully correlated because ${unavailable.join(", ")} evidence was unavailable.`,
            severity: "medium",
            confidence: 1,
            evidenceRecordIds: correlatedRecords.map(({ id }) => id),
            artifactIds: collectArtifactIds(correlatedRecords)
          }
        ];
      }

      if (treeComparison.kind !== "same") {
        const role = getStringField(lastItem, "role") ?? "unknown role";
        const name = getStringField(lastItem, "name");
        const read = `${role}${name ? ` “${name}”` : ""}`;
        const undecided =
          treeComparison.kind === "unjoinable" ||
          (treeComparison.kind === "missing" && accessibilityIndexTruncated);
        const summary =
          treeComparison.kind === "unjoinable"
            ? `The portable reader read ${read}, but its record names no DOM node, so it cannot be compared with that same element in the tree captured at this checkpoint.`
            : treeComparison.kind === "missing"
              ? accessibilityIndexTruncated
                ? `The accessibility-tree semantic index was truncated before the element the portable reader read (${read}) could be found.`
                : `The portable reader read ${read} from the browser's accessibility tree, but that element is not in the tree captured at this checkpoint.`
              : `The portable reader read ${read} from the browser's accessibility tree, but the tree captured at this checkpoint describes that same element differently: ${treeComparison.differences.join("; ")}.`;
        return [
          {
            id: `screen-reader:${bundle.interaction.id}`,
            judgeId: "screen-reader",
            judgeVersion: "0.3.0",
            scope: "interaction",
            verdict: undecided ? "unknown" : "fail",
            summary,
            severity: undecided ? "medium" : "high",
            confidence: 1,
            evidenceRecordIds: correlatedRecords.map(({ id }) => id),
            artifactIds: collectArtifactIds(correlatedRecords),
            ...(!undecided
              ? {
                  findings: [
                    {
                      id: `screen-reader-semantic-mismatch:${bundle.interaction.id}`,
                      ruleId: "portable-reader-semantic-agreement",
                      message: summary,
                      severity: "high" as const,
                      target: {
                        role: getStringField(lastItem, "role"),
                        name: getStringField(lastItem, "name"),
                        nodePath: getStringField(lastItem, "nodePath")
                      },
                      evidenceRecordIds: correlatedRecords.map(({ id }) => id),
                      artifactIds: collectArtifactIds(correlatedRecords),
                      suggestedFix:
                        "Reconcile the rendered control's DOM semantics with the browser accessibility tree, then rerun the same reader command."
                    }
                  ]
                }
              : {})
          }
        ];
      }

      // Guidepup's reader works out an element's name itself, and the browser works it out too.
      // When the announcement leaves out the name the browser gives the element, the two disagree,
      // so what a screen reader would say here is not decided.
      const browserName = getStringField(lastItem, "name");
      const announced = normalizeSemanticValue(lastAnnouncement) ?? "";
      if (browserName && !announced.includes(normalizeSemanticValue(browserName) ?? "")) {
        const role = getStringField(lastItem, "role") ?? "element";
        return [
          {
            id: `screen-reader:${bundle.interaction.id}`,
            judgeId: "screen-reader",
            judgeVersion: "0.3.0",
            scope: "interaction",
            verdict: "unknown",
            summary: `The portable reader announced “${lastAnnouncement}”, but the browser names this ${role} “${browserName}”: the two disagree on its accessible name, so what a screen reader says here is not decided.`,
            severity: "medium",
            confidence: 1,
            evidenceRecordIds: correlatedRecords.map(({ id }) => id),
            artifactIds: collectArtifactIds(correlatedRecords)
          }
        ];
      }

      return [
        {
          id: `screen-reader:${bundle.interaction.id}`,
          judgeId: "screen-reader",
          judgeVersion: "0.3.0",
          scope: "interaction",
          verdict: "pass",
          summary: `The portable virtual reader announced “${lastAnnouncement}” without moving DOM focus. The element it read has the same role, name, description, value and states in the accessibility tree captured at this checkpoint, and its non-zero rendered bounds are covered by the full-page screenshot. This verifies deterministic semantic agreement and visual presence, not pixel meaning or VoiceOver/NVDA fidelity.`,
          severity: "info",
          confidence: 1,
          evidenceRecordIds: correlatedRecords.map(({ id }) => id),
          artifactIds: collectArtifactIds(correlatedRecords)
        }
      ];
    }
  };
}

function recordHasArtifact(record: EvidenceRecord, kind: string): boolean {
  return (record.artifacts ?? []).some((artifact) => artifact.kind === kind);
}

function recordHasArtifactPath(record: EvidenceRecord, pathPart: string): boolean {
  return (record.artifacts ?? []).some((artifact) => artifact.path.includes(pathPart));
}

function hasPositiveVisualBounds(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.width === "number" &&
    value.width > 0 &&
    typeof value.height === "number" &&
    value.height > 0
  );
}

/** How the element the reader read compares with the same element in the checkpoint's tree. */
type TreeComparison =
  | { kind: "same" }
  /** The reader's item names no DOM node, so the same element cannot be found. */
  | { kind: "unjoinable" }
  | { kind: "missing" }
  | { kind: "different"; differences: string[] };

/**
 * Finds the node the reader read in the checkpoint's accessibility tree by its DOM node and the
 * frame holding it (node ids repeat across frames rendered in other processes), and
 * compares what the reader recorded about it with what the tree says: role, name, description,
 * value and every state and property, and whether the tree leaves it out.
 */
function compareWithCheckpointNode(
  nodes: unknown,
  target: Record<string, unknown>
): TreeComparison {
  const nodeId = getNumericField(target, "backendDOMNodeId");
  if (nodeId === undefined || !Array.isArray(nodes)) return { kind: "unjoinable" };
  const frameId = getStringField(target, "frameId");
  const node: unknown = nodes.find(
    (candidate) =>
      isRecord(candidate) &&
      candidate.backendDOMNodeId === nodeId &&
      (frameId === undefined || candidate.frameId === undefined || candidate.frameId === frameId)
  );
  if (!isRecord(node)) return { kind: "missing" };

  const differences: string[] = [];
  const compare = (what: string, read: unknown, tree: unknown) => {
    const shown = (value: unknown) =>
      value === undefined || value === "" ? "none" : `“${String(value)}”`;
    const comparable = (value: unknown) =>
      value === undefined ? "" : (normalizeSemanticValue(String(value)) ?? "");
    if (comparable(read) !== comparable(tree)) {
      differences.push(`${what} ${shown(read)} when read, ${shown(tree)} in the tree`);
    }
  };
  // The reader reads a piece of text on its own; in the tree it is a StaticText named by its words.
  const readsText = getStringField(target, "role") === TEXT_ROLE;
  compare("role", target.role, spokenRoleOf(getStringField(node, "role") ?? ""));
  compare("name", readsText ? target.text : target.name, node.name);
  if (!readsText) {
    compare("description", target.description, node.description);
    compare("value", target.value, node.value);
  }
  if (Array.isArray(target.properties)) {
    const read = propertiesByName(target.properties);
    const tree = propertiesByName(node.properties);
    for (const name of new Set([...read.keys(), ...tree.keys()])) {
      if (read.get(name) !== tree.get(name)) {
        differences.push(
          `${name} ${read.get(name) ?? "absent"} when read, ${tree.get(name) ?? "absent"} in the tree`
        );
      }
    }
  }
  if (node.ignored === true) {
    const reasons = Array.isArray(node.ignoredReasons) ? node.ignoredReasons.join(", ") : "";
    differences.push(`the tree leaves it out${reasons ? ` (${reasons})` : ""}`);
  }
  return differences.length ? { kind: "different", differences } : { kind: "same" };
}

/** Each state or property by name, its value written out so two can be compared. */
function propertiesByName(properties: unknown): Map<string, string> {
  if (!Array.isArray(properties)) return new Map();
  return new Map(
    properties.flatMap((property) =>
      isRecord(property) && typeof property.name === "string"
        ? [[property.name, JSON.stringify(property.value)] as const]
        : []
    )
  );
}

function normalizeSemanticValue(value: string | undefined): string | undefined {
  return value?.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

function createAxeJudge(): JudgePlugin {
  const manifest = defaultJudgeManifests.find((candidate) => candidate.id === "axe");

  if (!manifest) {
    throw new Error("Missing axe judge manifest.");
  }

  return {
    manifest,
    async judge(bundle: EvidenceBundle): Promise<Judgment[]> {
      const record = bundle.records.find(
        (candidate) =>
          candidate.observerId === "axe" && candidate.phase === "after" && candidate.status === "ok"
      );

      if (!record) {
        return [
          {
            id: `axe:${bundle.interaction.id}`,
            judgeId: "axe",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "unknown",
            summary: "Axe judgment requires a successful post-interaction axe evidence record.",
            severity: "medium",
            confidence: 1,
            evidenceRecordIds: bundle.records
              .filter((candidate) => candidate.observerId === "axe")
              .map((candidate) => candidate.id),
            artifactIds: collectArtifactIds(
              bundle.records.filter((candidate) => candidate.observerId === "axe")
            )
          }
        ];
      }

      const violations = getNumberMetaField(record.meta, "violations") ?? 0;
      const incomplete = getNumberMetaField(record.meta, "incomplete") ?? 0;
      const violationRuleIds = getStringArrayMetaField(record.meta, "violationRuleIds");
      const incompleteRuleIds = getStringArrayMetaField(record.meta, "incompleteRuleIds");
      const artifactIds = collectArtifactIds([record]);
      // Best-practice results are findings on whatever verdict the WCAG rules give; they never
      // decide it, so they never block release.
      const advisoryRuleIds = getStringArrayMetaField(record.meta, "advisoryRuleIds");
      const advisoryFindings: Finding[] = advisoryRuleIds.map((ruleId) => ({
        id: `axe:${bundle.interaction.id}:${ruleId}`,
        message: `axe reported the ${ruleId} best-practice rule as a violation.`,
        severity: "low",
        ruleId,
        tags: ["best-practice"],
        evidenceRecordIds: [record.id],
        artifactIds,
        suggestedFix:
          "Review the raw axe nodes; a best-practice result is advisory and does not block release."
      }));
      const advisory = advisoryFindings.length ? { findings: advisoryFindings } : {};
      // A frame whose page is outside the allowed origins is left out of axe with its element, so
      // axe's frame-title rule does not see it; its name is Chrome's accessibility tree's.
      const framesNotChecked = readFramesNotChecked(record.meta);
      const framesSummary = framesNotChecked
        .map(
          ({ url, name, reason }) =>
            ` axe did not check the frame ${name ? `“${name}”` : "with no accessible name"} at ${url}. ${reason}`
        )
        .join("");
      const unnamedFrameFindings: Finding[] = framesNotChecked
        .filter(({ name }) => !name)
        .map(({ url }) => ({
          id: `axe:${bundle.interaction.id}:frame-title:${url}`,
          message: `The frame at ${url} has no accessible name in Chrome's accessibility tree.`,
          severity: "high",
          ruleId: "frame-title",
          evidenceRecordIds: [record.id],
          artifactIds,
          suggestedFix: "Give the frame a title attribute that describes what it shows."
        }));

      if (violations > 0 || unnamedFrameFindings.length > 0) {
        const impacts = isRecord(record.meta?.violationImpacts) ? record.meta.violationImpacts : {};
        const findings: Finding[] = violationRuleIds.map((ruleId) => ({
          id: `axe:${bundle.interaction.id}:${ruleId}`,
          message: `axe reported the ${ruleId} rule as a violation.`,
          severity: severityForAxeImpact(impacts[ruleId]),
          ruleId,
          evidenceRecordIds: [record.id],
          artifactIds,
          suggestedFix:
            "Review the raw axe nodes together with DOM, accessibility-tree, and visual evidence."
        }));

        return [
          {
            id: `axe:${bundle.interaction.id}`,
            judgeId: "axe",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "fail",
            summary: `axe found ${violations} violation${violations === 1 ? "" : "s"}${formatRuleIds(violationRuleIds)}. ${incomplete} check${incomplete === 1 ? " remains" : "s remain"} incomplete${formatRuleIds(incompleteRuleIds)}.${framesSummary}`,
            severity: "high",
            confidence: 1,
            evidenceRecordIds: [record.id],
            artifactIds,
            findings: [...findings, ...unnamedFrameFindings, ...advisoryFindings],
            suggestedFix:
              "Resolve the reported axe violations and manually evaluate incomplete checks using the correlated evidence."
          }
        ];
      }

      if (incomplete > 0 || framesNotChecked.length > 0) {
        return [
          {
            id: `axe:${bundle.interaction.id}`,
            judgeId: "axe",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "unknown",
            summary:
              incomplete > 0
                ? `axe found no violations, but ${incomplete} check${incomplete === 1 ? " requires" : "s require"} review${formatRuleIds(incompleteRuleIds)}.${framesSummary}`
                : `axe found no violations in what it checked.${framesSummary}`,
            severity: "medium",
            confidence: 1,
            evidenceRecordIds: [record.id],
            artifactIds,
            ...advisory,
            suggestedFix:
              "Evaluate incomplete axe checks with the DOM, accessibility tree, screenshots, and full-page context."
          }
        ];
      }

      return [
        {
          id: `axe:${bundle.interaction.id}`,
          judgeId: "axe",
          judgeVersion: "0.1.0",
          scope: "interaction",
          verdict: "pass",
          summary: `axe found no violations or incomplete checks in the cumulative WCAG 2.0/2.1/2.2 A/AA rule selection.${advisoryFindings.length ? ` ${advisoryFindings.length} best-practice result${advisoryFindings.length === 1 ? " is" : "s are"} advisory${formatRuleIds(advisoryRuleIds)}.` : ""}`,
          severity: "info",
          confidence: 1,
          evidenceRecordIds: [record.id],
          artifactIds,
          ...advisory
        }
      ];
    }
  };
}

function getNumberMetaField(
  meta: Record<string, unknown> | undefined,
  field: string
): number | undefined {
  const value = meta?.[field];
  return typeof value === "number" ? value : undefined;
}

/** The frames an axe record lists as left out, such as those outside the allowed origins. */
function readFramesNotChecked(
  meta: Record<string, unknown> | undefined
): Array<{ url: string; name: string; reason: string }> {
  const value = meta?.framesNotChecked;
  return Array.isArray(value)
    ? value.filter(isRecord).map((frame) => ({
        url: String(frame.url ?? ""),
        name: typeof frame.name === "string" ? frame.name : "",
        reason: String(frame.reason ?? "")
      }))
    : [];
}

function getStringArrayMetaField(
  meta: Record<string, unknown> | undefined,
  field: string
): string[] {
  const value = meta?.[field];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

/**
 * AEE's severity for axe's impact, one step for each: critical stays critical, serious is high,
 * moderate is medium and minor is low. A rule axe gives no impact keeps "high", as every axe
 * violation had before. It labels a finding only: whether the judgment blocks release does not
 * depend on it.
 */
const SEVERITY_BY_AXE_IMPACT: Record<string, Finding["severity"]> = {
  critical: "critical",
  serious: "high",
  moderate: "medium",
  minor: "low"
};

function severityForAxeImpact(impact: unknown): Finding["severity"] {
  return (typeof impact === "string" && SEVERITY_BY_AXE_IMPACT[impact]) || "high";
}

function formatRuleIds(ruleIds: string[]): string {
  return ruleIds.length > 0 ? ` (${ruleIds.join(", ")})` : "";
}

function createReleaseJudge(): JudgePlugin {
  const manifest = defaultJudgeManifests.find((candidate) => candidate.id === "release");

  if (!manifest) {
    throw new Error("Missing release judge manifest.");
  }

  return {
    manifest,
    async judge(bundle: EvidenceBundle, context): Promise<Judgment[]> {
      const observerErrors = bundle.records.filter((record) => record.status === "observer_error");
      const unsupported = bundle.records.filter((record) => record.status === "unsupported");
      const releasePolicy = context.releasePolicy ?? DEFAULT_POLICY.release;
      const priorJudgments = (context.priorJudgments ?? []).filter((judgment) =>
        meetsMinimumConfidence(judgment, releasePolicy.minimumConfidence)
      );
      const blockingFailures = priorJudgments.filter(
        (judgment) =>
          judgment.verdict === "fail" &&
          typeof judgment.severity === "string" &&
          releasePolicy.failOnSeverities.includes(judgment.severity)
      );
      const unresolvedUnknowns = priorJudgments.filter(
        (judgment) => judgment.verdict === "unknown"
      );
      let verdict: Judgment["verdict"] = "pass";
      let summary = "Release gate passed. No blocking judgments met the current policy threshold.";
      let severity: Judgment["severity"] = "info";
      let suggestedFix: string | undefined;
      let evidenceRecordIds = bundle.records.map((record) => record.id);
      let artifactIds: string[] | undefined;

      if (observerErrors.length > 0) {
        verdict = "fail";
        summary = `Release gate failed because ${describeObserverCount(observerErrors.length, "observer error")} blocked evidence capture.`;
        severity = "high";
        suggestedFix =
          "Stabilize or replace the observers that errored before relying on this release gate.";
        evidenceRecordIds = observerErrors.map((record) => record.id);
        artifactIds = collectArtifactIds(observerErrors);
      } else if (blockingFailures.length > 0) {
        verdict = "fail";
        summary = `Release gate failed because ${describeJudgmentCount(blockingFailures.length, "blocking judgment")} met the current policy threshold.`;
        severity = "high";
        suggestedFix =
          "Resolve the blocking accessibility judgments or relax the release policy intentionally.";
        evidenceRecordIds = collectJudgmentEvidenceIds(blockingFailures);
        artifactIds = collectJudgmentArtifactIds(blockingFailures);
      } else if (unsupported.length > 0 || unresolvedUnknowns.length > 0) {
        const unresolvedSummary = describeUnresolvedSignals(
          unsupported.length,
          unresolvedUnknowns.length
        );

        if (releasePolicy.unknownBehavior === "fail") {
          verdict = "fail";
          summary = `Release gate failed because ${unresolvedSummary} remain unresolved under the current policy.`;
          severity = "high";
          suggestedFix =
            "Resolve the unsupported observers or unknown judgments, or relax the release policy intentionally.";
        } else if (releasePolicy.unknownBehavior === "warn") {
          verdict = "unknown";
          summary = `Release gate is unknown because ${unresolvedSummary} remain unresolved.`;
          severity = "medium";
          suggestedFix =
            "Review the unsupported observers or unknown judgments before promoting this run.";
        } else {
          summary = `Release gate passed, but ${unresolvedSummary} were ignored by policy.`;
          severity = "info";
        }

        evidenceRecordIds = [
          ...new Set([
            ...unsupported.map((record) => record.id),
            ...collectJudgmentEvidenceIds(unresolvedUnknowns)
          ])
        ];
        artifactIds = [
          ...new Set([
            ...collectArtifactIds(unsupported),
            ...collectJudgmentArtifactIds(unresolvedUnknowns)
          ])
        ];
      }

      return [
        {
          id: `release:${bundle.interaction.id}`,
          judgeId: "release",
          judgeVersion: "0.1.0",
          scope: "run",
          verdict,
          summary,
          severity,
          confidence: 0.75,
          evidenceRecordIds,
          artifactIds: artifactIds && artifactIds.length > 0 ? artifactIds : undefined,
          suggestedFix
        }
      ];
    }
  };
}

interface ActivationSignal {
  label: string;
  evidenceRecordIds: string[];
  artifactIds: string[];
}

function buildKeyboardUnknownJudgment(
  bundle: EvidenceBundle,
  summary: string,
  severity: Judgment["severity"],
  confidence: number,
  evidenceRecordIds: string[] = bundle.records.map((record) => record.id)
): Judgment {
  return {
    id: `keyboard:${bundle.interaction.id}`,
    judgeId: "keyboard",
    judgeVersion: KEYBOARD_JUDGE_VERSION,
    scope: "interaction",
    verdict: "unknown",
    summary,
    severity,
    confidence,
    evidenceRecordIds
  };
}

/** What followed a press: what it changed, what changed elsewhere, and the evidence for both. */
interface PressResponse {
  /** Changes the press made: each is something a keyboard or screen-reader user perceives. */
  signals: ActivationSignal[];
  /** Accessibility-tree changes away from the pressed control and what it controls. */
  unattributed: { count: number; descriptions: string[]; evidenceRecordIds: string[] };
  /** The accessibility-tree record that compared the tree before the press with after it. */
  accessibilityRecord?: EvidenceRecord;
  /** Focus a click or submit moved only where the click itself puts it: not a response. */
  clickFocus?: { description: string; records: EvidenceRecord[] };
  /** Records whose markup changed: supporting evidence, never a response on its own. */
  markupRecords: EvidenceRecord[];
  /**
   * Where focus went when it moved but no element has it: lost, which is not a response, or
   * somewhere the record cannot tell from lost.
   */
  focusLanding?: Exclude<FocusLanding, { kind: "element" }>;
  /** Announcements after the press that the page may have made on its own, so not counted. */
  ownAnnouncements: OwnAnnouncements;
}

/**
 * Announcements heard after the press that cannot be credited to it, because the page was already
 * announcing on its own while it was left untouched before the press.
 */
interface OwnAnnouncements {
  /** Each announcement, with the live region it came from when Chrome's tree shows which. */
  announcements: Array<{ announcement: LiveRegionAnnouncement; region?: LiveRegionRef }>;
  /** What the reader heard from the page before the press. */
  heardWithoutInput: LiveRegionAnnouncement[];
  evidenceRecordIds: string[];
}

/**
 * Decides what a press (Enter, Space, a click or a submit) did from what the browser and
 * Guidepup's reader report, not from the page's markup:
 * - the pressed control's state in Chrome's accessibility tree (checked, expanded, pressed,
 *   selected, value, its name, or it leaving the page), and the same for what it names with
 *   `aria-controls`;
 * - focus moving, except where a click puts it by itself;
 * - a live-region update Guidepup's virtual screen reader announced (a status message, WCAG 4.1.3),
 *   unless the page was already announcing from that live region on its own before the press
 *   (see `placeAnnouncements`);
 * - network activity.
 * Any other change in the tree, such as a clock ticking, cannot be tied to the press. A change in
 * the markup is kept as supporting evidence only: a native checkbox ticks without changing it, and
 * an unrelated script changes it without anything responding.
 */
function collectPressResponse(bundle: EvidenceBundle): PressResponse {
  const { records, interaction } = bundle;
  const signals: ActivationSignal[] = [];
  const accessibilityRecord = records.find(
    (record) =>
      record.observerId === "accessibility-tree" &&
      record.phase === "after" &&
      record.status === "ok" &&
      readAccessibilityChanges(record) !== undefined
  );
  const accessibilityChanges = accessibilityRecord && readAccessibilityChanges(accessibilityRecord);
  const unattributed: string[] = [];

  if (accessibilityRecord && accessibilityChanges) {
    const pressed = (node: AccessibilityNodeRef) =>
      isPressedNode(node, interaction, accessibilityChanges);
    const attributed: string[] = [];
    for (const change of accessibilityChanges.changes) {
      const controller = change.controlledBy?.find(pressed);
      if (pressed(change)) attributed.push(describeAccessibilityChange(change));
      else if (controller)
        attributed.push(
          `${describeAccessibilityChange(change)}, which ${describeAccessibilityNode(controller)} controls`
        );
      else unattributed.push(describeAccessibilityChange(change));
    }
    if (attributed.length > 0) {
      signals.push({
        label: attributed.join("; "),
        evidenceRecordIds: [accessibilityRecord.id],
        artifactIds: collectArtifactIds([accessibilityRecord])
      });
    }
  }

  const beforeFocusRecord = findFocusRecord(records, "before");
  const afterFocusRecord = findFocusRecord(records, "after");
  let clickFocus: PressResponse["clickFocus"];
  let focusLanding: PressResponse["focusLanding"];
  if (
    beforeFocusRecord &&
    afterFocusRecord &&
    serializeFocusTarget(getFocusTarget(beforeFocusRecord)) !==
      serializeFocusTarget(getFocusTarget(afterFocusRecord))
  ) {
    const focusRecords = [beforeFocusRecord, afterFocusRecord];
    // A click's own focus, the page itself included, is explained first: a click on something
    // that cannot take focus puts focus on the page's <body> by itself.
    const fromClick = describeFocusFromClick(afterFocusRecord, interaction, accessibilityChanges);
    const landing = focusLandingOf(getFocusTarget(afterFocusRecord));
    if (fromClick) {
      clickFocus = { description: fromClick, records: focusRecords };
    } else if (landing.kind !== "element") {
      focusLanding = landing;
    } else {
      signals.push({
        label: "focus moved",
        evidenceRecordIds: focusRecords.map(({ id }) => id),
        artifactIds: collectArtifactIds(focusRecords)
      });
    }
  }

  const readerRecords = records.filter(
    (record) =>
      record.observerId === "virtual-screen-reader" &&
      record.phase === "after" &&
      record.status === "ok" &&
      readNewLiveRegionAnnouncements(record).length > 0
  );
  const placed = placeAnnouncements(
    records,
    readerRecords.flatMap(readNewLiveRegionAnnouncements),
    accessibilityChanges
  );
  if (placed.counted.length > 0) {
    const announced = placed.counted.map(({ politeness, text }) => `"${text}" (${politeness})`);
    signals.push({
      label: `a live region announced ${announced.join(", ")}`,
      evidenceRecordIds: readerRecords.map((record) => record.id),
      artifactIds: collectArtifactIds(readerRecords)
    });
  }
  const ownAnnouncements: OwnAnnouncements = {
    announcements: placed.own,
    heardWithoutInput: placed.heardWithoutInput,
    evidenceRecordIds:
      placed.own.length > 0
        ? [...readerRecords, ...placed.watchRecords].map((record) => record.id)
        : []
  };

  const networkRecords = records.filter(
    (record) =>
      record.observerId === "network" &&
      record.phase === "after" &&
      record.status === "ok" &&
      (getNumericMetaField(record, "newInterestingEventCount") ?? 0) > 0
  );
  if (networkRecords.length > 0) {
    signals.push({
      label: "network activity",
      evidenceRecordIds: networkRecords.map((record) => record.id),
      artifactIds: collectArtifactIds(networkRecords)
    });
  }

  return {
    signals,
    unattributed: {
      count: unattributed.length,
      descriptions: unattributed.slice(0, 3),
      evidenceRecordIds:
        accessibilityRecord && unattributed.length > 0 ? [accessibilityRecord.id] : []
    },
    ...(accessibilityRecord ? { accessibilityRecord } : {}),
    ...(clickFocus ? { clickFocus } : {}),
    markupRecords: records.filter(
      (record) =>
        record.observerId === "dom" &&
        record.phase === "after" &&
        record.status === "ok" &&
        getBooleanMetaField(record, "changed") === true
    ),
    ownAnnouncements,
    ...(focusLanding ? { focusLanding } : {})
  };
}

/**
 * Sorts the announcements heard after a press into those the press may have caused and those the
 * page may have made on its own. Before the press the run leaves the page untouched while the
 * reader listens; the "before" records hold what the reader heard then and which live regions
 * Chrome's tree shows changing on their own. A status message is the result of an action (WCAG
 * 4.1.3); content that updates by itself is not (WCAG 2.2.2), so:
 * - an announcement from a live region that changed on its own before the press is not counted;
 * - one from a live region that did not is counted, even while another region (a clock) ticks;
 * - one Chrome's tree cannot place in a region is counted only if the page announced nothing on
 *   its own before the press.
 * Guidepup's reader does not say which region spoke, so an announcement is placed in the changed
 * region whose name or text contains its words, as Chrome's tree reports them after the press.
 */
function placeAnnouncements(
  records: EvidenceRecord[],
  announcements: LiveRegionAnnouncement[],
  accessibilityChanges: AccessibilityChanges | undefined
): {
  counted: LiveRegionAnnouncement[];
  own: OwnAnnouncements["announcements"];
  heardWithoutInput: LiveRegionAnnouncement[];
  watchRecords: EvidenceRecord[];
} {
  const readerWatchRecords = records.filter(
    (record) =>
      record.observerId === "virtual-screen-reader" &&
      record.phase === "before" &&
      record.status === "ok" &&
      readLiveRegionAnnouncementsWithoutInput(record).length > 0
  );
  const heardWithoutInput = readerWatchRecords.flatMap(readLiveRegionAnnouncementsWithoutInput);
  const treeWatchRecord = records.find(
    (record) =>
      record.observerId === "accessibility-tree" &&
      record.phase === "before" &&
      record.status === "ok" &&
      readAccessibilityChanges(record, "accessibilityChangesWithoutInput") !== undefined
  );
  const changedOnItsOwn =
    treeWatchRecord &&
    new Set(
      (
        readAccessibilityChanges(treeWatchRecord, "accessibilityChangesWithoutInput")!
          .liveRegions ?? []
      ).map(({ nodeId }) => nodeId)
    );
  const counted: LiveRegionAnnouncement[] = [];
  const own: OwnAnnouncements["announcements"] = [];
  for (const announcement of announcements) {
    const region = accessibilityChanges?.liveRegions?.find((candidate) =>
      regionSays(candidate, announcement)
    );
    const fromOwnRegion = region && changedOnItsOwn?.has(region.nodeId);
    const unplaced = !(region && changedOnItsOwn) && heardWithoutInput.length > 0;
    if (fromOwnRegion || unplaced) own.push({ announcement, ...(region ? { region } : {}) });
    else counted.push(announcement);
  }
  return {
    counted,
    own,
    heardWithoutInput,
    watchRecords: [...readerWatchRecords, ...(treeWatchRecord ? [treeWatchRecord] : [])]
  };
}

/**
 * Whether the region's name or text holds the announcement's words. Guidepup says an atomic
 * region's name, or else its whole text, and a non-atomic one's added text; Chrome's tree splits
 * the text across nodes, so spacing is not compared.
 */
function regionSays(region: LiveRegionRef, { text }: LiveRegionAnnouncement): boolean {
  const words = (value: string) => value.replace(/\s+/g, "").toLowerCase();
  const said = words(text);
  return said.length > 0 && words(`${region.name ?? ""} ${region.text}`).includes(said);
}

/**
 * The control a press acts on. A key press acts on the element that had focus; a click or submit
 * on its target, found by role and name, or, with neither given, on what the click focused.
 */
function isPressedNode(
  node: AccessibilityNodeRef,
  interaction: EvidenceBundle["interaction"],
  changes: Pick<AccessibilityChanges, "focusedBefore" | "focusedAfter">
): boolean {
  if ((interaction.kind === "enter" || interaction.kind === "space") && changes.focusedBefore) {
    return node.nodeId === changes.focusedBefore.nodeId;
  }
  const { role, name } = interaction.target ?? {};
  if (!role && !name) return node.nodeId === changes.focusedAfter?.nodeId;
  return (
    (!role || normalizeSemanticValue(role) === normalizeSemanticValue(node.role)) &&
    (!name || normalizeSemanticValue(name) === normalizeSemanticValue(node.name))
  );
}

/** Chrome's roles for the page itself, which has focus when no element does. */
const PAGE_ROLES = new Set(["RootWebArea", "WebArea"]);

/**
 * Says why focus a click or submit moved is not a response, when it only went where the click
 * itself puts it: HTML runs its focusing steps on a clicked control that can take focus (focus
 * trigger "click"), and Chrome moves focus to the page when what was clicked cannot. That is the
 * browser's doing, not the control's, so only focus moving elsewhere (into a dialog, onto another
 * control) counts. Where focus landed is Chrome's
 * accessibility node for the focus observer's element, or else the accessibility tree's focused
 * node; with neither, it cannot be told apart from the click's own focus.
 */
function describeFocusFromClick(
  afterFocusRecord: EvidenceRecord,
  interaction: EvidenceBundle["interaction"],
  changes: AccessibilityChanges | undefined
): string | undefined {
  if (interaction.kind !== "click" && interaction.kind !== "submit") return undefined;
  const focused = readAccessibilityFocus(afterFocusRecord) ?? changes?.focusedAfter;
  if (!focused) {
    return `Focus moved, but without Chrome's accessibility tree it cannot be told whether it went anywhere other than where the ${interaction.kind} itself puts it, so it is not counted as a response.`;
  }
  if (PAGE_ROLES.has(focused.role)) {
    return `Focus moved to the page itself, which a ${interaction.kind} on something that cannot take focus does by itself, so it is not counted as a response.`;
  }
  if (isPressedNode(focused, interaction, changes ?? {})) {
    return `Focus moved onto ${describeAccessibilityNode(focused)} itself, which a ${interaction.kind} on it does by itself, so it is not counted as a response.`;
  }
  return undefined;
}

/** The focus observer's element as Chrome's accessibility tree names it, when the tree has it. */
function readAccessibilityFocus(record: EvidenceRecord): AccessibilityNodeRef | undefined {
  const target = getFocusTarget(record);
  const focus = isRecord(target) ? target.accessibilityFocus : undefined;
  if (
    !isRecord(focus) ||
    focus.status !== "matched" ||
    typeof focus.backendDOMNodeId !== "number" ||
    typeof focus.role !== "string"
  ) {
    return undefined;
  }
  return {
    nodeId: focus.backendDOMNodeId,
    role: focus.role,
    ...(typeof focus.name === "string" ? { name: focus.name } : {})
  };
}

function readAccessibilityChanges(
  record: EvidenceRecord,
  field: "accessibilityChanges" | "accessibilityChangesWithoutInput" = "accessibilityChanges"
): AccessibilityChanges | undefined {
  const changes = isRecord(record.meta) ? record.meta[field] : undefined;
  return isRecord(changes) && Array.isArray(changes.changes)
    ? (changes as unknown as AccessibilityChanges)
    : undefined;
}

function readNewLiveRegionAnnouncements(record: EvidenceRecord): LiveRegionAnnouncement[] {
  return readAnnouncements(record, "newLiveRegionAnnouncements");
}

function readLiveRegionAnnouncementsWithoutInput(record: EvidenceRecord): LiveRegionAnnouncement[] {
  return readAnnouncements(record, "liveRegionAnnouncementsWithoutInput");
}

function readAnnouncements(
  record: EvidenceRecord,
  field: "newLiveRegionAnnouncements" | "liveRegionAnnouncementsWithoutInput"
): LiveRegionAnnouncement[] {
  const announcements = isRecord(record.meta) ? record.meta[field] : undefined;
  return Array.isArray(announcements) ? (announcements as LiveRegionAnnouncement[]) : [];
}

function describeAccessibilityNode({ role, name }: AccessibilityNodeRef): string {
  return name ? `${role} "${name}"` : role;
}

function describeAccessibilityChange(change: AccessibilityChange): string {
  const node = describeAccessibilityNode(change);
  if (change.kind === "state") {
    return `${node} ${change.state} changed from ${String(change.before ?? "none")} to ${String(change.after ?? "none")}`;
  }
  if (change.kind === "name") {
    return `${change.role} name changed from "${change.before ?? ""}" to "${change.after ?? ""}"`;
  }
  return `${node} ${change.kind === "shown" ? "appeared" : "disappeared"}`;
}

/** Says when focus was lost after the press: a change, but not a response. */
function describeFocusLoss(response: PressResponse, kind: string): string {
  return response.focusLanding?.kind === "lost"
    ? ` Focus was lost: after the ${kind} no element had focus, which is not a response.`
    : "";
}

/**
 * Why a press with no response of its own is left undecided rather than failed, or nothing. The
 * announcements the page made on its own are named with the supporting evidence.
 */
function describeUndecidedPress(response: PressResponse): string | undefined {
  if (!response.accessibilityRecord) {
    return "Telling whether the press responded needs the accessibility tree before and after it (the accessibility-tree observer).";
  }
  if (response.focusLanding && response.focusLanding.kind !== "lost") {
    return `Focus moved to a document's <body>. ${describeUndecidedLanding(response.focusLanding)}`;
  }
  if (response.unattributed.count > 0) {
    const more = response.unattributed.count - response.unattributed.descriptions.length;
    return `The page changed elsewhere (${response.unattributed.descriptions.join("; ")}${more > 0 ? `; and ${more} more` : ""}), but not the pressed control, what it controls, focus, a live-region announcement of its own or the network, so whether the press caused it cannot be told.`;
  }
  if (response.ownAnnouncements.announcements.length > 0) {
    return "All it was followed by is what a live region announced, and the page was already announcing on its own, so whether the press caused it cannot be told.";
  }
  return undefined;
}

/** The announcements not counted as the press's response, and why, said in full. */
function describeOwnAnnouncements({ ownAnnouncements }: PressResponse): string {
  if (ownAnnouncements.announcements.length === 0) return "";
  const heard = ownAnnouncements.heardWithoutInput
    .slice(0, 3)
    .map(({ text }) => `"${text}"`)
    .join(", ");
  const before = heard ? ` (before the press it said ${heard})` : "";
  // One sentence per region, and one for the announcements no region was found for.
  const groups = new Map<number | undefined, { region?: LiveRegionRef; said: string[] }>();
  for (const { announcement, region } of ownAnnouncements.announcements) {
    const group = groups.get(region?.nodeId) ?? { ...(region ? { region } : {}), said: [] };
    group.said.push(`"${announcement.text}" (${announcement.politeness})`);
    groups.set(region?.nodeId, group);
  }
  const sentences = [...groups.values()].map(({ region, said }) => {
    const announced = `A live region announced ${said.join(", ")} after the press`;
    const notCounted = `so ${said.length === 1 ? "it is" : "they are"} not counted as the press's response`;
    return region
      ? `${announced}, but that region, ${describeAccessibilityNode(region)}, was already announcing on its own while the page was left untouched${before}, ${notCounted}.`
      : `${announced}, but the page was already announcing on its own while it was left untouched${before} and Chrome's accessibility tree does not show which live region ${said.length === 1 ? "this" : "these"} came from, ${notCounted}.`;
  });
  return ` ${sentences.join(" ")}`;
}

/**
 * What was seen but not counted as the press responding: a click's own focus, what the page
 * announced on its own, the markup.
 */
function describeSupportingEvidence(response: PressResponse): string {
  return [
    response.clickFocus ? ` ${response.clickFocus.description}` : "",
    describeOwnAnnouncements(response),
    response.markupRecords.length > 0
      ? " The page's markup changed, which is kept as supporting evidence only."
      : ""
  ].join("");
}

function supportsChangeResponseInteraction(
  interactionKind: EvidenceBundle["interaction"]["kind"]
): boolean {
  return (
    interactionKind === "click" ||
    interactionKind === "enter" ||
    interactionKind === "space" ||
    interactionKind === "submit"
  );
}

function isResponseExpectedForInteraction(
  interaction: EvidenceBundle["interaction"],
  records: EvidenceRecord[]
): boolean {
  if (interaction.kind === "submit") {
    return true;
  }

  if (interaction.kind === "enter" || interaction.kind === "space") {
    const beforeFocusRecord = findFocusRecord(records, "before");
    return isActivatableKeyboardTarget(
      interaction.target,
      beforeFocusRecord ? getFocusTarget(beforeFocusRecord) : undefined
    );
  }

  if (interaction.kind !== "click") {
    return false;
  }

  return isActionableTargetRole(interaction.target?.role);
}

function isActionableTargetRole(role: string | undefined): boolean {
  const actionableRoles = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "tab"
  ]);

  return Boolean(role && actionableRoles.has(role));
}

/**
 * How to fix a press with no response: the responses `collectPressResponse` counts, as
 * docs/playwright-integration.md ("What counts as a response") lists them. A markup change is
 * named as not counting, since the judges keep it as supporting evidence only.
 */
function describePerceivableResponses(focusNote = ""): string {
  return `change the control's accessibility state (checked, expanded, pressed, selected, value or name) or that of what it names with aria-controls, move focus to what it opens${focusNote}, announce the result in a live region (WCAG 4.1.3 Status Messages), or make a network request. A change to the page's markup alone does not count.`;
}

function buildChangeResponseSuggestedFix(
  interactionKind: EvidenceBundle["interaction"]["kind"]
): string {
  if (interactionKind === "submit") {
    return `Ensure form submission responds in a way a keyboard or screen-reader user perceives: ${describePerceivableResponses(" (not only onto the submit control)")}`;
  }

  if (interactionKind === "enter" || interactionKind === "space") {
    return `Ensure the ${interactionKind} interaction activates the target and responds in a way a keyboard or screen-reader user perceives: ${describePerceivableResponses()}`;
  }

  return `Ensure the ${interactionKind} interaction responds in a way a keyboard or screen-reader user perceives: ${describePerceivableResponses(" (not only onto the clicked control)")}`;
}

function describeTarget(target: TargetDescriptor | undefined): string {
  if (!target) {
    return "the target";
  }

  const parts = [target.role, target.name ? `"${target.name}"` : undefined].filter(
    (value): value is string => Boolean(value)
  );

  return parts.length > 0 ? parts.join(" ") : "the target";
}

function isActivatableKeyboardTarget(
  target: TargetDescriptor | undefined,
  focusTarget: unknown
): boolean {
  const activatableRoles = new Set([
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "menuitem",
    "menuitemcheckbox",
    "menuitemradio",
    "option",
    "tab"
  ]);
  const activatableInputTypes = new Set([
    "button",
    "submit",
    "reset",
    "checkbox",
    "radio",
    "image"
  ]);

  if (target?.role && activatableRoles.has(target.role)) {
    return true;
  }

  if (!isRecord(focusTarget)) {
    return false;
  }

  const role = typeof focusTarget.role === "string" ? focusTarget.role : undefined;
  if (role && activatableRoles.has(role)) {
    return true;
  }

  const tagName = typeof focusTarget.tagName === "string" ? focusTarget.tagName : undefined;
  if (tagName === "button" || tagName === "a" || tagName === "summary") {
    return true;
  }

  if (tagName === "input") {
    const type = typeof focusTarget.type === "string" ? focusTarget.type : undefined;
    return type ? activatableInputTypes.has(type) : false;
  }

  return false;
}

function getArrowKey(
  bundle: EvidenceBundle
): "ArrowRight" | "ArrowLeft" | "ArrowUp" | "ArrowDown" | "Home" | "End" | undefined {
  const candidates = [
    bundle.interaction.input,
    getStringMetaField(bundle.interaction.meta, "key"),
    getStringMetaField(bundle.interaction.meta, "direction")
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    if (
      candidate === "ArrowRight" ||
      candidate === "ArrowLeft" ||
      candidate === "ArrowUp" ||
      candidate === "ArrowDown" ||
      candidate === "Home" ||
      candidate === "End"
    ) {
      return candidate;
    }
  }

  return undefined;
}

function getCompositeNavigationExpectation(
  compositeRole: string,
  orientation: string | undefined,
  key: "ArrowRight" | "ArrowLeft" | "ArrowUp" | "ArrowDown" | "Home" | "End"
): { status: "evaluated" | "unsupported"; expectedKeys: string[] } {
  const horizontal = ["ArrowLeft", "ArrowRight", "Home", "End"];
  const vertical = ["ArrowUp", "ArrowDown", "Home", "End"];
  const keysByRole: Record<string, string[]> = {
    tablist: orientation === "vertical" ? vertical : horizontal,
    radiogroup: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"],
    listbox: vertical,
    menu: vertical,
    menubar: horizontal,
    tree: vertical,
    grid: ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]
  };
  const expectedKeys = keysByRole[compositeRole] ?? [];
  return {
    status: expectedKeys.includes(key) ? "evaluated" : "unsupported",
    expectedKeys
  };
}

function getCompositeNavigationRole(
  target: TargetDescriptor | undefined,
  beforeTarget: unknown,
  afterTarget: unknown
): string | undefined {
  const beforeCompositeRole = getStringField(beforeTarget, "compositeRole");
  const afterCompositeRole = getStringField(afterTarget, "compositeRole");

  if (beforeCompositeRole && beforeCompositeRole === afterCompositeRole) {
    return beforeCompositeRole;
  }

  if (beforeCompositeRole) {
    return beforeCompositeRole;
  }

  if (afterCompositeRole) {
    return afterCompositeRole;
  }

  if (target?.role === "tab") {
    return "tablist";
  }

  return undefined;
}

function isSameCompositeNavigationContext(
  beforeTarget: unknown,
  afterTarget: unknown,
  compositeRole: string
): boolean {
  const beforeCompositeRole = getStringField(beforeTarget, "compositeRole");
  const afterCompositeRole = getStringField(afterTarget, "compositeRole");

  if (beforeCompositeRole && afterCompositeRole) {
    if (beforeCompositeRole !== compositeRole || afterCompositeRole !== compositeRole) {
      return false;
    }
  }

  const beforeFamily = getCompositeItemFamily(getStringField(beforeTarget, "role"));
  const afterFamily = getCompositeItemFamily(getStringField(afterTarget, "role"));

  if (!beforeFamily || !afterFamily) {
    return false;
  }

  return beforeFamily === afterFamily;
}

function getCompositeItemFamily(role: string | undefined): string | undefined {
  if (!role) {
    return undefined;
  }

  if (role === "tab" || role === "radio" || role === "option" || role === "treeitem") {
    return role;
  }

  if (role === "menuitem" || role === "menuitemcheckbox" || role === "menuitemradio") {
    return "menuitem";
  }

  if (role === "gridcell" || role === "rowheader" || role === "columnheader") {
    return "gridcell";
  }

  return undefined;
}

function evaluateCompositeArrowDirection(
  arrowKey: "ArrowRight" | "ArrowLeft" | "ArrowUp" | "ArrowDown" | "Home" | "End",
  beforeIndex: number | undefined,
  afterIndex: number | undefined,
  itemCount: number | undefined
): "correct-direction" | "wrong-direction" | "direction-unverified" {
  if (
    beforeIndex === undefined ||
    afterIndex === undefined ||
    itemCount === undefined ||
    itemCount < 2
  ) {
    return "direction-unverified";
  }

  if (arrowKey === "Home") return afterIndex === 0 ? "correct-direction" : "wrong-direction";
  if (arrowKey === "End")
    return afterIndex === itemCount - 1 ? "correct-direction" : "wrong-direction";

  const movesForward = arrowKey === "ArrowRight" || arrowKey === "ArrowDown";
  const movedForward =
    afterIndex > beforeIndex || (beforeIndex === itemCount - 1 && afterIndex === 0);
  const movedBackward =
    afterIndex < beforeIndex || (beforeIndex === 0 && afterIndex === itemCount - 1);

  if (movesForward) {
    return movedForward ? "correct-direction" : "wrong-direction";
  }

  return movedBackward ? "correct-direction" : "wrong-direction";
}

function findFocusRecord(
  records: EvidenceRecord[],
  phase: EvidenceRecord["phase"]
): EvidenceRecord | undefined {
  return records.find(
    (record) => record.observerId === "focus" && record.phase === phase && record.status === "ok"
  );
}

function getFocusTarget(record: EvidenceRecord): unknown {
  return isRecord(record.meta) ? (record.meta.focusTarget ?? null) : null;
}

function getCompositeNavigationTarget(record: EvidenceRecord): unknown {
  const focusTarget = getFocusTarget(record);

  if (isRecord(focusTarget) && isRecord(focusTarget.activeDescendant)) {
    return focusTarget.activeDescendant;
  }

  return focusTarget;
}

function collectArtifactIds(records: EvidenceRecord[]): string[] {
  const artifactIds = new Set<string>();

  for (const record of records) {
    for (const artifact of [
      record.beforeStateRef,
      record.afterStateRef,
      record.rawRef,
      ...(record.artifacts ?? [])
    ]) {
      if (!artifact) {
        continue;
      }

      artifactIds.add(artifact.id);
    }
  }

  return [...artifactIds];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function serializeFocusTarget(target: unknown): string {
  if (!isRecord(target)) {
    return "null";
  }

  // The frame and the node id the browser gives the element tell apart two like-named controls,
  // in two frames or in one; node ids repeat across frames rendered in different processes.
  const normalized = {
    tagName: typeof target.tagName === "string" ? target.tagName : null,
    id: typeof target.id === "string" ? target.id : null,
    role: typeof target.role === "string" ? target.role : null,
    name: typeof target.name === "string" ? target.name : null,
    type: typeof target.type === "string" ? target.type : null,
    frameId: typeof target.frameId === "string" ? target.frameId : null,
    backendDOMNodeId: typeof target.backendDOMNodeId === "number" ? target.backendDOMNodeId : null
  };

  return JSON.stringify(normalized);
}

function describeFocusTarget(target: unknown): string {
  if (!isRecord(target)) {
    return "no focused element";
  }

  const landingNote = describeFocusLanding(target);

  const tagName = typeof target.tagName === "string" ? target.tagName : "unknown";
  const id = typeof target.id === "string" && target.id.length > 0 ? `#${target.id}` : undefined;
  const role =
    typeof target.role === "string" && target.role.length > 0 ? `role=${target.role}` : undefined;
  const name =
    typeof target.name === "string" && target.name.length > 0 ? `"${target.name}"` : undefined;

  return `${[tagName, id, role, name].filter(Boolean).join(" ")}${landingNote}`;
}

function getNumericField(target: unknown, field: string): number | undefined {
  if (!isRecord(target)) {
    return undefined;
  }

  return typeof target[field] === "number" ? target[field] : undefined;
}

function getStringField(target: unknown, field: string): string | undefined {
  if (!isRecord(target)) {
    return undefined;
  }

  return typeof target[field] === "string" ? target[field] : undefined;
}

function getNumericMetaField(record: EvidenceRecord, field: string): number | undefined {
  if (!isRecord(record.meta)) {
    return undefined;
  }

  return typeof record.meta[field] === "number" ? record.meta[field] : undefined;
}

function getBooleanMetaField(record: EvidenceRecord, field: string): boolean | undefined {
  if (!isRecord(record.meta)) {
    return undefined;
  }

  return typeof record.meta[field] === "boolean" ? record.meta[field] : undefined;
}

function getStringMetaField(
  record: Record<string, unknown> | undefined,
  field: string
): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}

function collectJudgmentEvidenceIds(judgments: Judgment[]): string[] {
  return [...new Set(judgments.flatMap((judgment) => judgment.evidenceRecordIds))];
}

function collectJudgmentArtifactIds(judgments: Judgment[]): string[] {
  return [...new Set(judgments.flatMap((judgment) => judgment.artifactIds ?? []))];
}

function meetsMinimumConfidence(
  judgment: Judgment,
  minimumConfidence: number | undefined
): boolean {
  if (minimumConfidence === undefined) {
    return true;
  }

  if (typeof judgment.confidence !== "number") {
    return true;
  }

  return judgment.confidence >= minimumConfidence;
}

function describeObserverCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function describeJudgmentCount(count: number, label: string): string {
  return `${count} ${label}${count === 1 ? "" : "s"}`;
}

function describeUnresolvedSignals(unsupportedCount: number, unknownCount: number): string {
  const parts: string[] = [];

  if (unsupportedCount > 0) {
    parts.push(`${unsupportedCount} unsupported observer${unsupportedCount === 1 ? "" : "s"}`);
  }

  if (unknownCount > 0) {
    parts.push(`${unknownCount} unknown judgment${unknownCount === 1 ? "" : "s"}`);
  }

  return parts.join(" and ");
}

function evaluateDirection(
  interactionKind: "tab" | "shift-tab",
  beforeOrderIndex: number | undefined,
  afterOrderIndex: number | undefined,
  focusableCount: number | undefined
): "correct-direction" | "wrong-direction" | "direction-unverified" {
  if (
    beforeOrderIndex === undefined ||
    afterOrderIndex === undefined ||
    focusableCount === undefined ||
    focusableCount < 2
  ) {
    return "direction-unverified";
  }

  if (interactionKind === "tab") {
    const movedForward =
      afterOrderIndex > beforeOrderIndex ||
      (beforeOrderIndex === focusableCount - 1 && afterOrderIndex === 0);

    return movedForward ? "correct-direction" : "wrong-direction";
  }

  const movedBackward =
    afterOrderIndex < beforeOrderIndex ||
    (beforeOrderIndex === 0 && afterOrderIndex === focusableCount - 1);

  return movedBackward ? "correct-direction" : "wrong-direction";
}
