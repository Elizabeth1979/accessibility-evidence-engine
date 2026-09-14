import { type AnySchemaObject, type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import checkpointSchema from "../json/checkpoint.schema.json";
import cliConfigSchema from "../json/cli-config.schema.json";
import commonSchema from "../json/common.schema.json";
import evidenceBundleSchema from "../json/evidence-bundle.schema.json";
import evidenceRecordSchema from "../json/evidence-record.schema.json";
import findingSchema from "../json/finding.schema.json";
import interactionSchema from "../json/interaction.schema.json";
import interactionComparisonSchema from "../json/interaction-comparison.schema.json";
import interactionComparisonRequestSchema from "../json/interaction-comparison-request.schema.json";
import judgmentSchema from "../json/judgment.schema.json";
import remediationRegistrySchema from "../json/remediation-registry.schema.json";
import scenarioPlanSchema from "../json/scenario-plan.schema.json";
import scenarioSchema from "../json/scenario.schema.json";
import reportSchema from "../json/report.schema.json";
import runSchema from "../json/run.schema.json";
import virtualPageFixtureSchema from "../json/virtual-page-fixture.schema.json";
import virtualScreenReaderLaneSchema from "../json/virtual-screen-reader-lane.schema.json";
import virtualScreenReaderTranscriptSchema from "../json/virtual-screen-reader-transcript.schema.json";

import type { SchemaName } from "./index";

const schemaDocuments = {
  common: commonSchema,
  run: runSchema,
  evidenceBundle: evidenceBundleSchema,
  report: reportSchema,
  checkpoint: checkpointSchema,
  interaction: interactionSchema,
  evidenceRecord: evidenceRecordSchema,
  judgment: judgmentSchema,
  finding: findingSchema,
  remediationRegistry: remediationRegistrySchema,
  scenario: scenarioSchema,
  scenarioPlan: scenarioPlanSchema,
  cliConfig: cliConfigSchema,
  virtualPageFixture: virtualPageFixtureSchema,
  virtualScreenReaderTranscript: virtualScreenReaderTranscriptSchema,
  virtualScreenReaderLane: virtualScreenReaderLaneSchema,
  interactionComparison: interactionComparisonSchema,
  interactionComparisonRequest: interactionComparisonRequestSchema
} as const satisfies Record<SchemaName, AnySchemaObject>;

const schemaTitles: Record<SchemaName, string> = {
  common: "AEE common schema payload",
  run: "AEE run payload",
  evidenceBundle: "AEE evidence bundle payload",
  report: "AEE report payload",
  checkpoint: "AEE checkpoint payload",
  interaction: "AEE interaction payload",
  evidenceRecord: "AEE evidence record payload",
  judgment: "AEE judgment payload",
  finding: "AEE finding payload",
  remediationRegistry: "AEE remediation registry",
  scenario: "AEE user-controlled scenario",
  scenarioPlan: "AEE compiled scenario plan",
  cliConfig: "AEE CLI config",
  virtualPageFixture: "AEE virtual page fixture",
  virtualScreenReaderTranscript: "AEE portable virtual screen-reader transcript",
  virtualScreenReaderLane: "AEE portable virtual screen-reader lane",
  interactionComparison: "AEE pointer and keyboard interaction comparison",
  interactionComparisonRequest: "AEE pointer and keyboard interaction comparison request"
};

const ajv = new Ajv2020({
  allErrors: true,
  strict: false
});

addFormats(ajv);

for (const schemaDocument of Object.values(schemaDocuments)) {
  ajv.addSchema(schemaDocument);
}

const validatorCache = new Map<SchemaName, ValidateFunction>();

export interface SchemaValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateSchema(schemaName: SchemaName, value: unknown): SchemaValidationResult {
  const validator = getSchemaValidator(schemaName);
  const valid = validator(value);

  return {
    valid: Boolean(valid),
    errors: valid ? [] : formatSchemaErrors(validator.errors ?? [])
  };
}

export function assertValidSchema(
  schemaName: SchemaName,
  value: unknown,
  label: string = schemaTitles[schemaName]
): asserts value {
  const result = validateSchema(schemaName, value);

  if (result.valid) {
    return;
  }

  throw new Error(`Invalid ${label}: ${result.errors.join("; ")}`);
}

function getSchemaValidator(schemaName: SchemaName): ValidateFunction {
  const cached = validatorCache.get(schemaName);

  if (cached) {
    return cached;
  }

  const schemaDocument = schemaDocuments[schemaName];
  const schemaId = typeof schemaDocument.$id === "string" ? schemaDocument.$id : undefined;
  const validator = (schemaId ? ajv.getSchema(schemaId) : undefined) ?? ajv.compile(schemaDocument);

  validatorCache.set(schemaName, validator);
  return validator;
}

function formatSchemaErrors(errors: ErrorObject[]): string[] {
  return errors.map((error) => {
    const path = error.instancePath.length > 0 ? error.instancePath : "(root)";

    if (error.keyword === "required" && typeof error.params.missingProperty === "string") {
      return `${path} is missing required property "${error.params.missingProperty}"`;
    }

    return `${path} ${error.message ?? "is invalid"}`;
  });
}
