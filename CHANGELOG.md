# Changelog

All notable changes to Accessibility Evidence Engine are documented here. The project follows [Semantic Versioning](https://semver.org/) while its public APIs remain experimental.

## [Unreleased]

### Added

- **Copy as ticket** on every fix in the HTML report: a Markdown ticket with severity, WCAG criterion, rule, pattern, where, steps to reproduce, expected and actual, the suggested fix and any AI suggestion labelled as AI. Every run also writes `aee-fixes.csv`, one row per fix for an issue tracker's import, and the Playwright fixture attaches it to test results.
- A **Page view** tab in the HTML report: the page as tested, with every located issue and the virtual screen reader's path drawn where they were found, each numbered and listed beside it. Layers switch on and off, selecting an item moves the picture to it, and on a phone the picture stays pinned above the lists at a readable scale. From the QA and designer view spec (`docs/qa-designer-view.md`).
- `@aee/mcp`, an MCP server for coding agents: `explain` returns the a11y-skills pattern for an axe rule, an AEE finding or a UI element through the remediation registry, `findings` reads a run's fixes, and `run` runs an approved scenario. a11y-skills is now pinned in `@aee/mcp`, not the root package.
- `aee fix`: applies a reviewed name suggestion to an HTML, JavaScript, JSX or TSX file on its own branch in a git worktree, starts the app from there, reruns the same approved scenario, and passes each fix only when axe, the virtual reader and the reader's agreement with the accessibility tree and the rendered page all confirm it. It never merges or pushes.

## [0.2.0] - 2026-09-28

### Added

- Installation from GitHub: each release carries the eight package tarballs, and a Release workflow publishes them after checking they install into a fresh project.
- A GitHub Action (`action.yml`) that runs an approved scenario or a Playwright test command and keeps one comment on the pull request with every fix, its pattern and any AI suggestion, failing the job only as `fail-on` says. With `ai-provider: local` it starts a free model on the runner.
- `@aee/cli/test`: an existing Playwright spec gets AEE by changing its import. Every page load the test starts is checkpointed and the test gets the same report and pull-request comment as `aee run`.
- `aee comment`, and `aee-pr-comment.md` in every run: blocking fixes first, then advisory results, then AI suggestions labelled as AI.
- Allowlisted AI specialists that suggest names for icon-only controls and alternatives for images from captured evidence only, through Claude, a local model, OpenAI or none, always labelled as AI and never passing or failing anything.
- Pattern links from every finding to the matching a11y-skills pattern, through the remediation registry.
- A keyboard and pointer sweep that tabs to every stop, presses what a mouse can click, compares hover with focus and flags text that looks like a heading without being one.
- A virtual screen reader that reads roles and names from the browser's accessibility tree.
- An inline keyboard-journey player in the status overview, with the captured focus-state poster,
  authored action list, WebVTT descriptions, timed JSON, and recording download.
- An accessible evidence-image lightbox that enlarges the exact displayed crop and issue marker,
  while keeping the underlying complete page capture as a separate, explicitly labeled link.
- Grouped remediation counts that separate shared component or token fixes from every affected page
  location, with complete expandable instance lists and semantic evidence for defects that cannot be
  identified honestly in a screenshot.
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
- A safe public homepage comparison that exercises only the declared hover and focus actions while preserving Axe failures separately from interaction equivalence.
- Schema-validated evidence manifests for pointer, keyboard, and portable-reader lanes, with relative paths, SHA-256 integrity, required-file completeness, action provenance, failure manifests, and privacy-conservative defaults.
- Per-lane Playwright WebM recordings with schema-validated JSON action timelines, WebVTT captions, deterministic filenames, failure-state metadata, and manifest integrity coverage.
- Schema-validated deep focus evidence spanning document and deepest active elements, shadow-root and same-origin iframe chains, focus-visible styles, `aria-activedescendant`, and browser accessibility focus, plus explicit preserve/target/dialog focus judgments.
- Approved YAML scenario execution for real pages, with `--open`, strict `--ci`, and configurable output-directory behavior.
- Integrated HTML, JSON, and Markdown scenario reports that combine action verdicts, consolidated findings, screenshots, videos, virtual-reader transcripts, Axe results, raw evidence links, privacy state, and an explicit AI-output label.
- A scenario-level manifest that validates child manifests and re-hashes all indexed evidence with action provenance and completeness kept separate from the accessibility verdict.
- Deterministic portable-reader cross-evidence judgments that require focus separation, same-checkpoint DOM/AOM role-name-level agreement, non-zero rendered bounds, and full-page visual evidence; missing inputs remain unknown and semantic contradictions fail.
- A deterministic role-aware keyboard matrix for user-authored actions, including activation-key filtering, orientation-aware composite navigation, Home/End endpoints, automatic keyboard judging in isolated input lanes, and explicit `unknown` results for unsupported or context-dependent combinations.
- An accessible, editorial evidence-dossier HTML review surface with a transparent overall scorecard, readable action names, keyboard-operable tabs, consolidated and per-checkpoint Axe summaries, transcripts, media, categorized evidence files, progressive enhancement, print styling, and secondary raw JSON links.
- Deterministic cross-evidence synthesis in the integrated JSON, Markdown, and HTML reports, including lane-level direct judgments, pointer/keyboard equivalence, structured virtual-reader results, unique-versus-repeated findings, incomplete Axe checks, same-checkpoint DOM/accessibility-tree/focus/visual links, remediation boundaries, and verified rerun instructions.
- An interactive accessibility triage report that leads with scoped page health, prioritized remediation and effort, filterable current-versus-proposed visual reviews, journey videos, and local evidence-grounded questions while moving raw technical detail into an annex.

### Fixed

- The integrated report's keyboard focus ring now meets WCAG 2.2 SC 1.4.11 (3:1) on every report
  background: `--focus` moves from `#f6b73c` (1.50–1.79:1 on the light surfaces) to `#b86e00`
  (3.34:1 or more). The screenshot issue marker keeps the bright gold through its own `--marker` token.

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

[0.2.0]: https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/tag/v0.2.0
[0.1.0]: https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/tag/v0.1.0
[Unreleased]: https://github.com/Elizabeth1979/accessibility-evidence-engine/compare/v0.2.0...HEAD
