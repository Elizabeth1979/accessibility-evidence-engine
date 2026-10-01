# Accessibility Evidence Engine

Accessibility Evidence Engine (AEE) is an experimental, evidence-first framework for investigating accessibility behavior around Playwright interactions. It captures page state before and after an action, correlates the evidence, runs focused judges, and produces JSON and Markdown reports for review or release-policy decisions.

> [!IMPORTANT]
> AEE is an early public-preview project, not a complete WCAG conformance scanner. A passing AEE report means that the selected judges passed with the evidence captured for that interaction; it does not certify that a page or product is accessible.

Explore the [public interactive demonstration](https://elizabeth1979.github.io/accessibility-evidence-engine/) or continue below to run AEE locally.

## Why AEE

Many automated checks report a rule result without preserving enough context to explain what happened during an interaction. AEE keeps evidence collection, correlation, judgment, and reporting separate so a result can be traced back to the captured DOM, accessibility tree, focus state, screenshot, or network activity.

AEE complements rule engines such as axe rather than replacing them. Static rules are excellent at objective defects such as an icon button without an accessible name. AEE adds value only when remediation depends on meaning: a deterministic router can escalate full-page heading structure, icon-only naming, and an image's purpose and text alternative for contextual review. Routine failures never call a model. The interaction pipeline separately verifies stateful behavior such as whether focus actually enters an opened modal.

This comparison does not claim that axe cannot be scripted around interactions. Its own API guidance recommends activating hidden UI before analyzing it. The distinction is that AEE normalizes the interaction boundary, before/after artifacts, explicit behavioral expectation, judgment, and release decision into one traceable report. See axe's [`button-name` rule](https://dequeuniversity.com/rules/axe/4.13/button-name), [axe API notes](https://github.com/dequelabs/axe-core/blob/develop/doc/API.md), and the W3C [modal-dialog focus pattern](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/).

## How it works

For each interaction, AEE:

1. Creates a run, checkpoint, and interaction record.
2. Sets up the selected observers.
3. Captures before-state evidence.
4. Performs the interaction and waits for the configured stabilization delay.
5. Captures after-state evidence.
6. Correlates the evidence into a normalized bundle.
7. Runs the selected judges and release policy.
8. Writes JSON, Markdown, and optional raw artifacts.

See [Architecture](docs/architecture.md) and [Observer lifecycle](docs/observer-lifecycle.md) for the detailed model.

## Quick start

AEE supports maintained Node.js releases beginning with Node 22. Node 24 LTS is the recommended development version and is recorded in `.nvmrc`.

Clone the repository, then install and build it:

```bash
npm ci
npm run build
```

Run the bundled fixture:

```bash
npm run run:fixture
```

The command reads [the example config](examples/basic-run-config.json) and [fixture](examples/basic-fixture.json), then writes a report to `aee-output/<run-id>/aee-report.md` alongside its JSON output and captured artifacts.

Plan a user-controlled assessment of a public page without executing it:

```bash
npm run plan:public-site
```

The [public site scenario](examples/public-site/scenario.yml) owns the goal, WCAG scope, safe actions,
prohibited account and payment actions, privacy settings, and approval requirement. AEE expands it
into a deterministic test plan and reports whether every capability required by the selected
profile is implemented. A blocked or partial plan cannot become an overall pass.

After reviewing and approving that exact plan digest in the scenario, run its declared actions and
write one integrated HTML, JSON, and Markdown report:

```bash
node packages/cli/dist/index.js run examples/public-site/scenario.yml --output aee-output/scenarios
```

The integrated report opens as an accessibility triage room: it explains the scoped page status,
preserves successful keyboard and virtual-reader behavior, groups repeated failures by the shared
component or token that needs one fix, and gives a focused effort estimate. Each grouped fix states
how many affected page locations it covers and provides an expandable list of every distinct element
found at the largest checkpoint. Semantic defects use DOM evidence instead of pretending they are
visible in a screenshot; visual defects pair page context with named targets and measurements.
“Ask this report” answers common status, priority, effort, and evidence questions locally
without uploading captured data. Detailed DOM, accessibility-tree, focus, Axe, and raw-file views live
in the technical annex. Deterministic remediation leads. When you name a model with
`AEE_LLM_PROVIDER` (`local` for one on your machine, or `claude`), the registry's allowlisted
specialists suggest a name for each icon-only control and a text alternative for each image
without one, say what a colour-only difference seems to mean, and read the words in an image of
text. Each gets the page context captured with the finding and the element as the screenshot
shows it. Each suggestion is labelled AI, needs review, and never passes or fails anything. With
no model named, nothing is sent and the report says how to turn it on.

Which model is worth it: `npm run score:ai` scores each model's names for the test lab's nameless
elements against the names the fixed page gives them (the share of words in common), and the
AI score workflow runs it on a GitHub runner. The free local model (`gemma4:e4b`, no key, nothing
leaves the machine) scored 48% and 50% in two runs, at about a minute per answer. It is worth it
for icon buttons and links: "Archive project" and "Get help" name the right action, though not
which project or topic. It is not worth it for image alt text: one run described the chart well,
the other pasted the text beside it. Read the answers, not only the number: word match cannot tell
an alt text that is right in other words from a wrong one, so the good chart description scored
21% and the pasted text 15%. Claude has not been scored yet; add an `ANTHROPIC_API_KEY` secret and
run the AI score workflow, and its score prints beside the free model's. Three names make a sanity
check, not a benchmark.

Add `--open` to open the HTML report, or `--ci` to return a nonzero status for a failed, unknown, or
incomplete result. The runner executes only the virtual-reader commands and pointer/keyboard
comparisons authored in the YAML; allowed actions remain permissions rather than inferred steps.

Once a person has reviewed a suggested name, `aee fix` applies it and proves it:

```bash
node packages/cli/dist/index.js fix scenario.yml aee-output/<assessment> \
  --accept "#close-dialog" --source src/Dialog.tsx --start "npm run dev"
```

It sets the suggested name, or the one given as `--accept "#close-dialog=<name>"`, on the element with
that id in the source file (HTML, JavaScript, JSX or TSX, tracked in git) and commits it on a new
branch, `aee/fix-<assessment>`, in a separate git worktree, so your working copy is never touched.
It then runs `--start` in that worktree, reruns the same approved scenario against it, and passes a
fix only when the rerun confirms it three ways: axe no longer reports the element, the virtual reader
announces the new name, and that announcement agrees with the accessibility tree and the rendered
page. A change it cannot place safely, such as a name built from an expression, is left to a person
with the exact change to make. It never merges or pushes: the branch is yours to review.

Run the automated checks:

```bash
npm run format:check
npm run lint
npm run test:coverage
npm run test:unit
npm run playwright:install
npm run test:playwright
```

`aee-output/`, `test-results/`, and `playwright-report/` are intentionally ignored by Git.

## Install from GitHub

The packages are not on npm yet. Each [release](https://github.com/Elizabeth1979/accessibility-evidence-engine/releases) carries every package as a tarball. Install them together from one release, since each package depends on the others at exactly that version:

```bash
npm install --save-dev \
  https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/download/v0.5.0/aee-ai-fixes-0.5.0.tgz \
  https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/download/v0.5.0/aee-cli-0.5.0.tgz \
  https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/download/v0.5.0/aee-core-0.5.0.tgz \
  https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/download/v0.5.0/aee-judges-0.5.0.tgz \
  https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/download/v0.5.0/aee-observers-0.5.0.tgz \
  https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/download/v0.5.0/aee-playwright-0.5.0.tgz \
  https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/download/v0.5.0/aee-reporter-0.5.0.tgz \
  https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/download/v0.5.0/aee-schemas-0.5.0.tgz
```

AEE uses your project's Playwright, 1.50 or later, so installing it leaves your `@playwright/test` as it is.

For the coding-agent server below, add `https://github.com/Elizabeth1979/accessibility-evidence-engine/releases/download/v0.5.0/aee-mcp-0.5.0.tgz` to the same command.

Use the Action at the same version: `uses: Elizabeth1979/accessibility-evidence-engine@v0.5.0`. A maintainer cuts a release by running the Release workflow, which checks the tarballs install into a fresh project first; the version is the one in the packages' `package.json` files, and a version that is already tagged is never reused.

## Coding agents (MCP)

`@aee/mcp` is an MCP server for coding agents. Its `explain` tool answers "explain button-name" (or `pointer-only`, `dialog-modal`, "icon button") with the [a11y-skills](https://github.com/Elizabeth1979/a11y-skills) pattern the reports link to, at the same pinned commit: the rules with good and bad examples, a complete example, the WCAG criteria and a checklist. `findings` reads a folder of AEE assessments and returns their fixes as the pull-request comment lists them, and `run` runs a scenario a person has approved. It cannot apply a fix; `aee fix` does that after review. Once it is [installed](#install-from-github), add it to Claude Code from the project:

```bash
claude mcp add aee -- npx aee-mcp
```

Other agents take the same command in their MCP settings: `{"command": "npx", "args": ["aee-mcp"]}`. The server tells the agent to answer from the pattern rather than from memory.

## Playwright integration

`runAeeOnPage(...)` brackets a real Playwright action with the same observer, judge, and reporting pipeline:

```ts
import { test } from "@playwright/test";
import { runAeeOnPage } from "@aee/playwright";

test("collect keyboard evidence", async ({ page }) => {
  await page.setContent(`
    <button id="save" type="button"
      onclick="document.querySelector('#status').textContent = 'Saved'">
      Save
    </button>
    <p id="status">Idle</p>
  `);
  await page.focus("#save");

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: "aee-output",
    observers: ["focus", "dom"],
    judges: ["keyboard", "release"],
    interaction: {
      kind: "enter",
      actor: "test",
      target: { role: "button", name: "Save" }
    },
    async performInteraction({ page }) {
      await page.keyboard.press("Enter");
    }
  });

  console.log(result.reporterFiles);
});
```

An existing spec gets the same checks by changing one import, `@playwright/test` to `@aee/cli/test`: every page load it starts is checkpointed, each web page a passing test ends on is also swept by keyboard and mouse and read with the virtual screen reader, once per run and on the test's own page so it keeps the test's sign-in and mocks, and the test gets the full report and PR comment. See [the drop-in test fixture](docs/playwright-integration.md#drop-in-test-fixture).

The `@aee/*` packages are not on a package registry yet; [install them from GitHub](#install-from-github). See [Playwright integration](docs/playwright-integration.md) for focus, composite-widget, screenshot, network, and capture-policy examples.

## GitHub Action

The Action runs a scenario or a test command and keeps one comment on the pull request: the verdict, the status rows and each fix with its pattern. A later run updates that comment instead of adding another.

```yaml
permissions:
  contents: read
  pull-requests: write

jobs:
  accessibility:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: Elizabeth1979/accessibility-evidence-engine@v0.5.0
        with:
          run: accessibility/scenario.yml # your approved scenario, or a test command such as npx playwright test
          fail-on: blocking # or incomplete, or never
```

`ai-provider` defaults to `stub`, so no page evidence leaves the runner. `local` starts a free model on the runner itself (Linux x64; Ollama with `gemma4:e4b` unless the step's `env` sets `AEE_LLM_MODEL`): no key, and the evidence stays on the runner. It takes about a minute to start, then up to two minutes per answer on the runner's CPU. `claude` or `openai` read their key from the step's `env`. The reports are kept as the run's `aee-reports` artifact, and the comment is also written to the job summary, for pull requests from forks, whose token cannot post. `aee comment <folder>... --post --fail-on blocking` is the same step from the command line. This repository runs the Action on every pull request against the test lab's fixed page (`.github/workflows/accessibility.yml`, with `fail-on: incomplete` and the local model, or Claude once an `ANTHROPIC_API_KEY` secret exists), so a change that breaks the page turns CI red and says why in the comment.

To see each problem in the comment, not only read about it, set `images: true` and give the job `contents: write`. Each problem then shows a picture of the page around its element, outlined, cut from the test's own screenshot. The pictures are committed to an `aee-images` branch of the repository, apart from its code, so anyone who can read the repository can see them; that is why it is off by default. A pull request from a fork, whose token cannot write, gets the comment without pictures.

### Before-and-after examples

The [How it works page](https://elizabeth1979.github.io/accessibility-evidence-engine/how-it-works.html#examples) has a learner-controlled slideshow with six focused comparisons: an icon-only label, a heading hierarchy that passes axe's selected automatic rules, modal focus management, palette-aware contrast repair, hover-versus-keyboard equivalence, and animation stopping. Each slide shows one Before and one After image. Nothing autoplays, and detailed artifacts stay collapsed until requested.

Rebuild the axe and AEE evidence plus the public images locally with:

```bash
npm run demo:record
```

### Product shots and videos

`npm run site:shots` runs the engine on the test lab's demo page and saves, in `site/shots/`, one highlighted crop of the report per feature, two videos with text versions (the keyboard sweep's own recording, and a screen reader reading the page with screen-reader-cli `audit --record`) and the run's full report as a sample. The Pages deploy regenerates them from the current code, so no shot is hand-made or stale; CI runs the same command.

The homepage tells one story, from finding a problem to shipping the fix, in four chapters: Find, Show, Fix and Ship. Its feature cards come from `site/features.json`, the one list of the chapters and of what each feature is called, which chapter it sits in, what its shot shows and what its caption says; the shots are cropped from the same file. Its "what's next" section lists the master-plan milestones that still have open steps, marked "In progress" once one is done, and goes once none is left. `npm run site:generate` rebuilds them and `npm run site:check` (in CI) fails when they drift, so a change to a feature or to the plan updates its card in the same PR. The evidence flow, the remediation registry, the before-and-after examples and the accessibility experiments are on `site/how-it-works.html`.

## Current capabilities

| Area                    | Implemented                                                                       | Current scope                                                                                                                                                                                                                                                                                                                           |
| ----------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Observers               | DOM, accessibility tree, focus, viewport/full-page screenshots, axe 4.13, network | Before/after capture with raw artifacts; DOM and network change summaries                                                                                                                                                                                                                                                               |
| axe judge               | WCAG 2.0/2.1/2.2 A/AA result gating                                               | Fails violations and preserves incomplete checks as unresolved review work; contrast axe cannot measure over a gradient or image is first measured from the screenshot; best-practice results are reported as advisory and never block                                                                                                  |
| Portable virtual reader | Guide-mode semantic navigation and JSON/TXT transcripts                           | Keeps its virtual cursor separate from DOM focus; explicitly not VoiceOver or NVDA fidelity                                                                                                                                                                                                                                             |
| Screen-reader judge     | Focus separation plus DOM/AOM/rendered-presence agreement                         | Matches role, name, and heading level and requires rendered bounds plus a full-page screenshot; pixel meaning remains review work                                                                                                                                                                                                       |
| Keyboard judge          | Tab, shift-tab, role-aware enter/space, composite arrows/Home/End                 | Evaluates user-authored keys against a bounded role/orientation matrix, deep focus, `aria-activedescendant`, and observable activation                                                                                                                                                                                                  |
| Focus-management judge  | Modal opening                                                                     | Verifies an explicit `inside-dialog` focus expectation using before/after focus evidence                                                                                                                                                                                                                                                |
| Change-response judge   | Click, enter, space, submit                                                       | Detects observable DOM, focus, or network outcomes                                                                                                                                                                                                                                                                                      |
| Structure judge         | Evidence completeness                                                             | Confirms successful DOM and accessibility-tree capture; it does not yet evaluate individual structure rules                                                                                                                                                                                                                             |
| Release judge           | Policy gate                                                                       | Applies severity, confidence, and unknown-result policy to prior judgments                                                                                                                                                                                                                                                              |
| Validation              | JSON Schema and YAML scenario planning                                            | Validates fixture config, user-controlled scenarios, compiled plans, and emitted evidence payloads                                                                                                                                                                                                                                      |
| Reporting               | Interactive HTML triage room plus canonical JSON and Markdown                     | Leads with scoped status, a Page view drawing each issue and the screen reader's path on the page as tested, with headings, Tab order, alt text and focus on request, visual before/proposed-fix review with each fix copyable as a ticket and all fixes as `aee-fixes.csv`, effort, and local evidence Q&A; raw files stay in an annex |
| Evidence manifest       | Relative paths, SHA-256 integrity, provenance, execution status, and privacy      | Re-hashes child-lane evidence into one scenario manifest; omissions make the manifest partial                                                                                                                                                                                                                                           |
| Interaction video       | WebM, JSON action timeline, and WebVTT captions                                   | Records each active lane, labels action timing, and indexes all three privacy-sensitive files in the manifest                                                                                                                                                                                                                           |
| Deep focus state        | Document/deep active element, shadow/iframe chain, focus-visible styles, AX focus | Preserves synchronized focus evidence and deterministically checks explicit preserve, target, and dialog-transfer expectations                                                                                                                                                                                                          |
| AI review routing       | Headings, icon labels, image purpose                                              | Deterministic allowlist escalates only meaning-dependent cases; routine failures never call a model                                                                                                                                                                                                                                     |
| AI fix proposals        | Contextual accessible names and image alternatives                                | Registry-allowlisted specialists answer from captured evidence; output is always review-only and requires a verified rerun                                                                                                                                                                                                              |
| Verified fixes          | `aee fix` on HTML, JavaScript, JSX and TSX                                        | Applies an accepted name on its own branch in a git worktree, reruns the approved scenario, and passes it only on axe, reader and cross-evidence agreement                                                                                                                                                                              |
| Coding-agent server     | `@aee/mcp` over stdio: `explain`, `findings`, `run`                               | Explains a rule, finding or UI element with its pinned a11y-skills pattern through the registry; reads and runs approved assessments; never applies a fix                                                                                                                                                                               |
| Palette contrast        | Existing-token selection                                                          | Selects the perceptually closest supplied palette color that clears a requested contrast ratio                                                                                                                                                                                                                                          |
| Interaction probes      | Isolated pointer/keyboard journeys, hover equivalence, motion stopping            | Runs only user-declared actions from matching seeded storage and landing URL, recaptures each action, and saves a validated trace                                                                                                                                                                                                       |

The Guidepup observer plus the interaction and standalone visual judges remain unsupported or unknown extension points. The portable virtual-reader lane deterministically checks same-checkpoint DOM/AOM semantic agreement and rendered visual presence, but it does not infer pixel meaning. Virtual-reader evidence must not be presented as VoiceOver or NVDA output.

## Package layout

| Package           | Responsibility                                                           |
| ----------------- | ------------------------------------------------------------------------ |
| `@aee/core`       | Domain types, policies, orchestration, correlation, and plugin contracts |
| `@aee/ai-fixes`   | Review-only contextual accessible-name proposals and model adapters      |
| `@aee/schemas`    | JSON Schemas and runtime validation                                      |
| `@aee/playwright` | Real and virtual page adapters plus `runAeeOnPage(...)`                  |
| `@aee/observers`  | Built-in evidence observers and observer manifests                       |
| `@aee/judges`     | Built-in judges, release gating, and judge manifests                     |
| `@aee/reporter`   | JSON and Markdown reporters                                              |
| `@aee/cli`        | Approved YAML scenario execution, verified fixes, and legacy fixtures    |
| `@aee/mcp`        | MCP server: explain a rule with its a11y-skills pattern, read and run    |

## Evidence privacy

Treat generated evidence as potentially sensitive. Network artifacts redact credentials, fragments, query values, header values, and request bodies before writing, including data from custom network adapters. DOM snapshots, accessibility trees, focus metadata, screenshots, target descriptions, report paths, and URL paths can still contain private information.

Review artifacts before sharing them and use test accounts and non-production environments wherever possible. See [Evidence privacy](docs/privacy.md) for the full handling guidance.

## Known limitations

- The YAML CLI executes only explicitly authored virtual-reader commands and pointer/keyboard comparisons; it does not infer broad page coverage from action permissions.
- The keyboard matrix judges only keys the scenario author explicitly requests. Unsupported or context-dependent role/key combinations remain `unknown`; they do not become accessibility failures or claims of keyboard coverage.
- A complete Core evidence run is still a bounded scenario result, not a full WCAG conformance claim for the target site.
- `runAeeOnPage(...)` evaluates one interaction bundle per call; lane runners compose those calls into per-action journeys.
- Stabilization is currently a fixed post-interaction delay, not network-idle, animation, or mutation detection.
- Observer timeout and continue-on-error policy fields exist, but engine-level enforcement is not implemented yet.
- Several declared observers and judges remain extension scaffolds, as listed above.
- Public npm packaging and a hosted engine runner are not available yet; the public site is a static demonstration with generated evidence artifacts.
- AI proposals are never applied on their own and are not evidence of correctness. `aee fix` applies only names a person accepts, and a fix counts only when the rerun verifies it.
- `aee fix` finds an element by its `#id` in one source file, and reruns a YAML scenario; checks made through the Playwright fixture are not rerun by it yet.

## Roadmap

See the [live roadmap](https://elizabeth1979.github.io/accessibility-evidence-engine/roadmap.html). It is generated from [the master plan](docs/MASTER-PLAN.md) on every deploy.

## Documentation

- [Architecture](docs/architecture.md)
- [Target evidence pipeline and artifact layout](docs/evidence-run-layout.md)
- [Master plan](docs/MASTER-PLAN.md)
- [Implementation roadmap](docs/implementation-roadmap.md)
- [Detection, analysis, and remediation registry](packages/schemas/json/remediation-registry.json)
- [Observer lifecycle](docs/observer-lifecycle.md)
- [Playwright integration](docs/playwright-integration.md)
- [Evidence privacy](docs/privacy.md)
- [AI fix proposals](docs/ai-fixes.md)
- [QA and designer view (design spec)](docs/qa-designer-view.md)
- [Architecture decision records](docs/adr/README.md)

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before participating. Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md), never through a public issue.

## License

Licensed under the [Apache License 2.0](LICENSE).
