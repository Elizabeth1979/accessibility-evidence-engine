import { type AnySchemaObject, type ErrorObject, type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";

import axeResultSchema from "../json/axe-result.schema.json";
import checkpointSchema from "../json/checkpoint.schema.json";
import cliConfigSchema from "../json/cli-config.schema.json";
import commonSchema from "../json/common.schema.json";
import elementMapSchema from "../json/element-map.schema.json";
import evidenceBundleSchema from "../json/evidence-bundle.schema.json";
import evidenceRecordSchema from "../json/evidence-record.schema.json";
import evidenceManifestSchema from "../json/evidence-manifest.schema.json";
import findingSchema from "../json/finding.schema.json";
import focusStateSchema from "../json/focus-state.schema.json";
import interactionSchema from "../json/interaction.schema.json";
import interactionComparisonSchema from "../json/interaction-comparison.schema.json";
import interactionComparisonRequestSchema from "../json/interaction-comparison-request.schema.json";
import interactionVideoSchema from "../json/interaction-video.schema.json";
import judgmentSchema from "../json/judgment.schema.json";
import keyboardPointerSweepLaneSchema from "../json/keyboard-pointer-sweep-lane.schema.json";
import remediationRegistrySchema from "../json/remediation-registry.schema.json";
import scenarioPlanSchema from "../json/scenario-plan.schema.json";
import scenarioReportSchema from "../json/scenario-report.schema.json";
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
  focusState: focusStateSchema,
  elementMap: elementMapSchema,
  remediationRegistry: remediationRegistrySchema,
  scenario: scenarioSchema,
  scenarioPlan: scenarioPlanSchema,
  scenarioReport: scenarioReportSchema,
  cliConfig: cliConfigSchema,
  virtualPageFixture: virtualPageFixtureSchema,
  virtualScreenReaderTranscript: virtualScreenReaderTranscriptSchema,
  virtualScreenReaderLane: virtualScreenReaderLaneSchema,
  keyboardPointerSweepLane: keyboardPointerSweepLaneSchema,
  interactionComparison: interactionComparisonSchema,
  interactionComparisonRequest: interactionComparisonRequestSchema,
  interactionVideo: interactionVideoSchema,
  evidenceManifest: evidenceManifestSchema,
  axeResult: axeResultSchema
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
  focusState: "AEE deep focus state",
  elementMap: "AEE element map",
  remediationRegistry: "AEE remediation registry",
  scenario: "AEE user-controlled scenario",
  scenarioPlan: "AEE compiled scenario plan",
  scenarioReport: "AEE integrated scenario report",
  cliConfig: "AEE CLI config",
  virtualPageFixture: "AEE virtual page fixture",
  virtualScreenReaderTranscript: "AEE portable virtual screen-reader transcript",
  virtualScreenReaderLane: "AEE portable virtual screen-reader lane",
  keyboardPointerSweepLane: "AEE keyboard and pointer sweep lane",
  interactionComparison: "AEE pointer and keyboard interaction comparison",
  interactionComparisonRequest: "AEE pointer and keyboard interaction comparison request",
  interactionVideo: "AEE interaction video sidecar",
  evidenceManifest: "AEE evidence manifest",
  axeResult: "AEE axe result"
};

/** The Ajv options AEE's schemas compile under: strict mode, with union types allowed. */
export const schemaAjvOptions = {
  allErrors: true,
  strictTypes: true,
  strictTuples: true,
  allowUnionTypes: true
} as const;

/**
 * The Ajv instance AEE validates with, holding every AEE schema.
 *
 * Strict mode is on, so a schema authoring mistake fails when the schema compiles instead of
 * being ignored (https://ajv.js.org/strict-mode.html). Ajv rejects unknown keywords and
 * formats and ignored keywords by default (`strictSchema`); `strictTypes` and `strictTuples`
 * only log by default, so they are raised to errors here: a keyword such as `minItems` with no
 * `type` saying which values it applies to fails the compile.
 *
 * `allowUnionTypes` lets `type` list several types, as JSON Schema's `type` keyword allows
 * (a state's value before and after a press is a string, number, boolean or null). Without it,
 * strict types asks for the same thing written as an `anyOf`.
 *
 * `strictRequired` stays at Ajv's default, off. Ajv compiles `allOf`, `anyOf`, `oneOf`, `not`
 * and `if`/`then`/`else` before the `properties` beside them, so it rejects a `required` inside
 * them although the enclosing schema declares the property: the way JSON Schema conditions
 * a required property.
 */
export function createSchemaAjv(): Ajv2020 {
  const ajv = new Ajv2020(schemaAjvOptions);

  addFormats(ajv);

  for (const schemaDocument of Object.values(schemaDocuments)) {
    ajv.addSchema(schemaDocument);
  }

  return ajv;
}

const ajv = createSchemaAjv();

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

/**
 * A schema as one self-contained document, for a reader that has none of AEE's other schema files,
 * such as an MCP client checking a tool's output. Each AEE schema it refers to, directly or through
 * another, is embedded under `$defs` with its own `$id`, which is how JSON Schema 2020-12 bundles a
 * schema (Core §9.3), so every relative `$ref` resolves inside the document unchanged.
 */
export function bundledSchema(schemaName: SchemaName): AnySchemaObject {
  const root: AnySchemaObject = schemaDocuments[schemaName];
  const embedded = new Map<string, AnySchemaObject>();
  const embedReferences = (document: AnySchemaObject) => {
    for (const ref of references(document)) {
      const target = new URL(ref, document.$id);
      target.hash = "";
      const [name, referenced] =
        Object.entries(schemaDocuments).find(([, { $id }]) => $id === target.href) ?? [];
      if (!name || !referenced || referenced === root || embedded.has(name)) {
        continue;
      }
      embedded.set(name, referenced);
      embedReferences(referenced);
    }
  };
  embedReferences(root);
  return { ...root, $defs: { ...root.$defs, ...Object.fromEntries(embedded) } };
}

/** Every `$ref` in a schema document, in any subschema. */
function references(schema: unknown): string[] {
  if (Array.isArray(schema)) return schema.flatMap(references);
  if (typeof schema !== "object" || schema === null) return [];
  return Object.entries(schema).flatMap(([key, value]) =>
    key === "$ref" && typeof value === "string" ? [value] : references(value)
  );
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
