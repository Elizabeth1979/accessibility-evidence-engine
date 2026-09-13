export const CURRENT_SCHEMA_VERSION = "0.1.0";

export const schemaCatalog = {
  common: "json/common.schema.json",
  run: "json/run.schema.json",
  evidenceBundle: "json/evidence-bundle.schema.json",
  report: "json/report.schema.json",
  checkpoint: "json/checkpoint.schema.json",
  interaction: "json/interaction.schema.json",
  evidenceRecord: "json/evidence-record.schema.json",
  judgment: "json/judgment.schema.json",
  finding: "json/finding.schema.json",
  remediationRegistry: "json/remediation-registry.schema.json",
  cliConfig: "json/cli-config.schema.json",
  virtualPageFixture: "json/virtual-page-fixture.schema.json"
} as const;

export type SchemaName = keyof typeof schemaCatalog;

export * from "./validator";
