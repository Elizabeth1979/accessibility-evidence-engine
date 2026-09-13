export type UID = string;
export type IsoTimestamp = string;

export type ArtifactKind =
  | "screenshot"
  | "dom-snapshot"
  | "accessibility-tree"
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
