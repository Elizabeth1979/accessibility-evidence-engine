import type {
  AeeRun,
  ArtifactRef,
  Checkpoint,
  CorrelationSummary,
  EvidenceBundle,
  EvidenceRecord,
  Interaction,
  Judgment
} from "./types";

export interface RunShellInput {
  id: string;
  version?: string;
  startedAt: string;
  environment?: Record<string, unknown>;
  config?: Record<string, unknown>;
}

export interface CorrelatedEvidenceInput {
  runId: string;
  interaction: Interaction;
  checkpoint?: Checkpoint;
  records: EvidenceRecord[];
  artifacts?: ArtifactRef[];
  strategy?: string;
  notes?: string[];
}

export function createRunShell(input: RunShellInput): AeeRun {
  return {
    id: input.id,
    version: input.version ?? "0.1.0",
    startedAt: input.startedAt,
    status: "pending",
    environment: input.environment,
    config: input.config,
    checkpoints: [],
    interactions: []
  };
}

export function sortEvidenceRecords(records: EvidenceRecord[]): EvidenceRecord[] {
  return [...records].sort((left, right) => {
    if (left.timestamp === right.timestamp) {
      return left.observerId.localeCompare(right.observerId);
    }

    return left.timestamp.localeCompare(right.timestamp);
  });
}

export function buildEvidenceBundle(input: CorrelatedEvidenceInput): EvidenceBundle {
  const sortedRecords = sortEvidenceRecords(input.records);
  const artifacts = input.artifacts ?? collectArtifacts(sortedRecords);
  const correlation: CorrelationSummary = {
    strategy: input.strategy ?? "observer-record-grouping",
    participatingObserverIds: [...new Set(sortedRecords.map((record) => record.observerId))],
    notes: input.notes
  };

  return {
    runId: input.runId,
    interaction: input.interaction,
    checkpoint: input.checkpoint,
    records: sortedRecords,
    artifacts,
    correlation
  };
}

export function summarizeJudgments(judgments: Judgment[]): AeeRun["results"] {
  return judgments.reduce(
    (summary, judgment) => {
      if (judgment.verdict === "pass") {
        summary.pass += 1;
      } else if (judgment.verdict === "fail") {
        summary.fail += 1;
      } else {
        summary.unknown += 1;
      }

      return summary;
    },
    {
      pass: 0,
      fail: 0,
      unknown: 0
    }
  );
}

function collectArtifacts(records: EvidenceRecord[]): ArtifactRef[] {
  const seen = new Map<string, ArtifactRef>();

  for (const record of records) {
    const refs = [
      record.beforeStateRef,
      record.afterStateRef,
      record.rawRef,
      ...(record.artifacts ?? [])
    ].filter((value): value is ArtifactRef => Boolean(value));

    for (const ref of refs) {
      seen.set(ref.id, ref);
    }
  }

  return [...seen.values()];
}
