import { DEFAULT_POLICY, type EvidenceBundle, type EvidenceRecord, type Finding, type JudgePlugin, type Judgment } from "@aee/core";

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
      if (bundle.interaction.kind !== "tab" && bundle.interaction.kind !== "shift-tab") {
        return [
          {
            id: `keyboard:${bundle.interaction.id}`,
            judgeId: "keyboard",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "unknown",
            summary: "Keyboard judge currently evaluates tab-based focus transitions only.",
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
            id: `keyboard:${bundle.interaction.id}`,
            judgeId: "keyboard",
            judgeVersion: "0.1.0",
            scope: "interaction",
            verdict: "unknown",
            summary: "Keyboard judge requires focus observer evidence before and after the interaction.",
            severity: "medium",
            confidence: 0.75,
            evidenceRecordIds: bundle.records.map((record) => record.id)
          }
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
        bundle.interaction.kind,
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

function findFocusRecord(
  records: EvidenceRecord[],
  phase: EvidenceRecord["phase"]
): EvidenceRecord | undefined {
  return records.find((record) => record.observerId === "focus" && record.phase === phase && record.status === "ok");
}

function getFocusTarget(record: EvidenceRecord): unknown {
  return isRecord(record.meta) ? record.meta.focusTarget ?? null : null;
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
