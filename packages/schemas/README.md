# `@aee/schemas`

JSON Schemas and runtime validation for [Accessibility Evidence Engine](https://github.com/Elizabeth1979/accessibility-evidence-engine) configurations and artifacts.

Schema JSON files are exposed through `@aee/schemas/json/*` in addition to the main runtime validation API.

Every document a schema checks has a TypeScript type, generated from the schema itself with `json-schema-to-typescript` (`src/schema-types.ts`), so the types and the files cannot disagree. `assertValidSchema(name, value)` narrows `value` to its schema's type, and `SchemaDocuments` maps each schema's name to it. The types say what a document always has; a schema's conditions (`if`/`then`), exclusions, patterns and item counts are checked at run time only.

`interaction-comparison-request.schema.json` validates user-authored pointer and keyboard paths. `interaction-comparison.schema.json` validates the resulting per-action trace and keeps lane equivalence separate from each action's accessibility release verdict.

`evidence-manifest.schema.json` validates the checksummed inventory, including artifact availability, provenance, lifecycle, and privacy handling.

`interaction-video.schema.json` validates the lane recording sidecar, action timing, caption linkage, execution status, and conservative privacy state.

`focus-state.schema.json` validates document and deepest active elements, shadow/iframe focus chains, focus-indicator metadata, `aria-activedescendant`, and accessibility-tree focus. Portable-reader items may also include document-relative rendered bounds used to correlate the semantic target with full-page visual evidence.

`axe-result.schema.json` validates the axe-core 4.14 result AEE writes at a checkpoint: the axe fields AEE reads, with axe's own types and optionality, and AEE's additions to it (each violation's place on the screenshot and the page around it, its contrast measurement, and the frames left out). axe's other fields are kept as axe wrote them and not checked.

`scenario-report.schema.json` validates the integrated report's separate verdict and evidence-completeness states, action summaries, raw evidence index, privacy boundary, and explicit AI-output label.

See the [project README](https://github.com/Elizabeth1979/accessibility-evidence-engine#readme) for status, usage, and limitations.
