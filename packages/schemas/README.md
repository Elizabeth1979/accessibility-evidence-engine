# `@aee/schemas`

JSON Schemas and runtime validation for [Accessibility Evidence Engine](https://github.com/Elizabeth1979/accessibility-evidence-engine) configurations and artifacts.

Schema JSON files are exposed through `@aee/schemas/json/*` in addition to the main runtime validation API.

`interaction-comparison-request.schema.json` validates user-authored pointer and keyboard paths. `interaction-comparison.schema.json` validates the resulting per-action trace and keeps lane equivalence separate from each action's accessibility release verdict.

`evidence-manifest.schema.json` validates the checksummed inventory, including artifact availability, provenance, lifecycle, and privacy handling.

`interaction-video.schema.json` validates the lane recording sidecar, action timing, caption linkage, execution status, and conservative privacy state.

See the [project README](https://github.com/Elizabeth1979/accessibility-evidence-engine#readme) for status, usage, and limitations.
