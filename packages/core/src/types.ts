export type UID = string;
export type IsoTimestamp = string;

export type ArtifactKind =
  | "screenshot"
  | "dom-snapshot"
  | "accessibility-tree"
  | "element-map"
  | "network-log"
  | "screen-reader-log"
  | "axe-result"
  | "trace"
  | "video"
  | "custom";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ArtifactRef {
  id: UID;
  kind: ArtifactKind;
  path: string;
  mediaType?: string;
  contentHash?: string;
  description?: string;
}

export interface TargetDescriptor {
  role?: string;
  name?: string;
  /**
   * Whether `name` is the whole accessible name (true, the default) or a part of it, matched
   * without regard to case, as Playwright's `getByRole` takes it.
   */
  exact?: boolean;
  selector?: string;
  locator?: string;
  nodePath?: string;
  boundingBox?: BoundingBox;
}

export type InteractionKind =
  | "tab"
  | "shift-tab"
  | "click"
  | "hover"
  | "focus"
  | "enter"
  | "space"
  | "escape"
  | "arrow-key"
  | "type"
  | "submit"
  | "screen-reader-command"
  | "custom";

export interface Interaction {
  id: UID;
  runId: UID;
  checkpointId?: UID;
  timestamp: IsoTimestamp;
  actor: "test" | "engine" | "user-script";
  kind: InteractionKind;
  target?: TargetDescriptor;
  input?: string;
  meta?: Record<string, unknown>;
}

export interface Checkpoint {
  id: UID;
  runId: UID;
  name?: string;
  url?: string;
  timestamp: IsoTimestamp;
  trigger: "initial-load" | "post-interaction" | "assertion" | "manual";
  pageSnapshotRef?: ArtifactRef;
  artifactIds?: UID[];
}

export type ObserverPhase = "before" | "after" | "continuous";

export type ObserverStatus = "ok" | "unsupported" | "no_signal" | "observer_error" | "timeout";

export interface EvidenceChange {
  path: string;
  summary: string;
  before?: unknown;
  after?: unknown;
  impact?: "none" | "minor" | "major" | "unknown";
}

export interface EvidenceRecord {
  id: UID;
  runId: UID;
  checkpointId?: UID;
  interactionId?: UID;
  observerId: string;
  observerVersion?: string;
  phase: ObserverPhase;
  status: ObserverStatus;
  timestamp: IsoTimestamp;
  confidence?: number;
  summary?: string;
  beforeStateRef?: ArtifactRef;
  afterStateRef?: ArtifactRef;
  changes?: EvidenceChange[];
  artifacts?: ArtifactRef[];
  rawRef?: ArtifactRef;
  diagnostics?: string[];
  meta?: Record<string, unknown>;
}

/** The control states a screen reader announces when they change (WAI-ARIA 1.2 states). */
export const TRACKED_ACCESSIBILITY_STATES = [
  "checked",
  "expanded",
  "pressed",
  "selected",
  "value"
] as const;

export type TrackedAccessibilityState = (typeof TRACKED_ACCESSIBILITY_STATES)[number];

/** A node of the browser's accessibility tree, as an accessibility-tree record names it. */
export interface AccessibilityNodeRef {
  /** The DOM node's backend id, the same in both snapshots for as long as the node lives. */
  nodeId: number;
  role: string;
  name?: string;
}

/** One change between the accessibility tree before an interaction and after it. */
export interface AccessibilityChange extends AccessibilityNodeRef {
  /** `state`: a tracked state changed. `shown`/`hidden`: the node entered or left the tree. `name`: its accessible name changed. */
  kind: "state" | "shown" | "hidden" | "name";
  state?: TrackedAccessibilityState;
  before?: string | number | boolean | null;
  after?: string | number | boolean | null;
  /** The nodes whose `aria-controls` names this node, in either snapshot. */
  controlledBy?: AccessibilityNodeRef[];
}

/** What an accessibility-tree record's `meta.accessibilityChanges` holds after an interaction. */
export interface AccessibilityChanges {
  /** The node that had focus before the interaction: what a key press acts on. */
  focusedBefore?: AccessibilityNodeRef;
  /** The node that has focus after it. */
  focusedAfter?: AccessibilityNodeRef;
  changes: AccessibilityChange[];
  /** True when more nodes changed than are listed. */
  truncated: boolean;
  /** The live regions that hold a listed change: which region a screen reader would hear from. */
  liveRegions?: LiveRegionRef[];
}

/**
 * A live region as Chrome's accessibility tree reports it: the nearest node with a `live`
 * property of polite or assertive (WAI-ARIA 1.2 `aria-live`, or a role such as `status` that
 * implies it).
 */
export interface LiveRegionRef extends AccessibilityNodeRef {
  politeness: "polite" | "assertive";
  /** The region's text in the later snapshot (the earlier one if it left the page), in tree order. */
  text: string;
}

/** A live-region update Guidepup's virtual screen reader announced (WAI-ARIA 1.2 `aria-live`). */
export interface LiveRegionAnnouncement {
  sequence: number;
  timestamp: IsoTimestamp;
  politeness: "polite" | "assertive";
  /** What the reader said, without its politeness prefix. */
  text: string;
}

export interface CorrelationSummary {
  strategy: string;
  participatingObserverIds: string[];
  unknownObserverIds?: string[];
  notes?: string[];
}

export interface EvidenceBundle {
  runId: UID;
  interaction: Interaction;
  checkpoint?: Checkpoint;
  records: EvidenceRecord[];
  artifacts: ArtifactRef[];
  correlation: CorrelationSummary;
}

export type FindingSeverity = "info" | "low" | "medium" | "high" | "critical";
export type JudgmentVerdict = "pass" | "fail" | "unknown";

export interface Finding {
  id: UID;
  message: string;
  severity: FindingSeverity;
  ruleId?: string;
  target?: TargetDescriptor;
  evidenceRecordIds: UID[];
  artifactIds?: UID[];
  suggestedFix?: string;
  tags?: string[];
}

export interface Judgment {
  id: UID;
  judgeId: string;
  judgeVersion?: string;
  scope: "run" | "checkpoint" | "interaction" | "component";
  verdict: JudgmentVerdict;
  summary: string;
  severity?: FindingSeverity;
  confidence?: number;
  evidenceRecordIds: UID[];
  artifactIds?: UID[];
  findings?: Finding[];
  rationale?: string;
  suggestedFix?: string;
  tags?: string[];
}

export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface RunSummary {
  pass: number;
  fail: number;
  unknown: number;
}

export interface AeeRun {
  id: UID;
  version: string;
  startedAt: IsoTimestamp;
  finishedAt?: IsoTimestamp;
  status: RunStatus;
  checkpoints?: Checkpoint[];
  interactions?: Interaction[];
  results?: RunSummary;
  environment?: Record<string, unknown>;
  config?: Record<string, unknown>;
}
