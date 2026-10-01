# Changelog

All notable changes to Accessibility Evidence Engine are documented here. The project follows [Semantic Versioning](https://semver.org/) while its public APIs remain experimental.

## [Unreleased]

### Changed

- A Playwright test whose page another test already checked by keyboard and with the reader says "Checked in another test" in those rows, instead of "Not in this run". The fixture checks each page once per run, so on a real suite of 118 tests the PR comment read "Not in this run (111)", which looked like a gap though every page was checked. A test that did not pass, did not end on a web page, or has the checks off still reads "Not in this run", and its detail now says which. The report records why (`completeness.plannedChecks.skipped`), and a PR comment row lists results with the same verdict most common first.

## [0.4.0] - 2026-10-01

### Added

- The Playwright fixture checks pages by keyboard and with the virtual screen reader, not only with axe. Where a passing test ends on a web page that no other test of the run has ended on, the fixture sweeps that page by keyboard and mouse and reads it with the virtual screen reader. Both run on the test's own page, so they keep the test's sign-in, storage and mocked routes. Each page is checked once per run, and `test.use({ aee: { keyboardAndReader: false } })` turns the checks off. The sweep and reader lanes take a test's `page` as well as a `browser`, and their records say which (`isolation: "test-page"`).
- The Playwright fixture prints one line per test with its accessibility verdict and where the report is, such as `AEE: release blocked, 2 fixes needed. Report: test-results/…/aee/aee-report.html`. The test still passes or fails on its own assertions, so before this nothing in the terminal said a report existed.
- A scenario can have a `name`, and its report is called by it: the page title, the heading and the Markdown heading. Without one, all three use the id in words, as the heading already did.

### Fixed

- A Playwright fixture report is called exactly what its test is called. It used to rebuild the title from the test's id, dropping punctuation ("Home page shows today s pick").
- An element with no text or id, such as an image with no alt text, was listed as "Affected element 1". It is now called by what it is and, for an image, its file: "Image fern.jpg", or "Image 1" when the image is embedded data.
- The README's GitHub Action example used `@main` while the install steps used v0.3.0. It now uses `@v0.3.0`, and the package check fails when the README installs or pins any version other than the packages' own.
- The keyboard and pointer sweep's video shows the page throughout. It used to jump to a Tab stop's close-up, or the page shrunk, in a grey frame, and could end on a grey-edged frame: Chromium's recording shows what a clipped or full-page screenshot draws. Each Tab stop's close-up is now cut from a capture of the whole viewport, and the lane's full-page screenshot is taken in a second, unrecorded browser context.
- An AI suggestion from a local model could cite something other than its evidence, such as the element's selector, and so be discarded. Each request's schema now lists the only fields the answer may cite, and the local provider asks the runtime to enforce the schema (`response_format` json_schema) rather than only describing it in the prompt.

### Changed

- A virtual-reader command is captured once, after it ([#80](https://github.com/Elizabeth1979/accessibility-evidence-engine/issues/80)). The portable reader never changes the page, so its before capture was an identical copy: every command wrote its screenshots, DOM, accessibility tree and axe result twice. A run whose interaction only reads the page (`interactionReadsOnly`, in `runAeeOnPage` and the core's `executeRun`) is captured once, as a checkpoint is, and not waited on to settle. On the test lab every reader judgment is the same, word for word, and each command writes 9 files instead of 18. On albums-studio's suite the reader's evidence halves (112 to 58 MB) and the run takes 5.9 minutes instead of 6.6.
- The keyboard sweep's navigation guard passes every other request on with `route.fallback()`, so a test's own routes still answer them.
- The virtual reader's status row says "No confirmed issue" when every command passed, like the other rows, with the count in its detail ("All 6 commands passed: …"). A pull-request comment for a suite now groups those passes instead of listing one per count.
- The homepage tells one story, from finding a problem to shipping its fix, in four chapters of feature cards (Find, Show, Fix and Ship), with a real app's results and three steps to get started. Every claim on it links to a shot or a live page. The evidence flow, remediation registry, before-and-after examples and accessibility experiments moved to a new How it works page.

## [0.3.0] - 2026-09-30

### Added

- **Contrast measured from the screenshot** when axe cannot decide it: for text over a gradient, a background image or an image, AEE hides the text, captures what is behind it and compares the text's color with every pixel there. The check passes when every pixel gives the required ratio and fails when none does; a failure is a finding with the measured range and colors. Text whose pixels both pass and fail, or that has a shadow or outline, is left for a person, and the PR comment and report list each one with why.
- Four more **Page view** layers, off until switched on: **Headings**, indented by level with empty and skipped levels flagged; **Tab order**, each stop numbered in the order Tab reached it with the keyboard problems found on it; **Images and alt text**, flagging images with no text alternative; and **Focus indicator**, a close-up of each Tab stop with focus, flagged where it looks the same with and without it. Every checkpoint saves an element map (`element-map-after.json`) of its headings and images, and the keyboard sweep records each Tab stop's accessible name, box and close-up.
- **Copy as ticket** on every fix in the HTML report: a Markdown ticket with severity, WCAG criterion, rule, pattern, where, steps to reproduce, expected and actual, the suggested fix and any AI suggestion labelled as AI. Every run also writes `aee-fixes.csv`, one row per fix for an issue tracker's import, and the Playwright fixture attaches it to test results.
- A **Page view** tab in the HTML report: the page as tested, with every located issue and the virtual screen reader's path drawn where they were found, each numbered and listed beside it. Layers switch on and off, selecting an item moves the picture to it, and on a phone the picture stays pinned above the lists at a readable scale. From the QA and designer view spec (`docs/qa-designer-view.md`).
- `@aee/mcp`, an MCP server for coding agents: `explain` returns the a11y-skills pattern for an axe rule, an AEE finding or a UI element through the remediation registry, `findings` reads a run's fixes, and `run` runs an approved scenario. a11y-skills is now pinned in `@aee/mcp`, not the root package.
- `aee fix`: applies a reviewed name suggestion to an HTML, JavaScript, JSX or TSX file on its own branch in a git worktree, starts the app from there, reruns the same approved scenario, and passes each fix only when axe, the virtual reader and the reader's agreement with the accessibility tree and the rendered page all confirm it. It never merges or pushes.

### Fixed

- The keyboard sweep no longer reports the items of a tablist, menu, listbox, tree, grid, radio group or toolbar as mouse-only when that widget's arrow keys, Home or End reach them, as the APG patterns ask.
- The keyboard sweep's reset between checks reloads an address with a `#fragment`. It used to only scroll to the fragment, keeping whatever the previous check had changed.
- The keyboard sweep walks Tab from the top of the page when its address has a `#fragment`. It used to start at the fragment's target and report every control above it as mouse-only.
- The keyboard sweep no longer stops with "Execution context was destroyed" when a pressed control loads another page while the page is being read. It reads the page that loaded instead.
- On Playwright 1.50 to 1.56, a checkpoint recorded Playwright's simplified accessibility snapshot, which leaves out landmarks, instead of the browser's full accessibility tree, so the reader's agreement check failed on correct pages. Every checkpoint now reads the browser's tree.
- The keyboard sweep no longer stops on a page whose skip link waits above the top of the page until it has focus. It hovers only what a mouse can reach, where before it waited on the skip link until the whole sweep timed out.

### Changed

- AEE uses the project's Playwright: `@aee/cli` accepts `@playwright/test` from 1.50 as a peer and no longer depends on `playwright`, and `aee run` launches Chromium through `@playwright/test`, so installing AEE leaves a project's Playwright as it was. CI installs the packages into a project on Playwright 1.50.0 and runs the fixture and `aee run` there.
- A run with no interaction to perform, such as each test fixture checkpoint, captures the page once instead of before and after, and a checkpoint first waits until the page has stopped changing for 250 ms (at most 3 seconds). On a 130-test suite the time went from 4.6 to 3.4 minutes and the evidence from 419 to 239 MB, with every result the same.
- The pull-request comment for several tests is one summary: each status row with how many tests had each result, every distinct problem once with "seen in N tests" and their names, and the tests by outcome. An element failing a rule is one problem however many tests render it. On a 118-test suite the comment went from 57,858 characters, one block per test, to 7,139.
- A status row for a check the run does not include, such as the keyboard sweep and virtual reader under the Playwright test fixture, reads "Not in this run" instead of "Needs review". The integrated report records the checks its plan runs (`completeness.plannedChecks`) and the texts whose contrast is left for a person (`synthesis.undecidedContrast`).
- The keyboard sweep record (`keyboard-pointer-sweep.json`) is schema 0.2.0: each Tab stop is an object with its name, role, box, close-up and whether focus is visible, not a selector. The plan now lists the element map, so an approved scenario's plan digest changes and needs approving again.

### Security

- `fast-uri`, which `ajv` uses to validate schemas, is updated to 3.1.8 for two high-severity advisories (GHSA-qw65-cvwx-89v3, GHSA-58mr-gqgx-xq4g).
- `brace-expansion`, which the linting tools use (a development dependency, not shipped), is updated to 5.0.12 for three high-severity advisories (GHSA-q2hr-2g5m-vwhr, GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p).

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

[0.4.0]: https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/tag/v0.4.0
[0.3.0]: https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/tag/v0.3.0
[0.2.0]: https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/tag/v0.2.0
[0.1.0]: https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/tag/v0.1.0
[Unreleased]: https://github.com/Elizabeth1979/accessibility-evidence-engine/compare/v0.4.0...HEAD
