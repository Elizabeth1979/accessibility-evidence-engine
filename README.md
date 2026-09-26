# Accessibility Evidence Engine

Accessibility Evidence Engine (AEE) is an experimental, evidence-first framework for investigating accessibility behavior around Playwright interactions. It captures page state before and after an action, correlates the evidence, runs focused judges, and produces JSON and Markdown reports for review or release-policy decisions.

> [!IMPORTANT]
> AEE is an early public-preview project, not a complete WCAG conformance scanner. A passing AEE report means that the selected judges passed with the evidence captured for that interaction; it does not certify that a page or product is accessible.

Explore the [public interactive demonstration](https://elizabeth1979.github.io/accessibility-evidence-engine/) or continue below to run AEE locally.

## Why AEE

Many automated checks report a rule result without preserving enough context to explain what happened during an interaction. AEE keeps evidence collection, correlation, judgment, and reporting separate so a result can be traced back to the captured DOM, accessibility tree, focus state, screenshot, or network activity.

AEE complements rule engines such as axe rather than replacing them. Static rules are excellent at objective defects such as an icon button without an accessible name. AEE adds value only when remediation depends on meaning: a deterministic router can escalate full-page heading structure, icon-only naming, and decorative-versus-informative classification for contextual review. Routine failures never call a model. The interaction pipeline separately verifies stateful behavior such as whether focus actually enters an opened modal.

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
in the technical annex. Deterministic remediation leads; AI is explicitly marked as unused or
available only for bounded contextual assistance.

Add `--open` to open the HTML report, or `--ci` to return a nonzero status for a failed, unknown, or
incomplete result. The runner executes only the virtual-reader commands and pointer/keyboard
comparisons authored in the YAML; allowed actions remain permissions rather than inferred steps.

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

The `@aee/*` packages currently work as local npm workspaces in this repository; they have not yet been published to a package registry. See [Playwright integration](docs/playwright-integration.md) for focus, composite-widget, screenshot, network, and capture-policy examples.

### Before-and-after examples

The [public demo](https://elizabeth1979.github.io/accessibility-evidence-engine/#examples) is a learner-controlled slideshow with six focused comparisons: an icon-only label, a heading hierarchy that passes axe's selected automatic rules, modal focus management, palette-aware contrast repair, hover-versus-keyboard equivalence, and animation stopping. Each slide shows one Before and one After image. Nothing autoplays, and detailed artifacts stay collapsed until requested.

Rebuild the axe and AEE evidence plus the public images locally with:

```bash
npm run demo:record
```

## Current capabilities

| Area                    | Implemented                                                                       | Current scope                                                                                                                                                      |
| ----------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Observers               | DOM, accessibility tree, focus, viewport/full-page screenshots, axe 4.13, network | Before/after capture with raw artifacts; DOM and network change summaries                                                                                          |
| axe judge               | WCAG 2.0/2.1/2.2 A/AA result gating                                               | Fails violations and preserves incomplete checks as unresolved review work                                                                                         |
| Portable virtual reader | Guide-mode semantic navigation and JSON/TXT transcripts                           | Keeps its virtual cursor separate from DOM focus; explicitly not VoiceOver or NVDA fidelity                                                                        |
| Screen-reader judge     | Focus separation plus DOM/AOM/rendered-presence agreement                         | Matches role, name, and heading level and requires rendered bounds plus a full-page screenshot; pixel meaning remains review work                                  |
| Keyboard judge          | Tab, shift-tab, role-aware enter/space, composite arrows/Home/End                 | Evaluates user-authored keys against a bounded role/orientation matrix, deep focus, `aria-activedescendant`, and observable activation                             |
| Focus-management judge  | Modal opening                                                                     | Verifies an explicit `inside-dialog` focus expectation using before/after focus evidence                                                                           |
| Change-response judge   | Click, enter, space, submit                                                       | Detects observable DOM, focus, or network outcomes                                                                                                                 |
| Structure judge         | Evidence completeness                                                             | Confirms successful DOM and accessibility-tree capture; it does not yet evaluate individual structure rules                                                        |
| Release judge           | Policy gate                                                                       | Applies severity, confidence, and unknown-result policy to prior judgments                                                                                         |
| Validation              | JSON Schema and YAML scenario planning                                            | Validates fixture config, user-controlled scenarios, compiled plans, and emitted evidence payloads                                                                 |
| Reporting               | Interactive HTML triage room plus canonical JSON and Markdown                     | Leads with scoped status, visual before/proposed-fix review, effort, and local evidence Q&A; action, Axe, transcript, media, and raw files stay linked in an annex |
| Evidence manifest       | Relative paths, SHA-256 integrity, provenance, execution status, and privacy      | Re-hashes child-lane evidence into one scenario manifest; omissions make the manifest partial                                                                      |
| Interaction video       | WebM, JSON action timeline, and WebVTT captions                                   | Records each active lane, labels action timing, and indexes all three privacy-sensitive files in the manifest                                                      |
| Deep focus state        | Document/deep active element, shadow/iframe chain, focus-visible styles, AX focus | Preserves synchronized focus evidence and deterministically checks explicit preserve, target, and dialog-transfer expectations                                     |
| AI review routing       | Headings, icon labels, decorative classification                                  | Deterministic allowlist escalates only meaning-dependent cases; routine failures never call a model                                                                |
| AI fix proposals        | Contextual accessible names                                                       | Injected provider proposes a label; output is always review-only and requires a verified rerun                                                                     |
| Palette contrast        | Existing-token selection                                                          | Selects the perceptually closest supplied palette color that clears a requested contrast ratio                                                                     |
| Interaction probes      | Isolated pointer/keyboard journeys, hover equivalence, motion stopping            | Runs only user-declared actions from matching seeded storage and landing URL, recaptures each action, and saves a validated trace                                  |

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
| `@aee/cli`        | Approved YAML scenario execution plus legacy fixture execution           |

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
- AI proposals are not applied automatically and are not evidence of correctness. Callers must provide model credentials, review the suggested patch, and rerun appropriate judges.

## Roadmap

See the [live roadmap](https://elizabeth1979.github.io/accessibility-evidence-engine/roadmap.html). It is generated from [the master plan](docs/MASTER-PLAN.md) on every deploy.

## Documentation

- [Architecture](docs/architecture.md)
- [Target evidence pipeline and artifact layout](docs/evidence-run-layout.md)
- [Master plan](docs/MASTER-PLAN.md)
- [Implementation roadmap](docs/implementation-roadmap.md)
- [Detection, analysis, and remediation registry](rules/remediation-registry.json)
- [Observer lifecycle](docs/observer-lifecycle.md)
- [Playwright integration](docs/playwright-integration.md)
- [Evidence privacy](docs/privacy.md)
- [AI fix proposals](docs/ai-fixes.md)

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before participating. Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md), never through a public issue.

## License

Licensed under the [Apache License 2.0](LICENSE).
