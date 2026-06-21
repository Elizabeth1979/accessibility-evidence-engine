# Accessibility Evidence Engine

The Accessibility Evidence Engine (AEE) is an evidence-first framework for accessibility investigations around Playwright flows. This repository starts with architecture-approved scaffolding rather than production behavior.

## What is scaffolded

- A TypeScript workspaces layout for the core engine and extension points
- Core interfaces for runs, checkpoints, interactions, evidence, judgments, and plugins
- JSON Schema placeholders for machine-readable artifacts
- Architecture notes for lifecycle and dependency boundaries

## Package layout

- `packages/core`: shared contracts and engine orchestration types
- `packages/schemas`: JSON Schema files and schema catalog metadata
- `packages/playwright`: Playwright adapter contracts
- `packages/observers`: observer manifests and noop factories
- `packages/judges`: judge manifests and default pipeline helpers
- `packages/reporter`: reporting contracts and baseline reporters
- `packages/cli`: CLI-facing configuration and bootstrap contracts

## Current status

This is still intentionally a foundation-first codebase, but it now includes a verified vertical slice:

- The fixture runner builds and executes end to end
- DOM and accessibility-tree observers can capture artifacts from a virtual or real page-like object
- Focus evidence can be captured around a real keyboard interaction
- Screenshot evidence can be captured around a real page interaction
- Network evidence can be captured around a real page interaction
- CLI inputs and emitted JSON outputs are schema-validated at runtime
- Keyboard judging now checks focus direction, not just whether focus changed
- Markdown reports now summarize observer coverage, bundle correlation, and artifact inventories
- Release judgments now enforce policy thresholds against emitted accessibility failures
- Judges and reporters can turn that evidence into a first pass/fail report bundle

## Runnable slice

The repository now includes a first runnable vertical slice backed by a fixture file:

1. Install dependencies with `npm install`
2. Build with `npm run build`
3. Run with `npm run run:fixture`

That flow reads [examples/basic-run-config.json](/Users/elizabeth/accessibility-evidence-engine/examples/basic-run-config.json), loads [examples/basic-fixture.json](/Users/elizabeth/accessibility-evidence-engine/examples/basic-fixture.json), captures DOM and accessibility-tree evidence, and writes reports into `aee-output/<run-id>/`.

## Playwright path

The repo also exposes `runAeeOnPage(...)` from `@aee/playwright` so a real Playwright `page` can reuse the same observer, judge, and reporter pipeline.

To run the real-page smoke test from a fresh machine:

1. Install dependencies with `npm install`
2. Install the Chromium test browser with `npm run playwright:install`
3. Run the schema and CLI unit tests with `npm run test:unit`
4. Run the smoke test with `npm run test:playwright`

- Integration notes: [docs/playwright-integration.md](/Users/elizabeth/accessibility-evidence-engine/docs/playwright-integration.md)
- Architecture notes: [docs/architecture.md](/Users/elizabeth/accessibility-evidence-engine/docs/architecture.md)
- Observer lifecycle: [docs/observer-lifecycle.md](/Users/elizabeth/accessibility-evidence-engine/docs/observer-lifecycle.md)

## Next implementation steps

1. Add richer network analysis, such as filtering noise and correlating requests to interactions.
2. Expand schema coverage further if we add new artifact kinds or richer report sections.
3. Add keyboard-activation and composite-widget judging beyond plain tab order.
4. Add richer change-response judging once more interaction observers are available.
5. Let Playwright flows opt into stricter capture policies beyond the current defaults.
