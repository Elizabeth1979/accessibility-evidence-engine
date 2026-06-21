import {
  DEFAULT_POLICY,
  type EvidenceBundle,
  type EvidenceRecord,
  type Finding,
  type JudgePlugin,
  type Judgment,
  type TargetDescriptor
} from "@aee/core";

export const defaultJudgeManifests = [
  {
    id: "structure",
    displayName: "Structure Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: ["landmarks", "headings", "reading-order"]
  },
  {
    id: "keyboard",
    displayName: "Keyboard Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: ["focus-order", "tab-flow", "keyboard-activation"]
  },
  {
    id: "interaction",
    displayName: "Interaction Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: ["state-change", "response-validation"]
  },
  {
    id: "screen-reader",
    displayName: "Screen Reader Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: ["announcement-quality", "control-discoverability"]
  },
  {
    id: "visual",
    displayName: "Visual Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: ["visual-regression", "target-size"]
  },
  {
    id: "change-response",
    displayName: "Change Response Judge",
    version: "0.1.0",
    kind: "judge" as const,
    capabilities: ["change-classification", "focus-expectation", "announcement-expectation"]
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

  if (judgeId === "change-response") {
    return createChangeResponseJudge();
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
      const domOk = bundle.records.some((record) => record.observerId === "dom" && record.status === "ok");
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
    getNumericField(beforeTarget, "focusableCount") ?? getNumericField(afterTarget, "focusableCount");

  if (afterTarget === null) {
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
        judgeVersion: "0.1.0",
        scope: "interaction",
        verdict: "fail",
        summary: `Keyboard interaction lost focus. Before: ${describeFocusTarget(beforeTarget)}. After: no focused element.`,
        severity: "high",
        confidence: 0.95,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [finding],
        suggestedFix: finding.suggestedFix
      }
    ];
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
        judgeVersion: "0.1.0",
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
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: "0.1.0",
        scope: "interaction",
        verdict: "fail",
        summary: `Keyboard focus moved in the wrong direction. Before: ${describeFocusTarget(beforeTarget)}. After: ${describeFocusTarget(afterTarget)}.`,
        severity: "high",
        confidence: 0.95,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [
          {
            id: `keyboard:${bundle.interaction.id}:wrong-direction`,
            message: `Expected ${bundle.interaction.kind} to move focus ${bundle.interaction.kind === "tab" ? "forward" : "backward"}, but it moved differently.`,
            severity: "high",
            ruleId: "keyboard-focus-direction",
            evidenceRecordIds: [beforeRecord.id, afterRecord.id],
            artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
            suggestedFix: `Ensure ${bundle.interaction.kind} follows the page's tabbable order.`
          }
        ],
        suggestedFix: `Ensure ${bundle.interaction.kind} follows the page's tabbable order.`
      }
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
      judgeVersion: "0.1.0",
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

  if (afterTarget === null) {
    const finding: Finding = {
      id: `keyboard:${bundle.interaction.id}:activation-focus-lost`,
      message: "Keyboard activation left the page without a focused target.",
      severity: "high",
      ruleId: "keyboard-activation-focus-presence",
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
      suggestedFix: "Keep focus on the activated control or move it intentionally to the resulting UI."
    };

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: "0.1.0",
        scope: "interaction",
        verdict: "fail",
        summary: `Keyboard activation lost focus. Before: ${describeFocusTarget(beforeTarget)}. After: no focused element.`,
        severity: "high",
        confidence: 0.95,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [finding],
        suggestedFix: finding.suggestedFix
      }
    ];
  }

  const activationSignals = collectActivationSignals(bundle.records, beforeRecord, afterRecord, beforeKey, afterKey);

  if (activationSignals.length === 0) {
    const evidenceRecordIds = [beforeRecord.id, afterRecord.id];
    const artifactIds = collectArtifactIds([beforeRecord, afterRecord]);
    const suggestedFix = `Ensure ${bundle.interaction.kind} activates the focused control and produces an observable response.`;

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: "0.1.0",
        scope: "interaction",
        verdict: "fail",
        summary: `Keyboard ${bundle.interaction.kind} produced no observable activation response for ${describeFocusTarget(beforeTarget)}.`,
        severity: "high",
        confidence: 0.9,
        evidenceRecordIds,
        artifactIds,
        findings: [
          {
            id: `keyboard:${bundle.interaction.id}:activation-no-response`,
            message: `Expected ${bundle.interaction.kind} to activate the focused control, but no focus, DOM, or network response was observed.`,
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
  const artifactIds = [
    ...new Set(activationSignals.flatMap((signal) => signal.artifactIds))
  ];
  const focusOutcome =
    beforeKey === afterKey
      ? `Focus stayed on ${describeFocusTarget(afterTarget)}.`
      : `Focus moved from ${describeFocusTarget(beforeTarget)} to ${describeFocusTarget(afterTarget)}.`;

  return [
    {
      id: `keyboard:${bundle.interaction.id}`,
      judgeId: "keyboard",
      judgeVersion: "0.1.0",
      scope: "interaction",
      verdict: "pass",
      summary: `Keyboard ${bundle.interaction.kind} produced observable activation signals (${activationSignals.map((signal) => signal.label).join(", ")}). ${focusOutcome}`,
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

  const compositeRole = getCompositeNavigationRole(bundle.interaction.target, beforeTarget, afterTarget);
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

  if (afterTarget === null) {
    const finding: Finding = {
      id: `keyboard:${bundle.interaction.id}:composite-focus-lost`,
      message: "Arrow-key navigation left the composite widget without a focused target.",
      severity: "high",
      ruleId: "keyboard-composite-focus-presence",
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
      suggestedFix: "Keep focus within the composite widget while arrow-key navigation is in progress."
    };

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: "0.1.0",
        scope: "interaction",
        verdict: "fail",
        summary: `Arrow-key navigation lost focus within the ${compositeRole}. Before: ${describeFocusTarget(beforeTarget)}. After: no focused element.`,
        severity: "high",
        confidence: 0.95,
        evidenceRecordIds: [beforeRecord.id, afterRecord.id],
        artifactIds: collectArtifactIds([beforeRecord, afterRecord]),
        findings: [finding],
        suggestedFix: finding.suggestedFix
      }
    ];
  }

  if (beforeKey === afterKey) {
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
        judgeVersion: "0.1.0",
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
        judgeVersion: "0.1.0",
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
    getNumericField(beforeTarget, "compositeItemCount") ?? getNumericField(afterTarget, "compositeItemCount")
  );

  if (directionVerdict === "wrong-direction") {
    const suggestedFix = `Ensure ${arrowKey} follows the item order within the ${compositeRole}.`;

    return [
      {
        id: `keyboard:${bundle.interaction.id}`,
        judgeId: "keyboard",
        judgeVersion: "0.1.0",
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
      judgeVersion: "0.1.0",
      scope: "interaction",
      verdict: "pass",
      summary: `Arrow-key navigation moved focus within the ${compositeRole} from ${describeFocusTarget(beforeTarget)} to ${describeFocusTarget(afterTarget)} using ${arrowKey}.${directionSuffix}`,
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
      if (bundle.interaction.kind !== "click" && bundle.interaction.kind !== "submit") {
        return [
          {
            id: `change-response:${bundle.interaction.id}`,
            judgeId: "change-response",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "unknown",
            summary: "Change-response judge currently evaluates click and submit interactions only.",
            severity: "info",
            confidence: 0.5,
            evidenceRecordIds: bundle.records.map((record) => record.id)
          }
        ];
      }

      if (!isResponseExpectedForInteraction(bundle.interaction)) {
        return [
          {
            id: `change-response:${bundle.interaction.id}`,
            judgeId: "change-response",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "unknown",
            summary: "Change-response judge could not determine whether this interaction was expected to trigger a visible or network response.",
            severity: "info",
            confidence: 0.6,
            evidenceRecordIds: bundle.records.map((record) => record.id)
          }
        ];
      }

      const observedSignals = collectChangeResponseSignals(bundle.records);
      const relevantObserverIds = new Set(["dom", "network", "focus"]);
      const availableEvidenceRecords = bundle.records.filter(
        (record) => relevantObserverIds.has(record.observerId) && record.status === "ok"
      );

      if (availableEvidenceRecords.length === 0) {
        return [
          {
            id: `change-response:${bundle.interaction.id}`,
            judgeId: "change-response",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "unknown",
            summary: "Change-response judge requires DOM, network, or focus evidence to evaluate the interaction outcome.",
            severity: "medium",
            confidence: 0.7,
            evidenceRecordIds: bundle.records.map((record) => record.id)
          }
        ];
      }

      if (observedSignals.length === 0) {
        const evidenceRecordIds = availableEvidenceRecords.map((record) => record.id);
        const artifactIds = collectArtifactIds(availableEvidenceRecords);
        const suggestedFix =
          bundle.interaction.kind === "submit"
            ? "Ensure form submission produces an observable response such as DOM, focus, or network activity."
            : "Ensure the click interaction produces an observable response such as DOM, focus, or network activity.";

        return [
          {
            id: `change-response:${bundle.interaction.id}`,
            judgeId: "change-response",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "fail",
            summary: `No observable response followed the ${bundle.interaction.kind} interaction on ${describeTarget(bundle.interaction.target)}.`,
            severity: "high",
            confidence: 0.9,
            evidenceRecordIds,
            artifactIds: artifactIds.length > 0 ? artifactIds : undefined,
            findings: [
              {
                id: `change-response:${bundle.interaction.id}:no-response`,
                message: `Expected ${bundle.interaction.kind} to trigger a visible, focus, or network response, but no supported observer detected one.`,
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
          judgeVersion: "0.1.0",
          scope: "interaction",
          verdict: "pass",
          summary: `Observed response signals after the ${bundle.interaction.kind} interaction (${observedSignals.map((signal) => signal.label).join(", ")}).`,
          severity: "info",
          confidence: 0.9,
          evidenceRecordIds: [...new Set(observedSignals.flatMap((signal) => signal.evidenceRecordIds))],
          artifactIds: [
            ...new Set(observedSignals.flatMap((signal) => signal.artifactIds))
          ]
        }
      ];
    }
  };
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
      const unresolvedUnknowns = priorJudgments.filter((judgment) => judgment.verdict === "unknown");
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
        suggestedFix = "Stabilize or replace the observers that errored before relying on this release gate.";
        evidenceRecordIds = observerErrors.map((record) => record.id);
        artifactIds = collectArtifactIds(observerErrors);
      } else if (blockingFailures.length > 0) {
        verdict = "fail";
        summary = `Release gate failed because ${describeJudgmentCount(blockingFailures.length, "blocking judgment")} met the current policy threshold.`;
        severity = "high";
        suggestedFix = "Resolve the blocking accessibility judgments or relax the release policy intentionally.";
        evidenceRecordIds = collectJudgmentEvidenceIds(blockingFailures);
        artifactIds = collectJudgmentArtifactIds(blockingFailures);
      } else if (unsupported.length > 0 || unresolvedUnknowns.length > 0) {
        const unresolvedSummary = describeUnresolvedSignals(unsupported.length, unresolvedUnknowns.length);

        if (releasePolicy.unknownBehavior === "fail") {
          verdict = "fail";
          summary = `Release gate failed because ${unresolvedSummary} remain unresolved under the current policy.`;
          severity = "high";
          suggestedFix = "Resolve the unsupported observers or unknown judgments, or relax the release policy intentionally.";
        } else if (releasePolicy.unknownBehavior === "warn") {
          verdict = "unknown";
          summary = `Release gate is unknown because ${unresolvedSummary} remain unresolved.`;
          severity = "medium";
          suggestedFix = "Review the unsupported observers or unknown judgments before promoting this run.";
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
    judgeVersion: "0.1.0",
    scope: "interaction",
    verdict: "unknown",
    summary,
    severity,
    confidence,
    evidenceRecordIds
  };
}

function collectActivationSignals(
  records: EvidenceRecord[],
  beforeRecord: EvidenceRecord,
  afterRecord: EvidenceRecord,
  beforeKey: string,
  afterKey: string
): ActivationSignal[] {
  const signals: ActivationSignal[] = [];

  if (beforeKey !== afterKey) {
    signals.push({
      label: "focus moved",
      evidenceRecordIds: [beforeRecord.id, afterRecord.id],
      artifactIds: collectArtifactIds([beforeRecord, afterRecord])
    });
  }

  const domRecords = records.filter(
    (record) => record.observerId === "dom" && record.phase === "after" && record.status === "ok" && hasDomChange(record)
  );

  if (domRecords.length > 0) {
    signals.push({
      label: "DOM changed",
      evidenceRecordIds: domRecords.map((record) => record.id),
      artifactIds: collectArtifactIds(domRecords)
    });
  }

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

  return signals;
}

function collectChangeResponseSignals(records: EvidenceRecord[]): ActivationSignal[] {
  const signals: ActivationSignal[] = [];
  const domRecords = records.filter(
    (record) => record.observerId === "dom" && record.phase === "after" && record.status === "ok" && hasDomChange(record)
  );
  const networkRecords = records.filter(
    (record) =>
      record.observerId === "network" &&
      record.phase === "after" &&
      record.status === "ok" &&
      (getNumericMetaField(record, "newInterestingEventCount") ?? 0) > 0
  );
  const beforeFocusRecord = findFocusRecord(records, "before");
  const afterFocusRecord = findFocusRecord(records, "after");

  if (domRecords.length > 0) {
    signals.push({
      label: "DOM changed",
      evidenceRecordIds: domRecords.map((record) => record.id),
      artifactIds: collectArtifactIds(domRecords)
    });
  }

  if (networkRecords.length > 0) {
    signals.push({
      label: "network activity",
      evidenceRecordIds: networkRecords.map((record) => record.id),
      artifactIds: collectArtifactIds(networkRecords)
    });
  }

  if (beforeFocusRecord && afterFocusRecord) {
    const beforeKey = serializeFocusTarget(getFocusTarget(beforeFocusRecord));
    const afterKey = serializeFocusTarget(getFocusTarget(afterFocusRecord));

    if (beforeKey !== afterKey) {
      signals.push({
        label: "focus moved",
        evidenceRecordIds: [beforeFocusRecord.id, afterFocusRecord.id],
        artifactIds: collectArtifactIds([beforeFocusRecord, afterFocusRecord])
      });
    }
  }

  return signals;
}

function hasDomChange(record: EvidenceRecord): boolean {
  if (getBooleanMetaField(record, "changed") === true) {
    return true;
  }

  return (
    record.changes?.some((change) => change.path === "dom.html" && change.impact !== "none") ?? false
  );
}

function isResponseExpectedForInteraction(interaction: EvidenceBundle["interaction"]): boolean {
  if (interaction.kind === "submit") {
    return true;
  }

  if (interaction.kind !== "click") {
    return false;
  }

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

  return Boolean(interaction.target?.role && actionableRoles.has(interaction.target.role));
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

function isActivatableKeyboardTarget(target: TargetDescriptor | undefined, focusTarget: unknown): boolean {
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
  const activatableInputTypes = new Set(["button", "submit", "reset", "checkbox", "radio", "image"]);

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

function getArrowKey(bundle: EvidenceBundle): "ArrowRight" | "ArrowLeft" | "ArrowUp" | "ArrowDown" | undefined {
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
      candidate === "ArrowDown"
    ) {
      return candidate;
    }
  }

  return undefined;
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
  arrowKey: "ArrowRight" | "ArrowLeft" | "ArrowUp" | "ArrowDown",
  beforeIndex: number | undefined,
  afterIndex: number | undefined,
  itemCount: number | undefined
): "correct-direction" | "wrong-direction" | "direction-unverified" {
  if (beforeIndex === undefined || afterIndex === undefined || itemCount === undefined || itemCount < 2) {
    return "direction-unverified";
  }

  const movesForward =
    arrowKey === "ArrowRight" || arrowKey === "ArrowDown";
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
  return records.find((record) => record.observerId === "focus" && record.phase === phase && record.status === "ok");
}

function getFocusTarget(record: EvidenceRecord): unknown {
  return isRecord(record.meta) ? record.meta.focusTarget ?? null : null;
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

  const normalized = {
    tagName: typeof target.tagName === "string" ? target.tagName : null,
    id: typeof target.id === "string" ? target.id : null,
    role: typeof target.role === "string" ? target.role : null,
    name: typeof target.name === "string" ? target.name : null,
    type: typeof target.type === "string" ? target.type : null
  };

  return JSON.stringify(normalized);
}

function describeFocusTarget(target: unknown): string {
  if (!isRecord(target)) {
    return "no focused element";
  }

  const tagName = typeof target.tagName === "string" ? target.tagName : "unknown";
  const id = typeof target.id === "string" && target.id.length > 0 ? `#${target.id}` : undefined;
  const role = typeof target.role === "string" && target.role.length > 0 ? `role=${target.role}` : undefined;
  const name = typeof target.name === "string" && target.name.length > 0 ? `"${target.name}"` : undefined;

  return [tagName, id, role, name].filter(Boolean).join(" ");
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

function getStringMetaField(record: Record<string, unknown> | undefined, field: string): string | undefined {
  const value = record?.[field];
  return typeof value === "string" ? value : undefined;
}

function collectJudgmentEvidenceIds(judgments: Judgment[]): string[] {
  return [...new Set(judgments.flatMap((judgment) => judgment.evidenceRecordIds))];
}

function collectJudgmentArtifactIds(judgments: Judgment[]): string[] {
  return [...new Set(judgments.flatMap((judgment) => judgment.artifactIds ?? []))];
}

function meetsMinimumConfidence(judgment: Judgment, minimumConfidence: number | undefined): boolean {
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
