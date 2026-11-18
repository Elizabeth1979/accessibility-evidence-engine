// Writes AEE's evidence types from its JSON schemas, with openapi-typescript, to
// packages/schemas/src/schema-types.ts. The schemas are the source of truth: `npm run build` writes
// the file and `npm run check` fails when the committed one differs from what the schemas give, so a
// schema change and the types it makes land in the same PR.
//
// Every schema is bundled into one document first: an OpenAPI 3.1 document with no paths, whose
// `components.schemas` hold each schema and each of its `$defs` under the name of its type, with
// every `$ref` pointed there. OpenAPI 3.1's schemas are JSON Schema 2020-12, so the schemas go in as
// they are. openapi-typescript then reads no file and fetches no URL, declares each type once under
// `components`, and exports it under its own name (`rootTypes`). Each type is named here, from the
// table below; a type the tool would name itself fails the run, since its name could change with
// any schema. TypeScript cannot express a condition (`if`/`then`/`else`) or an exclusion (`not`);
// they are left out of the bundle, so the types say what a document always has and the validator
// checks the rest at run time.
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import openapiTS, { astToString } from "openapi-typescript";
import prettier from "prettier";
import ts from "typescript";

const repoRoot = path.resolve(import.meta.dirname, "..");
export const schemaDir = path.join(repoRoot, "packages", "schemas", "json");
export const typesFile = path.join(repoRoot, "packages", "schemas", "src", "schema-types.ts");

/**
 * The type each schema gives, and each of its `$defs`, by the name AEE's packages export it under.
 * `schema` is the name the schema has in `@aee/schemas`' catalog; a schema that is only a set of
 * definitions has no type of its own.
 */
export const TYPE_NAMES = {
  "axe-result.schema.json": {
    schema: "axeResult",
    type: "AxeResultFile",
    defs: {
      rule: "AxeResultRule",
      node: "AxeResultNode",
      impact: "AxeImpact",
      target: "AxeTarget",
      check: "AxeResultCheck",
      colorContrastData: "AxeColorContrastData",
      elementContext: "ElementContext",
      contrastMeasurement: "ContrastMeasurement",
      measuredContrast: "MeasuredContrast",
      contrastExtreme: "ContrastExtreme",
      frameNotChecked: "FrameNotChecked"
    }
  },
  "checkpoint.schema.json": { schema: "checkpoint", type: "Checkpoint", defs: {} },
  "cli-config.schema.json": {
    schema: "cliConfig",
    type: "AeeCliConfig",
    defs: { policy: "AeePolicyOverrides" }
  },
  "common.schema.json": {
    schema: "common",
    defs: {
      uid: "UID",
      isoTimestamp: "IsoTimestamp",
      digest: "Digest",
      interactionKind: "InteractionKind",
      runSummary: "RunSummary",
      liveRegionAnnouncement: "LiveRegionAnnouncement",
      artifactKind: "ArtifactKind",
      artifactRef: "ArtifactRef",
      targetDescriptor: "TargetDescriptor",
      severity: "FindingSeverity",
      verdict: "JudgmentVerdict",
      targetBox: "ElementLocation",
      videoEvidence: "InteractionVideoEvidence"
    }
  },
  "element-map.schema.json": {
    schema: "elementMap",
    type: "ElementMap",
    defs: { element: "ElementMapEntry" }
  },
  "evidence-bundle.schema.json": { schema: "evidenceBundle", type: "EvidenceBundle", defs: {} },
  "evidence-manifest.schema.json": {
    schema: "evidenceManifest",
    type: "EvidenceManifest",
    defs: { artifact: "EvidenceManifestArtifact" }
  },
  "evidence-record.schema.json": {
    schema: "evidenceRecord",
    type: "EvidenceRecord",
    defs: {
      accessibilityNodeRef: "AccessibilityNodeRef",
      accessibilityChange: "AccessibilityChange",
      accessibilityChanges: "AccessibilityChanges",
      liveRegion: "LiveRegionRef"
    }
  },
  "finding.schema.json": { schema: "finding", type: "Finding", defs: {} },
  "focus-state.schema.json": {
    schema: "focusState",
    type: "FocusState",
    defs: { domFocusState: "DomFocusState", element: "FocusedElement" }
  },
  "interaction-comparison-request.schema.json": {
    schema: "interactionComparisonRequest",
    type: "InputComparisonRequestDocument",
    defs: {}
  },
  "interaction-comparison.schema.json": {
    schema: "interactionComparison",
    type: "InputComparisonDocument",
    defs: {
      target: "InputComparisonTarget",
      action: "InputComparisonAction",
      observe: "InputComparisonObservationRequest",
      observation: "InputComparisonObservation",
      expectation: "InputComparisonExpectation",
      request: "InputComparisonRequest",
      step: "InputComparisonStep",
      lane: "InputComparisonLane"
    }
  },
  "interaction-video.schema.json": {
    schema: "interactionVideo",
    type: "InteractionVideoSidecar",
    defs: {}
  },
  "interaction.schema.json": { schema: "interaction", type: "Interaction", defs: {} },
  "judgment.schema.json": { schema: "judgment", type: "Judgment", defs: {} },
  "keyboard-pointer-sweep-lane.schema.json": {
    schema: "keyboardPointerSweepLane",
    type: "KeyboardPointerSweepLaneDocument",
    defs: {
      failedNavigation: "FailedNavigation",
      finding: "KeyboardPointerSweepLaneFinding",
      tabStop: "KeyboardPointerSweepLaneTabStop"
    }
  },
  "remediation-registry.schema.json": {
    schema: "remediationRegistry",
    type: "RemediationRegistry",
    defs: {
      entry: "RemediationEntry",
      requirement: "RemediationRequirement",
      aiPolicy: "RemediationAiPolicy"
    }
  },
  "report.schema.json": { schema: "report", type: "AeeReport", defs: {} },
  "run.schema.json": { schema: "run", type: "AeeRun", defs: {} },
  "scenario-plan.schema.json": {
    schema: "scenarioPlan",
    type: "ScenarioPlan",
    defs: { capability: "ScenarioCapability", plannedJourney: "ScenarioPlannedJourney" }
  },
  "scenario-report.schema.json": {
    schema: "scenarioReport",
    type: "ScenarioReportDocument",
    defs: { resultCounts: "ScenarioResultCounts" }
  },
  "scenario.schema.json": {
    schema: "scenario",
    type: "AeeScenario",
    defs: { journey: "ScenarioJourney", actionId: "ScenarioActionId", privacy: "ScenarioPrivacy" }
  },
  "virtual-page-fixture.schema.json": {
    schema: "virtualPageFixture",
    type: "VirtualPageFixture",
    defs: {}
  },
  "virtual-screen-reader-lane.schema.json": {
    schema: "virtualScreenReaderLane",
    type: "VirtualScreenReaderLaneDocument",
    defs: { step: "VirtualScreenReaderLaneStep" }
  },
  "virtual-screen-reader-transcript.schema.json": {
    schema: "virtualScreenReaderTranscript",
    type: "VirtualScreenReaderTranscript",
    defs: {
      command: "VirtualScreenReaderCommand",
      item: "VirtualScreenReaderItem",
      focus: "VirtualScreenReaderFocus",
      frame: "VirtualScreenReaderFrame",
      accessibilityProperty: "AccessibilityProperty",
      entry: "VirtualScreenReaderEntry"
    }
  }
};

/** The type that maps each schema's catalog name to the type of the document it checks. */
const DOCUMENTS_TYPE = "SchemaDocuments";

/** Keywords TypeScript cannot express. */
const VALIDATION_ONLY_KEYWORDS = new Set(["if", "then", "else", "not"]);

const BANNER = [
  "// Generated by scripts/generate-schema-types.mjs from the JSON schemas in packages/schemas/json.",
  "// Do not edit it by hand: change the schema, then run `npm run build`."
].join("\n");

/** The TypeScript the schemas in `directory` give, formatted as the repository formats code. */
export async function generateSchemaTypes(directory = schemaDir) {
  const files = (await readdir(directory)).filter((file) => file.endsWith(".schema.json")).sort();
  const unnamed = files.filter((file) => !Object.hasOwn(TYPE_NAMES, file));
  if (unnamed.length > 0) {
    throw new Error(
      `Name the types of ${unnamed.join(", ")} in scripts/generate-schema-types.mjs.`
    );
  }
  const schemas = await Promise.all(
    files.map(async (file) => ({
      file,
      schema: JSON.parse(await readFile(path.join(directory, file), "utf8"))
    }))
  );
  const fileById = new Map(schemas.map(({ file, schema }) => [schema.$id, file]));
  const documents = {
    description: "Each AEE schema, by its name in `schemaCatalog`, and the document it checks.",
    type: "object",
    additionalProperties: false,
    required: [],
    properties: {}
  };
  const components = { [DOCUMENTS_TYPE]: documents };

  for (const { file, schema } of schemas) {
    const names = TYPE_NAMES[file];
    const point = (ref) => bundleRef(ref, schema.$id, fileById);
    const { $defs = {}, ...root } = schema;
    for (const [def, definition] of Object.entries($defs)) {
      const name = names.defs[def];
      if (!name) {
        throw new Error(
          `Name the type of ${file}#/$defs/${def} in scripts/generate-schema-types.mjs.`
        );
      }
      components[name] = typeSchema(definition, point);
    }
    documents.required.push(names.schema);
    if (names.type) {
      components[names.type] = typeSchema(root, point);
      documents.properties[names.schema] = { $ref: componentRef(names.type) };
    } else {
      // A schema of definitions alone accepts any document.
      documents.properties[names.schema] = {};
    }
  }

  const nodes = await openapiTS(
    {
      openapi: "3.1.0",
      info: { title: "AEE evidence documents", version: "1" },
      components: { schemas: components }
    },
    {
      // JSON Schema's meanings, where OpenAPI's defaults differ: a schema that says nothing is any
      // value, and a property with a `default` may still be left out.
      emptyObjectsUnknown: true,
      defaultNonNullable: false,
      rootTypes: true,
      rootTypesNoSchemaPrefix: true,
      rootTypesKeepCasing: true
    }
  );
  // The document has no paths, webhooks or operations: their declarations are empty, and left out.
  const declarations = nodes.filter(
    (node) => !(ts.isTypeAliasDeclaration(node) && EMPTY_DECLARATIONS.has(node.name.text))
  );
  const declared = astToString(declarations);
  const expectedNames = new Set(Object.keys(components));
  const declaredNames = new Set(
    [...declared.matchAll(/^export type (\w+) = components\['schemas'\]\['(\w+)'\];$/gm)].map(
      ([, name, component]) => {
        if (name !== component) {
          throw new Error(`openapi-typescript exported ${component} as ${name}.`);
        }
        return name;
      }
    )
  );
  const surprises = [...declared.matchAll(/^export (?:interface|type) (\w+)/gm)]
    .map(([, name]) => name)
    .filter((name) => name !== "components" && !declaredNames.has(name));
  if (surprises.length > 0) {
    throw new Error(`openapi-typescript declared types of its own: ${surprises.join(", ")}.`);
  }
  const stale = [...expectedNames].filter((name) => !declaredNames.has(name));
  if (stale.length > 0) {
    throw new Error(
      `scripts/generate-schema-types.mjs names types no schema has: ${stale.join(", ")}.`
    );
  }
  const prettierConfig = (await prettier.resolveConfig(typesFile)) ?? {};
  return prettier.format(`${BANNER}\n\n${declared}`, { ...prettierConfig, parser: "typescript" });
}

/** The declarations openapi-typescript writes for an API's parts, which the bundle has none of. */
const EMPTY_DECLARATIONS = new Set(["paths", "webhooks", "$defs", "operations"]);

function componentRef(name) {
  return `#/components/schemas/${name}`;
}

/** Where a schema's `$ref` points in the bundle: the component of the type it names. */
function bundleRef(ref, baseId, fileById) {
  const target = new URL(ref, baseId);
  const fragment = target.hash;
  target.hash = "";
  const file = fileById.get(target.href);
  if (!file) throw new Error(`No AEE schema has the $id ${target.href} (from ${ref}).`);
  const names = TYPE_NAMES[file];
  if (fragment === "") {
    if (!names.type) throw new Error(`${ref} points at ${file}, which has no type of its own.`);
    return componentRef(names.type);
  }
  const def = /^#\/\$defs\/([^/]+)$/.exec(fragment)?.[1];
  if (!def || !names.defs[def]) throw new Error(`Point ${ref} at a schema or one of its $defs.`);
  return componentRef(names.defs[def]);
}

/**
 * A schema as the bundle holds it: its `$ref`s pointed into the bundle, and what TypeScript cannot
 * express left out.
 *
 * - `if`/`then`/`else` and `not` go.
 * - A subschema that says nothing of the value's type, such as `{ "required": ["selector"] }`, goes
 *   from an `allOf`, where it adds nothing to the type; in an `anyOf` or `oneOf` it allows any value
 *   of the type the rest of the schema gives, so the whole union goes.
 * - An object schema with no `additionalProperties` is given `additionalProperties: true`, which is
 *   what it means in JSON Schema (Core §10.3.2.3): a document may hold other members.
 *   openapi-typescript would type it as closed, and its own `additionalProperties` option opens
 *   every object, the ones the schema closes too.
 */
function typeSchema(node, point) {
  if (Array.isArray(node)) return node.map((item) => typeSchema(item, point));
  if (typeof node !== "object" || node === null) return node;
  const copy = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "$id" || key === "$schema" || VALIDATION_ONLY_KEYWORDS.has(key)) continue;
    if (key === "$ref") {
      copy.$ref = point(value);
    } else if (key === "allOf") {
      const members = typeSchema(value, point).filter(describesType);
      if (members.length > 0) copy.allOf = members;
    } else if (key === "anyOf" || key === "oneOf") {
      const members = typeSchema(value, point);
      if (members.every(describesType)) copy[key] = members;
    } else if (key === "properties") {
      // Property names are data, not keywords: a property may be called `$schema`.
      copy.properties = Object.fromEntries(
        Object.entries(value).map(([name, property]) => [name, typeSchema(property, point)])
      );
    } else {
      copy[key] = typeSchema(value, point);
    }
  }
  if (describesObject(copy) && !Object.hasOwn(copy, "additionalProperties")) {
    copy.additionalProperties = true;
  }
  return copy;
}

/** The keywords that say what type a value has, as opposed to which values of it are valid. */
const TYPE_KEYWORDS = [
  "$ref",
  "type",
  "const",
  "enum",
  "properties",
  "additionalProperties",
  "items",
  "allOf",
  "anyOf",
  "oneOf"
];

function describesType(schema) {
  return TYPE_KEYWORDS.some((keyword) => Object.hasOwn(schema, keyword));
}

function describesObject(schema) {
  return schema.type === "object" || Object.hasOwn(schema, "properties");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const expected = await generateSchemaTypes();
  const relative = path.relative(process.cwd(), typesFile);
  if (process.argv.includes("--check")) {
    const current = await readFile(typesFile, "utf8").catch(() => "");
    if (current !== expected) {
      throw new Error(`${relative} does not match the schemas: run npm run build and commit it.`);
    }
    process.stdout.write(`Verified ${relative} against the schemas.\n`);
  } else {
    await writeFile(typesFile, expected);
    process.stdout.write(`Wrote ${relative} from the schemas.\n`);
  }
}
