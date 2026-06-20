export const CURRENT_SCHEMA_VERSION = "0.1.0";

export const schemaCatalog = {
  common: "json/common.schema.json",
  run: "json/run.schema.json",
  checkpoint: "json/checkpoint.schema.json",
  interaction: "json/interaction.schema.json",
  evidenceRecord: "json/evidence-record.schema.json",
  judgment: "json/judgment.schema.json",
  finding: "json/finding.schema.json"
} as const;

export type SchemaName = keyof typeof schemaCatalog;

