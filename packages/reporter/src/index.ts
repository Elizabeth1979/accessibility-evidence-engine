import type {
  ArtifactRef,
  EvidenceBundle,
  EvidenceRecord,
  Finding,
  Judgment,
  ReporterArtifact,
  ReporterInput,
  ReporterPlugin,
  RunSummary,
  TargetDescriptor
} from "@aee/core";
import { assertValidSchema, CURRENT_SCHEMA_VERSION } from "@aee/schemas";

interface ObserverCoverageSummary {
  observerId: string;
  records: number;
  ok: number;
  unsupported: number;
  noSignal: number;
  observerError: number;
  timeout: number;
  artifacts: number;
}

export function createJsonReporter(): ReporterPlugin {
  return {
    manifest: {
      id: "json",
      displayName: "JSON Reporter",
      version: "0.1.0",
      kind: "reporter",
      capabilities: ["json"]
    },
    async render(input: ReporterInput): Promise<ReporterArtifact[]> {
      const payload = buildReportPayload(input);

      assertValidSchema("report", payload, "AEE JSON report payload");

      return [
        {
          label: "aee-report.json",
          mimeType: "application/json",
          content: JSON.stringify(payload, null, 2)
        }
      ];
    }
  };
}

export function createMarkdownReporter(): ReporterPlugin {
  return {
    manifest: {
      id: "markdown",
      displayName: "Markdown Reporter",
      version: "0.1.0",
      kind: "reporter",
      capabilities: ["markdown"]
    },
    async render(input: ReporterInput): Promise<ReporterArtifact[]> {
      return [
        {
          label: "aee-report.md",
          mimeType: "text/markdown",
          content: renderMarkdownReport(input)
        }
      ];
    }
  };
}

function buildReportPayload(input: ReporterInput) {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    run: input.run,
    bundles: input.bundles,
    records: input.records,
    judgments: input.judgments,
    findings: input.findings,
    artifacts: input.artifacts
  };
}

function renderMarkdownReport(input: ReporterInput): string {
  const lines: string[] = ["# AEE Report", ""];
  const verdicts = input.run.results ?? summarizeVerdicts(input.judgments);
  const observerCoverage = summarizeObserverCoverage(input.records);
  const artifactSummary = summarizeArtifacts(input.artifacts);

  lines.push("## Run Summary", "");
  lines.push(
    ...renderTable(
      ["Field", "Value"],
      [
        ["Schema version", CURRENT_SCHEMA_VERSION],
        ["Run ID", input.run.id],
        ["Status", input.run.status],
        ["Started", input.run.startedAt],
        ["Finished", input.run.finishedAt ?? "n/a"],
        ["Environment mode", getStringField(input.run.environment, "mode") ?? "n/a"],
        ["Policy", getStringField(input.run.config, "policyName") ?? "n/a"],
        ["Bundles", String(input.bundles.length)],
        ["Evidence records", String(input.records.length)],
        ["Judgments", String(input.judgments.length)],
        ["Findings", String(input.findings.length)],
        ["Artifacts", String(input.artifacts.length)],
        ["Verdicts", formatRunSummary(verdicts)]
      ]
    ),
    ""
  );

  lines.push("## Observer Coverage", "");
  if (observerCoverage.length === 0) {
    lines.push("No evidence records were captured.", "");
  } else {
    lines.push(
      ...renderTable(
        ["Observer", "Records", "OK", "Unsupported", "No Signal", "Observer Error", "Timeout", "Artifacts"],
        observerCoverage.map((summary) => [
          summary.observerId,
          String(summary.records),
          String(summary.ok),
          String(summary.unsupported),
          String(summary.noSignal),
          String(summary.observerError),
          String(summary.timeout),
          String(summary.artifacts)
        ])
      ),
      ""
    );
  }

  lines.push("## Artifact Summary", "");
  if (artifactSummary.length === 0) {
    lines.push("No artifacts were attached to this run.", "");
  } else {
    lines.push(
      ...renderTable(
        ["Kind", "Count"],
        artifactSummary.map(([kind, count]) => [kind, String(count)])
      ),
      ""
    );
  }

  if (input.judgments.length === 0) {
    lines.push("## Judgments", "", "No judgments were emitted.", "");
  }

  input.bundles.forEach((bundle, index) => {
    const bundleJudgments = findJudgmentsForBundle(bundle, input.judgments);
    const bundleFindings = findFindingsForBundle(bundle, input.findings);
    const interactionHeading = describeInteraction(bundle);

    lines.push(`## Bundle ${index + 1}: ${interactionHeading}`, "");
    lines.push(
      ...renderTable(
        ["Field", "Value"],
        [
          ["Interaction ID", bundle.interaction.id],
          ["Interaction", bundle.interaction.kind],
          ["Target", describeTarget(bundle.interaction.target)],
          ["Checkpoint", bundle.checkpoint?.name ?? bundle.checkpoint?.id ?? "n/a"],
          ["URL", bundle.checkpoint?.url ?? "n/a"],
          ["Correlation strategy", bundle.correlation.strategy],
          ["Participating observers", formatList(bundle.correlation.participatingObserverIds)],
          ["Correlation notes", formatList(bundle.correlation.notes)],
          ["Records", String(bundle.records.length)],
          ["Artifacts", String(bundle.artifacts.length)],
          ["Judgments", String(bundleJudgments.length)],
          ["Findings", String(bundleFindings.length)]
        ]
      ),
      ""
    );

    lines.push("### Evidence Records", "");
    lines.push(
      ...renderTable(
        ["ID", "Phase", "Observer", "Status", "Confidence", "Artifacts", "Changes", "Summary"],
        bundle.records.map((record) => [
          record.id,
          record.phase,
          record.observerId,
          record.status,
          formatConfidence(record.confidence),
          String(collectRecordArtifacts(record).length),
          String(record.changes?.length ?? 0),
          record.summary ?? "No summary provided."
        ])
      ),
      ""
    );

    lines.push("### Judgments", "");
    if (bundleJudgments.length === 0) {
      lines.push("No judgments matched this bundle.", "");
    } else {
      lines.push(
        ...renderTable(
          ["ID", "Verdict", "Judge", "Severity", "Confidence", "Evidence", "Artifacts", "Summary"],
          bundleJudgments.map((judgment) => [
            judgment.id,
            judgment.verdict,
            judgment.judgeId,
            judgment.severity ?? "n/a",
            formatConfidence(judgment.confidence),
            String(judgment.evidenceRecordIds.length),
            String(judgment.artifactIds?.length ?? 0),
            judgment.summary
          ])
        ),
        ""
      );
    }

    lines.push("### Findings", "");
    if (bundleFindings.length === 0) {
      lines.push("No findings were emitted for this bundle.", "");
    } else {
      lines.push(
        ...renderTable(
          ["ID", "Severity", "Rule", "Evidence", "Artifacts", "Message", "Suggested Fix"],
          bundleFindings.map((finding) => [
            finding.id,
            finding.severity,
            finding.ruleId ?? "n/a",
            String(finding.evidenceRecordIds.length),
            String(finding.artifactIds?.length ?? 0),
            finding.message,
            finding.suggestedFix ?? "n/a"
          ])
        ),
        ""
      );
    }

    lines.push("### Artifacts", "");
    if (bundle.artifacts.length === 0) {
      lines.push("No artifacts were correlated into this bundle.", "");
    } else {
      lines.push(
        ...renderTable(
          ["ID", "Kind", "Media Type", "Path", "Description"],
          bundle.artifacts.map((artifact) => [
            artifact.id,
            artifact.kind,
            artifact.mediaType ?? "n/a",
            artifact.path,
            artifact.description ?? "n/a"
          ])
        ),
        ""
      );
    }
  });

  return lines.join("\n");
}

function summarizeVerdicts(judgments: Judgment[]): RunSummary {
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

function summarizeObserverCoverage(records: EvidenceRecord[]): ObserverCoverageSummary[] {
  const summaries = new Map<string, ObserverCoverageSummary>();

  for (const record of records) {
    const existing = summaries.get(record.observerId) ?? {
      observerId: record.observerId,
      records: 0,
      ok: 0,
      unsupported: 0,
      noSignal: 0,
      observerError: 0,
      timeout: 0,
      artifacts: 0
    };

    existing.records += 1;
    existing.artifacts += collectRecordArtifacts(record).length;

    if (record.status === "ok") {
      existing.ok += 1;
    } else if (record.status === "unsupported") {
      existing.unsupported += 1;
    } else if (record.status === "no_signal") {
      existing.noSignal += 1;
    } else if (record.status === "observer_error") {
      existing.observerError += 1;
    } else if (record.status === "timeout") {
      existing.timeout += 1;
    }

    summaries.set(record.observerId, existing);
  }

  return [...summaries.values()].sort((left, right) => left.observerId.localeCompare(right.observerId));
}

function summarizeArtifacts(artifacts: ArtifactRef[]): Array<[string, number]> {
  const counts = new Map<string, number>();

  for (const artifact of artifacts) {
    counts.set(artifact.kind, (counts.get(artifact.kind) ?? 0) + 1);
  }

  return [...counts.entries()].sort((left, right) => left[0].localeCompare(right[0]));
}

function findJudgmentsForBundle(bundle: EvidenceBundle, judgments: Judgment[]): Judgment[] {
  const bundleRecordIds = new Set(bundle.records.map((record) => record.id));
  const bundleArtifactIds = new Set(bundle.artifacts.map((artifact) => artifact.id));

  return judgments.filter(
    (judgment) =>
      hasOverlap(judgment.evidenceRecordIds, bundleRecordIds) || hasOverlap(judgment.artifactIds ?? [], bundleArtifactIds)
  );
}

function findFindingsForBundle(bundle: EvidenceBundle, findings: Finding[]): Finding[] {
  const bundleRecordIds = new Set(bundle.records.map((record) => record.id));
  const bundleArtifactIds = new Set(bundle.artifacts.map((artifact) => artifact.id));

  return findings.filter(
    (finding) =>
      hasOverlap(finding.evidenceRecordIds, bundleRecordIds) || hasOverlap(finding.artifactIds ?? [], bundleArtifactIds)
  );
}

function hasOverlap(values: string[], candidates: Set<string>): boolean {
  return values.some((value) => candidates.has(value));
}

function collectRecordArtifacts(record: EvidenceRecord): ArtifactRef[] {
  const uniqueArtifacts = new Map<string, ArtifactRef>();

  for (const artifact of [
    record.beforeStateRef,
    record.afterStateRef,
    record.rawRef,
    ...(record.artifacts ?? [])
  ]) {
    if (!artifact) {
      continue;
    }

    uniqueArtifacts.set(artifact.id, artifact);
  }

  return [...uniqueArtifacts.values()];
}

function describeInteraction(bundle: EvidenceBundle): string {
  const target = describeTarget(bundle.interaction.target);

  if (target === "n/a") {
    return `\`${bundle.interaction.kind}\``;
  }

  return `\`${bundle.interaction.kind}\` on ${target}`;
}

function describeTarget(target?: TargetDescriptor): string {
  if (!target) {
    return "n/a";
  }

  const parts = [
    target.role,
    target.name ? `"${target.name}"` : undefined,
    target.selector,
    target.locator,
    target.nodePath
  ].filter((value): value is string => Boolean(value));

  return parts.length > 0 ? parts.join(" ") : "n/a";
}

function renderTable(headers: string[], rows: string[][]): string[] {
  return [
    `| ${headers.map((header) => escapeMarkdownCell(header)).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) =>
      `| ${headers
        .map((_, index) => escapeMarkdownCell(row[index] ?? ""))
        .join(" | ")} |`
    )
  ];
}

function escapeMarkdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

function formatConfidence(value?: number): string {
  if (typeof value !== "number") {
    return "n/a";
  }

  return value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatRunSummary(summary: RunSummary): string {
  return `pass ${summary.pass}, fail ${summary.fail}, unknown ${summary.unknown}`;
}

function formatList(values?: string[]): string {
  return values && values.length > 0 ? values.join(", ") : "n/a";
}

function getStringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}
