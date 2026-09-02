# Changelog

All notable changes to Accessibility Evidence Engine are documented here. The project follows [Semantic Versioning](https://semver.org/) while its public APIs remain experimental.

## [Unreleased]

### Added

- A reproducible axe → AI label proposal → AEE focus-management recording with published scanner output, paired AEE reports, screenshots, and a transcript.
- A focus-management judge that verifies explicit focus transfer into an opened dialog.
- `@aee/ai-fixes`, with an injectable contextual-label provider and an optional OpenAI Responses adapter using strict structured output.
- Deterministic-first AI review routing for semantic heading structure, icon-only labels, and decorative-versus-informative classification; routine findings cannot invoke the label provider.
- A slower public recording with explicit before, fix, and after states for the modal-focus repair.
- A three-image heading-structure demonstration with a real passing axe artifact and a separate, reviewed full-page outline proposal.

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
