import { test as base, type Page } from "@playwright/test";

import { startPageCheckpointLane, toSafeId } from "@aee/playwright";
import { CURRENT_SCHEMA_VERSION } from "@aee/schemas";

import { compileScenarioPlan, type AeeScenario } from "./scenario";
import {
  collectPageCheckpointActions,
  finishAssessment,
  type ScenarioActionReport
} from "./scenario-runner";

/** The page loads a test starts; the page is checkpointed as soon as each one returns. */
const PAGE_LOADS = ["goto", "reload", "setContent", "goBack", "goForward"] as const;

export interface AeeTestFixtures {
  /**
   * Checkpoints the page as it is now, for a state no page load reaches, such as an open dialog.
   * Page loads and the end of the test are checkpointed on their own.
   */
  checkpoint: (name: string) => Promise<void>;
}

const checkpoints = new WeakMap<Page, (name: string) => Promise<void>>();

/**
 * Playwright's `test` with AEE checkpoints. Swap `@playwright/test` for `@aee/cli/test` in a
 * spec's import and nothing else: each page load the test starts, and the page as the test leaves
 * it, is checked like an `aee run` checkpoint, and the test gets the same report and PR comment,
 * attached to its results. A checkpoint waits for the page load that started it, so the test never
 * races it. The fixture reports; it never fails a test.
 */
export const test = base.extend<AeeTestFixtures>({
  page: async ({ page }, use, testInfo) => {
    const startedAt = new Date().toISOString();
    const assessmentDir = testInfo.outputPath("aee");
    const lane = startPageCheckpointLane({
      page,
      projectRoot: assessmentDir,
      outputDir: ".",
      laneId: "playwright-test"
    });
    // One collapsed step per checkpoint, so its browser calls do not crowd the test's own steps.
    const checkpoint = (name: string) =>
      base.step(`AEE checkpoint: ${name}`, () => lane.checkpoint(name), { box: true });
    checkpoints.set(page, checkpoint);
    for (const method of PAGE_LOADS) {
      const load: (...args: never[]) => Promise<unknown> = page[method].bind(page);
      Object.defineProperty(page, method, {
        value: async (...args: never[]) => {
          const response = await load(...args);
          await checkpoint(`after ${method}`);
          return response;
        }
      });
    }

    await use(page);

    if (testInfo.status === testInfo.expectedStatus && !page.isClosed()) {
      await checkpoint("test end");
    }
    const { laneId, steps, diagnostics, manifestFile } = await lane.finish();
    if (steps.length === 0 && diagnostics.length === 0) return;

    const firstUrl = steps[0]?.pageUrl ?? page.url();
    const slug = toSafeId(testInfo.title, "test");
    const scenario: AeeScenario = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: /^[a-z]/.test(slug) ? slug : `test-${slug}`,
      target: { url: firstUrl },
      standard: { name: "WCAG", version: "2.2", levels: ["A", "AA"] },
      profile: "playwright-test",
      goal: testInfo.title,
      journeys: [
        {
          id: "test",
          name: testInfo.titlePath.slice(1).join(" › "),
          goal: testInfo.title,
          // Absolute, so the plan resolves it even when the page is about:blank or a data: URL.
          startPath: firstUrl,
          allowedActions: [],
          forbiddenActions: []
        }
      ],
      approval: { required: true }
    };
    const actions: ScenarioActionReport[] = [];
    const findings: Array<Record<string, unknown>> = [];
    await collectPageCheckpointActions(assessmentDir, "test", { laneId, steps }, actions, findings);
    const { reportFiles } = await finishAssessment({
      assessmentId: `${scenario.id}-${Date.now()}`,
      assessmentDir,
      scenario,
      plan: compileScenarioPlan(scenario),
      startedAt,
      plannedLanes: 1,
      actions,
      findings,
      childManifestFiles: [manifestFile],
      diagnostics
    });
    await testInfo.attach("aee-report.html", { path: reportFiles.html, contentType: "text/html" });
    await testInfo.attach("aee-pr-comment.md", {
      path: reportFiles.prComment,
      contentType: "text/markdown"
    });
  },
  checkpoint: async ({ page }, use) => {
    await use(checkpoints.get(page)!);
  }
});

export { expect } from "@playwright/test";
