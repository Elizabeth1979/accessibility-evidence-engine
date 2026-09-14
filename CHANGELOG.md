# Changelog

All notable changes to Accessibility Evidence Engine are documented here. The project follows [Semantic Versioning](https://semver.org/) while its public APIs remain experimental.

## [Unreleased]

### Added

- A learner-controlled before-and-after slideshow for icon naming, heading structure, and modal focus, backed by published scanner output and paired AEE reports.
- A focus-management judge that verifies explicit focus transfer into an opened dialog.
- `@aee/ai-fixes`, with an injectable contextual-label provider and an optional OpenAI Responses adapter using strict structured output.
- Deterministic-first AI review routing for semantic heading structure, icon-only labels, and decorative-versus-informative classification; routine findings cannot invoke the label provider.
- Static contextual-review images, including a real passing axe heading artifact and a separate reviewed full-page outline proposal.
- Human-readable evidence summaries on the public demo, with machine-readable artifacts offered as explicit downloads instead of raw browser pages.
- Reusable probes for pointer-versus-keyboard outcome equivalence and motion-control verification across stable post-action samples.
- Deterministic palette-aware contrast proposals using measured contrast and OKLab distance between supplied design tokens.
- Three generated public examples backed by those APIs: palette contrast, hover accessibility, and animation stopping.
- User-authored pointer and keyboard journey comparisons with separate contexts sharing seeded browser storage and a verified landing URL, per-action synchronized evidence capture, deterministic expected-outcome and equivalence verdicts, and schema-validated interaction traces.
- A safe Melio homepage comparison that exercises only the declared hover and focus actions while preserving Axe failures separately from interaction equivalence.
- Schema-validated evidence manifests for pointer, keyboard, and portable-reader lanes, with relative paths, SHA-256 integrity, required-file completeness, action provenance, failure manifests, and privacy-conservative defaults.
- Per-lane Playwright WebM recordings with schema-validated JSON action timelines, WebVTT captions, deterministic filenames, failure-state metadata, and manifest integrity coverage.

## [0.1.0] - 2026-08-30

### Added

- Evidence collection around Playwright interactions for DOM, accessibility-tree, focus, screenshot, and network state.
- Keyboard, change-response, structure-evidence, and release-policy judges.
- JSON Schema validation, JSON and Markdown reports, a fixture CLI, and seven installable workspace packages.
- Privacy redaction for captured network data, including custom adapters.
- Public documentation, contribution guidance, security reporting, continuous integration, package verification, linting, formatting, coverage thresholds, CodeQL, and Dependabot configuration.
- An accessible public demonstration deployed with GitHub Pages.

### Security

- Network event fields are reconstructed from validated primitive types before persistence.
- Caller-provided run identifiers are restricted so they cannot escape the configured output directory.
- Nested CLI policy values are validated before execution.

[0.1.0]: https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/tag/v0.1.0
[Unreleased]: https://github.com/Elizabeth1979/accessibility-evidence-engine/compare/v0.1.0...HEAD
