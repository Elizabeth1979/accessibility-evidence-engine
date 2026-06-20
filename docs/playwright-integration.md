# Playwright Integration

`@aee/playwright` provides a small bridge from a Playwright `page` into the shared AEE execution pipeline.

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

## Notes

- `outputDir` is optional. When provided, AEE writes reports and captured artifacts into `outputDir/<run-id>/`.
- Without `outputDir`, `runAeeOnPage(...)` still returns in-memory `reportArtifacts`.
- The DOM observer relies on `page.content()`.
- The accessibility-tree observer uses a direct snapshot hook when available and falls back to Chromium CDP via `Accessibility.getFullAXTree` for real Playwright pages.
- The focus observer snapshots `document.activeElement` and pairs well with `performInteraction(...)` for keyboard-navigation checks.
- This repo does not yet bundle Playwright itself; install `@playwright/test` or `playwright` in the consuming test project.
