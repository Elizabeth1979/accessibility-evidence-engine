# Accessibility Evidence Engine

Accessibility Evidence Engine (AEE) is an experimental, evidence-first framework for investigating accessibility behavior around Playwright interactions. It captures page state before and after an action, correlates the evidence, runs focused judges, and produces JSON and Markdown reports for review or release-policy decisions.

> [!IMPORTANT]
> AEE is an early public-preview project, not a complete WCAG conformance scanner. A passing AEE report means that the selected judges passed with the evidence captured for that interaction; it does not certify that a page or product is accessible.

## Why AEE

Many automated checks report a rule result without preserving enough context to explain what happened during an interaction. AEE keeps evidence collection, correlation, judgment, and reporting separate so a result can be traced back to the captured DOM, accessibility tree, focus state, screenshot, or network activity.

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

Run the automated checks:

```bash
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

## Current capabilities

| Area | Implemented | Current scope |
| --- | --- | --- |
| Observers | DOM, accessibility tree, focus, screenshot, network | Before/after capture with artifacts and simple change summaries |
| Keyboard judge | Tab, shift-tab, arrow-key composites, enter, space | Focus direction, simple roving focus, `aria-activedescendant`, and observable activation |
| Change-response judge | Click, enter, space, submit | Detects observable DOM, focus, or network outcomes |
| Structure judge | Evidence completeness | Confirms successful DOM and accessibility-tree capture; it does not yet evaluate individual structure rules |
| Release judge | Policy gate | Applies severity, confidence, and unknown-result policy to prior judgments |
| Validation | JSON Schema | Validates CLI inputs and emitted run, bundle, and report payloads |
| Reporting | JSON and Markdown | Includes triage, observer coverage, judgments, findings, and artifact summaries |

The Guidepup screen-reader and axe observers, plus the interaction, screen-reader, and visual judges, are declared extension points but currently return unsupported or unknown results. They should not be presented as implemented checks.

## Package layout

| Package | Responsibility |
| --- | --- |
| `@aee/core` | Domain types, policies, orchestration, correlation, and plugin contracts |
| `@aee/schemas` | JSON Schemas and runtime validation |
| `@aee/playwright` | Real and virtual page adapters plus `runAeeOnPage(...)` |
| `@aee/observers` | Built-in evidence observers and observer manifests |
| `@aee/judges` | Built-in judges, release gating, and judge manifests |
| `@aee/reporter` | JSON and Markdown reporters |
| `@aee/cli` | Fixture configuration, execution, and artifact output |

## Evidence privacy

Treat generated evidence as potentially sensitive. Network artifacts redact credentials, fragments, query values, header values, and request bodies before writing, including data from custom network adapters. DOM snapshots, accessibility trees, focus metadata, screenshots, target descriptions, report paths, and URL paths can still contain private information.

Review artifacts before sharing them and use test accounts and non-production environments wherever possible. See [Evidence privacy](docs/privacy.md) for the full handling guidance.

## Known limitations

- The CLI currently runs JSON fixtures; real pages use the Playwright API.
- AEE evaluates one interaction bundle per `runAeeOnPage(...)` call.
- Stabilization is currently a fixed post-interaction delay, not network-idle, animation, or mutation detection.
- Observer timeout and continue-on-error policy fields exist, but engine-level enforcement is not implemented yet.
- Several declared observers and judges remain extension scaffolds, as listed above.
- Public npm packaging and a hosted user interface are not available yet.

## Roadmap

1. Expand structure and composite-widget judgments.
2. Add explicit minimum-evidence and observer-coverage policies.
3. Enforce observer timeouts and error-continuation policy.
4. Add richer stabilization strategies and report formats.
5. Prepare the workspace packages for public distribution.

## Documentation

- [Architecture](docs/architecture.md)
- [Observer lifecycle](docs/observer-lifecycle.md)
- [Playwright integration](docs/playwright-integration.md)
- [Evidence privacy](docs/privacy.md)

## Contributing and security

Contributions are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md) before participating. Report suspected vulnerabilities privately according to [SECURITY.md](SECURITY.md), never through a public issue.

## License

Licensed under the [Apache License 2.0](LICENSE).
