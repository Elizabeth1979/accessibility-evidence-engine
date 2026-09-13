# Playwright Integration

`@aee/playwright` provides a small bridge from a Playwright `page` into the shared AEE execution pipeline.

The package currently resolves through this repository's npm workspace and has not yet been published to a package registry.

## What it does

- Builds a checkpoint and interaction for the current page
- Runs the selected observers before and after capture
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

## Keyboard activation example

The keyboard judge can also evaluate simple `enter` and `space` activation when focus evidence is available and another observer captures an observable response.

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

The keyboard judge can also evaluate simple roving-focus arrow-key navigation in detectable composite widgets such as tablists.

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

The visual observer writes separate viewport and full-page PNG artifacts before and after an interaction. The axe observer writes the unmodified axe 4.13 JSON result, including passes, violations, incomplete, and inapplicable checks. Pair the `axe` observer with the `axe` judge so violations and incomplete checks reach the release gate.

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
- The focus observer snapshots `document.activeElement` and pairs well with `performInteraction(...)` for keyboard-navigation checks.
- Focus snapshots include the containing dialog context when the active element is inside a native or ARIA dialog.
- The focus-management judge currently supports the explicit `inside-dialog` expectation for modal-opening interactions.
- The keyboard judge currently relies on focus evidence for tab order, simple roving arrow-key navigation, basic `aria-activedescendant` composites, and basic enter/space activation checks.
- The change-response judge currently evaluates click, enter, space, and submit interactions when DOM, network, or focus observers are available.
- The visual observer uses a screenshot snapshot hook and captures separate viewport and full-page PNG artifacts before and after the interaction.
- The axe observer pins `@axe-core/playwright` 4.13.0, runs the cumulative WCAG 2.0/2.1/2.2 A/AA tag selection, and retains every raw result category.
- The network observer tracks request and response events between `setup` and `teardown`, snapshots the accumulated log before and after the interaction boundary, and summarizes new request/response activity in record metadata.
- Before network artifacts are persisted, AEE removes URL credentials and fragments, redacts all query and header values, replaces request bodies, and drops unknown event fields. URL paths remain visible. See [Evidence privacy](privacy.md).
- The markdown reporter now opens with triage sections for blocking judgments, unresolved signals, and suggested fixes.
- This repo does not yet bundle Playwright itself; install `@playwright/test` or `playwright` in the consuming test project.
