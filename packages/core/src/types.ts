// AEE's evidence types are generated from its JSON schemas (@aee/schemas), so the types and the
// files they describe cannot disagree. This module re-exports them under the names @aee/core has
// always given them, with the names of their parts.
import type { AccessibilityChange, AeeRun, EvidenceBundle, EvidenceRecord } from "@aee/schemas";

export type {
  AccessibilityChange,
  AccessibilityChanges,
  AccessibilityNodeRef,
  AeeRun,
  ArtifactKind,
  ArtifactRef,
  Checkpoint,
  EvidenceBundle,
  EvidenceRecord,
  Finding,
  FindingSeverity,
  Interaction,
  InteractionKind,
  IsoTimestamp,
  Judgment,
  JudgmentVerdict,
  LiveRegionAnnouncement,
  LiveRegionRef,
  RunSummary,
  TargetDescriptor,
  UID
} from "@aee/schemas";

export type ObserverPhase = EvidenceRecord["phase"];

export type ObserverStatus = EvidenceRecord["status"];

export type EvidenceChange = NonNullable<EvidenceRecord["changes"]>[number];

export type CorrelationSummary = EvidenceBundle["correlation"];

export type RunStatus = AeeRun["status"];

/** The control states a screen reader announces when they change (WAI-ARIA 1.2 states). */
export type TrackedAccessibilityState = NonNullable<AccessibilityChange["state"]>;

/** Every state an accessibility-tree record tracks, in the order AEE reads them. */
export const TRACKED_ACCESSIBILITY_STATES = [
  "checked",
  "expanded",
  "pressed",
  "selected",
  "value"
] as const satisfies readonly TrackedAccessibilityState[];
