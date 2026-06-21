import type { ReleasePolicy } from "./policy";
import type { AeeRun, ArtifactRef, EvidenceBundle, EvidenceRecord, Finding, Judgment } from "./types";

export type PluginKind = "observer" | "judge" | "reporter" | "fix-provider";

export interface PluginDependency {
  kind: PluginKind;
  id: string;
  optional?: boolean;
}

export interface BasePluginManifest {
  id: string;
  displayName: string;
  version: string;
  kind: PluginKind;
  capabilities: string[];
  dependencies?: PluginDependency[];
}

export interface ObserverContext {
  runId: string;
  checkpointId?: string;
  interactionId?: string;
  url?: string;
  meta?: Record<string, unknown>;
}

export interface JudgeContext {
  runId: string;
  policyName?: string;
  releasePolicy?: ReleasePolicy;
  priorJudgments?: Judgment[];
  meta?: Record<string, unknown>;
}

export interface ReporterInput {
  run: AeeRun;
  bundles: EvidenceBundle[];
  records: EvidenceRecord[];
  judgments: Judgment[];
  findings: Finding[];
  artifacts: ArtifactRef[];
}

export interface ReporterArtifact {
  label: string;
  mimeType: string;
  content: string;
}

export interface ProposedFix {
  providerId: string;
  summary: string;
  rationale?: string;
  safety: "safe" | "review" | "unsafe";
  patches?: string[];
}

export interface ObserverPlugin {
  manifest: BasePluginManifest;
  setup?(context: ObserverContext): Promise<void>;
  captureBefore?(context: ObserverContext): Promise<EvidenceRecord[]>;
  captureAfter?(context: ObserverContext): Promise<EvidenceRecord[]>;
  teardown?(context: ObserverContext): Promise<void>;
}

export interface JudgePlugin {
  manifest: BasePluginManifest;
  judge(bundle: EvidenceBundle, context: JudgeContext): Promise<Judgment[]>;
}

export interface ReporterPlugin {
  manifest: BasePluginManifest;
  render(input: ReporterInput): Promise<ReporterArtifact[]>;
}

export interface FixProviderPlugin {
  manifest: BasePluginManifest;
  planFixes(bundle: EvidenceBundle, judgments: Judgment[]): Promise<ProposedFix[]>;
}
