# Playwright Integration

`@aee/playwright` provides a small bridge from a Playwright `page` into the shared AEE execution pipeline.

The package currently resolves through this repository's npm workspace and has not yet been published to a package registry.

## What it does

- Builds a checkpoint and interaction for the current page
- Runs the selected observers before and after the interaction, or once when there is none to perform
- Produces evidence bundles, judgments, findings, and report artifacts
- Optionally writes `run.json`, `bundle.json`, and reporter output to disk

## Minimal example

```ts
import { test } from "@playwright/test";
import { runAeeOnPage } from "@aee/playwright";

test("collect accessibility evidence for the home page", async ({ page }) => {
  await page.goto("https://example.com");

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: "aee-output",
    observers: ["dom", "accessibility-tree"],
    judges: ["structure", "release"],
    checkpointName: "home-page",
    interaction: {
      kind: "custom",
      actor: "test",
      target: {
        role: "document",
        name: "Example home page"
      }
    }
  });

  console.log(result.reporterFiles);
});
```

## Interaction example

`runAeeOnPage(...)` can also bracket a real interaction between the `before` and `after` observer phases.

```ts
await page.focus("#first");

await runAeeOnPage({
  page,
  projectRoot: process.cwd(),
  observers: ["focus", "dom"],
  judges: ["keyboard", "release"],
  interaction: {
    kind: "tab",
    actor: "test"
  },
  async performInteraction({ page }) {
    await page.keyboard.press("Tab");
  }
});
```

## Role-aware keyboard matrix

The scenario author chooses every action. AEE does not infer which controls or keys to test. For an authored action, the keyboard judge uses the focused element's role, native element type, composite role, and orientation to select a bounded deterministic check.

| Context                                  | Evaluated authored keys | Deterministic evidence check                                                                                                  |
| ---------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Button                                   | Enter, Space            | An observable focus, DOM, or network response follows activation                                                              |
| Link                                     | Enter                   | An observable response follows activation; Space remains `unknown`                                                            |
| Checkbox, radio, switch                  | Space                   | An observable response follows activation                                                                                     |
| Menu item                                | Enter, Space            | An observable response follows activation                                                                                     |
| Manually activated tab                   | Enter, Space            | An observable response follows activation; an already selected tab remains `unknown` without a more specific expected outcome |
| Horizontal tablist or menubar            | Left, Right, Home, End  | Focus stays within peer items and moves in the requested direction or to the requested endpoint                               |
| Vertical tablist, listbox, menu, or tree | Up, Down, Home, End     | Focus stays within peer items and moves in the requested direction or to the requested endpoint                               |
| Radiogroup                               | Left, Right, Up, Down   | Focus stays within the radio group and moves in the requested direction                                                       |
| Grid                                     | Left, Right, Up, Down   | Focus stays within grid cells and moves in the requested direction                                                            |

The matrix follows the keyboard conventions in the [WAI-ARIA Authoring Practices keyboard interface guidance](https://www.w3.org/WAI/ARIA/apg/practices/keyboard-interface/) and the applicable [button](https://www.w3.org/WAI/ARIA/apg/patterns/button/), [tabs](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/), and [listbox](https://www.w3.org/WAI/ARIA/apg/patterns/listbox/) patterns. Authoring a role does not implement its keyboard behavior; the evidence verifies what the page actually did. Optional pattern keys such as Home and End are evaluated only when the user authors them.

Context-dependent behavior remains explicit. For example, Space selection in a listbox depends on its selection model, and Left/Right on a tree can expand, collapse, or move focus. These combinations return `unknown` unless the scenario supplies a specific outcome assertion.

## Keyboard activation example

The keyboard judge evaluates supported `enter` and `space` activation when focus evidence identifies the control and another observer captures an observable response.

```ts
await page.focus("#save");

await runAeeOnPage({
  page,
  projectRoot: process.cwd(),
  observers: ["focus", "dom"],
  judges: ["keyboard", "release"],
  interaction: {
    kind: "enter",
    actor: "test",
    target: {
      role: "button",
      name: "Save"
    }
  },
  async performInteraction({ page }) {
    await page.keyboard.press("Enter");
  }
});
```

## Composite navigation example

The keyboard judge can evaluate role- and orientation-aware roving-focus navigation in detectable composite widgets such as tablists.

```ts
await page.focus("#tab-overview");

await runAeeOnPage({
  page,
  projectRoot: process.cwd(),
  observers: ["focus"],
  judges: ["keyboard", "release"],
  interaction: {
    kind: "arrow-key",
    input: "ArrowRight",
    actor: "test",
    target: {
      role: "tab",
      name: "Overview"
    }
  },
  async performInteraction({ page }) {
    await page.keyboard.press("ArrowRight");
  }
});
```

## Active descendant example

The focus snapshot can also track `aria-activedescendant`, which lets the keyboard judge evaluate listbox-style composites even when DOM focus stays on the composite host.

```ts
await page.focus("#city-listbox");

await runAeeOnPage({
  page,
  projectRoot: process.cwd(),
  observers: ["focus"],
  judges: ["keyboard", "release"],
  interaction: {
    kind: "arrow-key",
    input: "ArrowDown",
    actor: "test",
    target: {
      role: "option",
      name: "Tel Aviv"
    }
  },
  async performInteraction({ page }) {
    await page.keyboard.press("ArrowDown");
  }
});
```

## Change-response example

The change-response judge can evaluate whether a click, enter, space, or submit interaction produced an observable outcome when paired with DOM, network, or focus evidence.

```ts
await runAeeOnPage({
  page,
  projectRoot: process.cwd(),
  observers: ["dom"],
  judges: ["change-response", "release"],
  interaction: {
    kind: "click",
    actor: "test",
    target: {
      role: "button",
      name: "Save"
    }
  },
  async performInteraction({ page }) {
    await page.click("#save");
  }
});
```

## Modal focus-management example

The focus-management judge evaluates an explicit behavioral expectation. For a modal-opening interaction, set `interaction.meta.focusExpectation` to `inside-dialog`; the focus observer records whether the active element moved into an element with `dialog` or `alertdialog` semantics.

```ts
await page.getByRole("button", { name: "Delete Project Alpha" }).focus();

await runAeeOnPage({
  page,
  projectRoot: process.cwd(),
  observers: ["dom", "focus"],
  judges: ["focus-management", "change-response", "release"],
  interaction: {
    kind: "click",
    actor: "test",
    target: { role: "button", name: "Delete Project Alpha" },
    meta: { focusExpectation: "inside-dialog" }
  },
  async performInteraction({ page }) {
    await page.getByRole("button", { name: "Delete Project Alpha" }).click();
  }
});
```

This expectation is intentionally explicit. AEE does not infer that every DOM change containing dialog markup is modal or that every interaction should transfer focus.

## Screenshot and axe example

The visual observer writes separate viewport and full-page PNG artifacts before and after an interaction. The axe observer writes the axe 4.13 JSON result, including passes, violations, incomplete, and inapplicable checks. AEE adds to it in one way that changes a result: when axe leaves a text's `color-contrast` check incomplete because a gradient, a background image or an image is behind the text, AEE hides that text, takes a full-page screenshot and measures the text's color against every pixel behind it. The check passes when every pixel gives the required ratio and fails when none does, and the node moves to the rule's passes or violations with the measurement in `aeeContrast`; a failing node's message gives the measured range in axe's wording. When some pixels pass and some fail, or the text has a shadow or outline, the check stays incomplete with its measurement or reason attached. Pair the `axe` observer with the `axe` judge so violations and incomplete checks reach the release gate.

```ts
await runAeeOnPage({
  page,
  projectRoot: process.cwd(),
  observers: ["visual", "axe"],
  judges: ["axe", "release"],
  interaction: {
    kind: "click",
    actor: "test"
  },
  async performInteraction({ page }) {
    await page.click("#save");
  }
});
```

This produces `visual-viewport-before.png`, `visual-full-page-before.png`, matching after-state images, and `axe-before.json` / `axe-after.json`. An axe violation fails the axe judgment; a run containing only incomplete axe checks remains `unknown` rather than becoming a pass.

## Portable virtual screen-reader example

The portable reader provides deterministic guide-mode navigation without requiring installed assistive technology. Give it a dedicated Playwright page or test so it forms an isolated lane. Its virtual cursor reads semantic candidates but does not focus or activate them. Every role, name and state it announces comes from the browser's accessibility tree, read over the Chrome DevTools Protocol, so it follows the HTML-AAM and accname mappings Chromium implements, and it applies the platform rule that a form or region is a landmark only when it has a name; a DOM snapshot supplies each item's element path and position. It therefore needs a Chromium page.

```ts
import { createPortableVirtualScreenReader, runAeeOnPage } from "@aee/playwright";

const reader = createPortableVirtualScreenReader(page);

await runAeeOnPage({
  page,
  projectRoot: process.cwd(),
  virtualScreenReader: reader,
  observers: ["dom", "accessibility-tree", "focus", "visual", "virtual-screen-reader"],
  judges: ["screen-reader", "release"],
  interaction: {
    kind: "screen-reader-command",
    input: "next-heading",
    actor: "test"
  },
  async performInteraction() {
    await reader.command("next-heading");
  }
});
```

Supported commands are `start`, `next-item`, `previous-item`, `next-heading`, `previous-heading`, `next-landmark`, `next-control`, and `read-current`. Every command records the item, synthesized announcement, timestamp, and DOM focus before and after. The observer writes canonical JSON and a readable text projection for both capture phases.

This is explicitly a semantic simulation. It works without VoiceOver or NVDA, but it does not reproduce their browser/OS accessibility APIs, speech behavior, interaction modes, or bugs. Real VoiceOver and NVDA runs remain an optional AT-fidelity tier.

For a complete isolated lane, declare the command sequence in the user-controlled scenario and pass it to `runVirtualScreenReaderLane(...)`. The lane owns and closes a dedicated browser context, checks the origin before and after every command, and calls `runAeeOnPage(...)` once per command so every action receives fresh DOM, accessibility-tree, focus, visual, Axe, and transcript evidence.

```yaml
journeys:
  - id: explore-homepage
    # ...goal and action permissions...
    virtualScreenReaderCommands:
      - next-landmark
      - next-heading
      - next-control
```

```ts
const lane = await runVirtualScreenReaderLane({
  browser,
  projectRoot: process.cwd(),
  targetUrl: scenario.target.url,
  allowedOrigins: scenario.target.allowedOrigins ?? [scenario.target.url],
  commands: scenario.journeys[0].virtualScreenReaderCommands!
});
```

The lane writes `lane.json`, `transcript.json`, `transcript.txt`, a WebM recording with JSON action timeline and WebVTT captions, and a checksummed `manifest.json`, plus one full AEE run directory for every user-selected command. The schemas package validates each canonical metadata file.

## User-authored pointer and keyboard comparison

Declare both input paths and the exact observable outcome in the scenario. Pointer and keyboard paths start from separate, newly loaded browser contexts. The engine executes only these actions, captures a full evidence run after every action, and compares only the requested observable fields.

```yaml
interactionComparisons:
  - id: invoice-details
    name: Invoice details appear on hover and keyboard focus
    pointerActions:
      - id: hover-details
        kind: hover
        target: { role: button, name: Invoice details }
    keyboardActions:
      - id: focus-details
        kind: focus
        target: { role: button, name: Invoice details }
    observe:
      target: { selector: "#invoice-details" }
      visible: true
      text: true
      attributes: [data-state]
    expected:
      visible: true
      text: Invoice total is $24
      attributes: { data-state: shown }
```

```ts
const comparison = scenario.journeys[0].interactionComparisons![0];
const trace = await runInputComparison({
  browser,
  projectRoot: process.cwd(),
  targetUrl: scenario.target.url,
  allowedOrigins: scenario.target.allowedOrigins ?? [scenario.target.url],
  comparisonId: comparison.id,
  ...comparison
});
```

The result is `interaction-trace.json`, validated by `interaction-comparison.schema.json`, plus one WebM/JSON/WebVTT video set per input lane and `manifest.json`. Equivalence and expected-outcome verdicts are separate from each action's Axe/release verdict, so an equivalent interaction cannot conceal an unrelated accessibility failure.

The manifest indexes the trace, JSON and Markdown reports, run and bundle metadata, and every required before/after focus, DOM, accessibility-tree, viewport, full-page, and Axe artifact. It uses relative paths and SHA-256 checksums. Missing required files remain visible and make the manifest partial.

## Keyboard and pointer sweep

`runKeyboardPointerSweepLane(...)` checks one page by keyboard and mouse with no authored steps. After each load it waits, as a checkpoint does, for the app to draw the page: until the DOM has been quiet for the capture policy's stabilizing pause, 3 seconds at most. It tabs to every stop from the top of the page, then reports mouse targets no key reaches (`pointer-only`): not Tab, nor the arrow keys, Home and End of a tablist, menu, listbox, tree, grid, radio group or toolbar that Tab enters, which it presses from there. It also reports content hover shows that keyboard focus never does (`hover-only`). It also compares how text looks with what the accessibility tree says, and reports a short line styled as a title (bold and larger than the body text, or 40% larger) that has no heading role (`looks-like-heading`). That one is advisory: typography cannot prove the author meant a heading, so it never blocks release. With `activateControls: true` it also presses each on-page control by keyboard and by mouse from a fresh page, and reports a different result (`activation-differs`), focus left on nothing visible (`focus-lost`), or new text a screen reader does not say (`status-not-announced`): text in no live region that was on the page before the press (an alert counts either way), that focus did not move to, and that no page load or change in the control's own expanded, pressed or checked state explains. That one is advisory too, since whether the text is a status message is the author's call. Each press is read once the page has settled, so a message that comes a moment later counts. Links and form submit buttons are never pressed, and any navigation outside the allowed origins is stopped before it leaves the page. If Tab reaches nothing on a page with links, buttons or other controls the keyboard reaches without a script, the sweep decides nothing: the page was not ready or a script stops Tab, so it reports no finding, its record is `failed` with that reason, and the keyboard row reads "Needs review".

```ts
const sweep = await runKeyboardPointerSweepLane({
  browser,
  projectRoot: process.cwd(),
  targetUrl: scenario.target.url,
  allowedOrigins: scenario.target.allowedOrigins ?? [scenario.target.url],
  activateControls: false
});
```

The lane writes `keyboard-pointer-sweep.json`, validated by `keyboard-pointer-sweep-lane.schema.json`, a full-page screenshot with where each finding is on it, and `manifest.json`.

## Approved scenario CLI

The CLI composes those lane runners for an approved YAML scenario:

```bash
aee plan scenario.yml
aee run scenario.yml --output aee-output/scenarios
aee run scenario.yml --open
aee run scenario.yml --ci
```

The compiled digest must match `approval.approvedPlanDigest`. Every journey's start page gets the
keyboard and pointer sweep; beyond it, execution is limited to concrete `virtualScreenReaderCommands`
and `interactionComparisons`. `allowedActions` define the safety boundary, and only one of them acts
on its own: `activate-page-controls` lets the sweep press on-page controls. The result includes `aee-report.html`, `aee-report.json`, `aee-report.md`, the compiled
plan, and one scenario-level `manifest.json` that validates and re-hashes the child-lane evidence.
Verdict and evidence completeness are reported separately, and incomplete evidence cannot pass.

`aee-pr-comment.md` is the same report as one pull-request comment. It opens with the verdict and
the four status rows, then lists the blocking fixes, then the advisory results, then any AI
suggestions, each labelled as AI. Every finding is a collapsed `<details>` block with the problem,
up to five affected elements, the fix and its a11y-skills pattern. Element names, selectors and AI
wording are shown as code, and other text that can come from the page is escaped, so a tested page
cannot add markup, mention people or link issues in the comment. The full report keeps everything
the comment leaves out.

`aee comment <folder>...` gathers every assessment under the folders (a scenario's, or each test's
from the fixture) into the one comment AEE keeps on a pull request. One assessment reads like its own
PR comment. Several make one summary: each status row with how many tests had each result, every
distinct problem once with the tests that saw it, and the tests by outcome. An element failing a rule
is one problem however many tests render it, so the comment grows with the problems, not the tests;
past GitHub's size limit the rest are counted. With `--post` it finds its earlier comment by the
hidden marker it starts with and updates it, or creates it on the first run; `--fail-on blocking`
(default), `incomplete` or `never` sets the exit code. The GitHub Action (`action.yml`) runs this
after the scenario or test command.

## Drop-in test fixture

Once AEE is [installed from GitHub](../README.md#install-from-github), an existing Playwright spec
gets it by changing one import:

```diff
- import { expect, test } from "@playwright/test";
+ import { expect, test } from "@aee/cli/test";
```

`@aee/cli/test` also re-exports Playwright's types, such as `Page`, so a spec that imports them on
the same line needs no other change. Every page load the test starts (`goto`, `reload`,
`setContent`, `goBack`, `goForward`) is checkpointed as soon as it returns, and so is the page as a
passing test leaves it, unless the test never loaded one: a test that only calls `page.request`
leaves the blank page every tab starts on, and that is not checked. A checkpoint
runs the same focus, DOM, accessibility-tree, visual and axe capture as an `aee run` step, on the
test's own page and session, and waits for the load that started it, so the test never races it.
For a state no page load reaches, such as an open dialog, the test names one:

```ts
test("the help dialog opens", async ({ page, checkpoint }) => {
  await page.goto("/help");
  await page.getByRole("button", { name: "Open help" }).click();
  await checkpoint("dialog open");
});
```

Each test gets one assessment in its output folder (`test-results/<test>/aee/`) with the same
`aee-report.html`, `aee-report.json`, `aee-report.md`, `aee-pr-comment.md` and `manifest.json`
as `aee run`, and the HTML report and PR comment are attached to the test's results. The report is
called what the test is called, and the test prints one line with the verdict and the report's path,
such as `AEE: release blocked, 2 fixes needed. Report: test-results/…/aee/aee-report.html`. Its plan
profile is `playwright-test`.

Where a passing test ends on a web page that no other test of the run has ended on, the fixture also
checks that page by keyboard and with the virtual screen reader. The keyboard and mouse sweep Tabs to
every stop, finds mouse targets Tab never reaches and content only hover shows; it does not press
controls. The reader starts at the top of the page and reads on, item by item, up to twelve items or
the end of the page. Both run on the test's own page, from a fresh load of its address, so they keep
the test's session, cookies, storage and routes, such as a mocked sign-in or mocked data, and they
record no video. A page is its address without query or fragment, and each is checked once per run,
so a suite pays once per page; another test ending on a checked page reads "Checked in another
test" in its keyboard and reader rows. A page that is not on the web (about:blank, a data: or a
file: URL) is checked with axe only. A test that did not pass, did not end on a web page, or has the
checks off reads "Not in this run", and the row's detail says which. The report records why
(`completeness.plannedChecks.skipped`), and the PR comment counts each result apart. The checks get
three minutes of their own on top of the test's timeout. To turn them off for a project, a file or a
test:

```ts
test.use({ aee: { keyboardAndReader: false } });
```

The fixture reports; it never fails a test. `@playwright/test` is a peer dependency, from 1.50 on, so
the fixture extends the runner the project already has and `aee run` launches the same Playwright:
installing AEE leaves a project's Playwright as it was.

## Network example

The network observer can capture request and response activity around an interaction.

```ts
await runAeeOnPage({
  page,
  projectRoot: process.cwd(),
  observers: ["network"],
  judges: ["release"],
  interaction: {
    kind: "click",
    actor: "test"
  },
  async performInteraction({ page }) {
    await Promise.all([page.waitForResponse("https://aee.test/api/save"), page.click("#save")]);
  }
});
```

## Capture policy example

`runAeeOnPage(...)` also honors `policy.capture`, which lets a flow disable specific capture types or wait longer before the after-phase observers run.

```ts
await runAeeOnPage({
  page,
  projectRoot: process.cwd(),
  observers: ["dom", "accessibility-tree", "visual"],
  judges: ["change-response", "release"],
  policy: {
    name: "stable-dom-only",
    capture: {
      includeAccessibilityTree: false,
      includeScreenshots: false,
      stabilizeAfterInteractionMs: 500
    }
  },
  interaction: {
    kind: "click",
    actor: "test",
    target: {
      role: "button",
      name: "Save"
    }
  },
  async performInteraction({ page }) {
    await page.click("#save");
  }
});
```

## Pointer and keyboard outcome comparison

`comparePointerAndKeyboardOutcomes(...)` runs both paths from the same reset state. The caller defines what observable outcome matters, such as tooltip visibility and text.

```ts
const result = await comparePointerAndKeyboardOutcomes({
  reset: () => resetChart(),
  performPointerInteraction: () => point.hover(),
  performKeyboardInteraction: () => point.focus(),
  captureOutcome: () => readTooltipState()
});
```

## Motion-control verification

`verifyMotionControl(...)` samples motion, requests the stop action, then takes two later samples. A pass requires zero active animations and the same caller-defined visual signature in both later samples.

```ts
const result = await verifyMotionControl({
  sample: () => readTickerMotion(),
  requestStop: () => pauseButton.click(),
  settleMs: 100
});
```

These helpers are explicit probes rather than universal WCAG judgments. The test author chooses the relevant controls, outcomes, animation scope, timing, and expected equivalence.

## Notes

- `outputDir` is optional. When provided, AEE writes reports and captured artifacts into `outputDir/<run-id>/`.
- A caller-provided `runId` must contain 1–128 letters, numbers, dots, underscores, or hyphens and must begin with a letter or number. Path separators and traversal segments are rejected before output is created.
- Without `outputDir`, `runAeeOnPage(...)` still returns in-memory `reportArtifacts`.
- `policy.capture` filters incompatible observer requests before execution and records the applied capture policy in the emitted run config.
- The DOM observer relies on `page.content()`.
- The accessibility-tree observer uses a direct snapshot hook when available and falls back to Chromium CDP via `Accessibility.getFullAXTree` for real Playwright pages.
- The focus observer snapshots `document.activeElement`, the deepest active element through open shadow roots and same-origin frames, the complete focus chain, focus-visible computed styles, `aria-activedescendant`, and the browser accessibility tree's focused node.
- Focus snapshots include the containing dialog context when the active element is inside a native or ARIA dialog.
- The focus-management judge supports explicit `inside-dialog`, `preserve`, and `target` expectations. Pointer hover is required to preserve focus; an authored focus action must resolve to its requested target.
- The keyboard judge relies on deep focus evidence for tab order, role- and orientation-aware composite navigation, `aria-activedescendant`, and role-aware Enter/Space activation. It evaluates only user-authored actions; unsupported or context-dependent combinations return `unknown`.
- The change-response judge currently evaluates click, enter, space, and submit interactions when DOM, network, or focus observers are available.
- The visual observer uses a screenshot snapshot hook and captures separate viewport and full-page PNG artifacts before and after the interaction.
- The axe observer pins `@axe-core/playwright` 4.13.0, runs the cumulative WCAG 2.0/2.1/2.2 A/AA tag selection, and retains every raw result category.
- The portable virtual reader uses a separate in-memory cursor, validates its canonical transcript against JSON Schema, and records DOM focus before and after every command.
- The screen-reader judge requires transcript presence and focus separation, then matches the virtual target's normalized role, name, and heading level against the same-checkpoint accessibility tree. It also requires a full DOM snapshot, non-zero rendered bounds, and a full-page screenshot. Missing inputs return `unknown`; an untruncated DOM/AOM contradiction fails. This verifies deterministic semantic agreement and visual presence, not pixel meaning.
- The network observer tracks request and response events between `setup` and `teardown`, snapshots the accumulated log before and after the interaction boundary, and summarizes new request/response activity in record metadata.
- Before network artifacts are persisted, AEE removes URL credentials and fragments, redacts all query and header values, replaces request bodies, and drops unknown event fields. URL paths remain visible. See [Evidence privacy](privacy.md).
- The markdown reporter now opens with triage sections for blocking judgments, unresolved signals, and suggested fixes.
- `@aee/cli` installs Playwright for its real-page scenario runner. Direct `@aee/playwright` consumers still provide a compatible Playwright page or browser.
