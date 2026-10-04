import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { test as base, type Page, type TestInfo } from "@playwright/test";

import {
  observePresses,
  startPageCheckpointLane,
  toSafeId,
  type VirtualScreenReaderCommand
} from "@aee/playwright";
import { CURRENT_SCHEMA_VERSION } from "@aee/schemas";

import { compileScenarioPlan, type AeeScenario } from "./scenario";
import {
  collectPageCheckpointActions,
  finishAssessment,
  recordObservedPresses,
  runPageLanes,
  TEST_READER_COMMANDS,
  type AssessmentInProgress,
  type PageChecksSkipped
} from "./scenario-runner";

/** The page loads a test starts; the page is checkpointed as soon as each one returns. */
const PAGE_LOADS = ["goto", "reload", "setContent", "goBack", "goForward"] as const;

/**
 * The presses a test makes, which AEE watches, as what each says the test does. A locator's and the
 * page's own presses go through the main frame; one inside an iframe goes unread, as the watch is
 * on the page's own document.
 */
const FRAME_PRESSES: Record<string, (args: unknown[]) => string> = {
  click: () => "Clicking",
  dblclick: () => "Double-clicking",
  tap: () => "Tapping",
  press: (args) => `Pressing ${String(args[1])} on`,
  check: () => "Checking",
  uncheck: () => "Unchecking",
  setChecked: (args) => (args[1] ? "Checking" : "Unchecking")
};
const KEYBOARD_PRESSES: Record<string, (args: unknown[]) => string> = {
  press: (args) => `Pressing ${String(args[0])} on`
};
const MOUSE_PRESSES: Record<string, (args: unknown[]) => string> = {
  click: () => "Clicking",
  dblclick: () => "Double-clicking"
};
/** The test's other actions, each of which ends the watch on the press before it. */
const FRAME_ACTIONS = [
  "fill",
  "type",
  "hover",
  "selectOption",
  "setInputFiles",
  "focus",
  "dragAndDrop"
];

/**
 * The time the keyboard and reader checks get, on top of the test's own: they run once the test has
 * passed, so a test is never failed because its time ran out while AEE checked its page.
 */
const PAGE_CHECK_TIME_MS = 180_000;

export interface AeeTestOptions {
  aee: {
    /**
     * Sweep by keyboard and mouse, and read with the virtual screen reader, each page a passing
     * test ends on: once per page in a run, on the test's own page, so it keeps the test's session
     * and routes. On unless set to false, for example with `test.use({ aee: { keyboardAndReader:
     * false } })`.
     */
    keyboardAndReader: boolean;
  };
}

export interface AeeTestFixtures {
  /**
   * Checkpoints the page as it is now, for a state no page load reaches, such as an open dialog.
   * Page loads and the end of the test are checkpointed on their own.
   */
  checkpoint: (name: string) => Promise<void>;
}

const checkpoints = new WeakMap<Page, (name: string) => Promise<void>>();

/**
 * Whether a page is on the web, unlike about:blank, a data: or a file: URL: the keyboard and reader
 * checks keep their navigations to the page's origin.
 */
function onTheWeb(address: string): boolean {
  const { protocol } = new URL(address);
  return protocol === "http:" || protocol === "https:";
}

/**
 * Claims a web page for its once-per-run keyboard and reader checks: false when another test of the
 * run already has. A page is its address without query or fragment. Claims live in the run's
 * output folder, which Playwright empties when a run starts, so every worker sees them and the next
 * run starts afresh.
 */
async function claimPageForRun(testInfo: TestInfo, address: string): Promise<boolean> {
  const url = new URL(address);
  const page = `${url.protocol}//${url.host}${url.pathname}`;
  const claims = path.join(testInfo.project.outputDir, ".aee-checked-pages");
  await mkdir(claims, { recursive: true });
  try {
    const claim = path.join(claims, createHash("sha256").update(page).digest("hex"));
    await writeFile(claim, `${page}\n`, { flag: "wx" });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
}

/**
 * Playwright's `test` with AEE checkpoints. Swap `@playwright/test` for `@aee/cli/test` in a
 * spec's import and nothing else: each page load the test starts, and the page as the test leaves
 * it, is checked like an `aee run` checkpoint, and the test gets the same report and PR comment,
 * attached to its results. A checkpoint waits for the page load that started it, so the test never
 * races it. Where a passing test ends on a page no other test of the run has, that page is also
 * swept by keyboard and mouse and read with the virtual screen reader, on the test's own page. The
 * fixture reports; it never fails a test.
 */
export const test = base.extend<AeeTestFixtures & AeeTestOptions>({
  aee: [{ keyboardAndReader: true }, { option: true }],
  page: async ({ page, aee }, use, testInfo) => {
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
    let loaded = false;
    // The test's own loads and presses are observed; the keyboard and reader checks', after it, not.
    let observing = true;
    // Each press the test makes is watched until its next action, page load or checkpoint.
    const presses = observePresses(page);
    checkpoints.set(page, async (name) => {
      await presses.stop();
      await checkpoint(name);
    });
    for (const method of PAGE_LOADS) {
      const load: (...args: never[]) => Promise<unknown> = page[method].bind(page);
      Object.defineProperty(page, method, {
        value: async (...args: never[]) => {
          if (observing) await presses.stop();
          const response = await load(...args);
          if (observing) {
            loaded = true;
            await checkpoint(`after ${method}`);
          }
          return response;
        }
      });
    }
    // An action that makes another, as setChecked makes a check, is watched once.
    let acting = false;
    const watch = (
      target: object,
      actions: Record<string, ((args: unknown[]) => string) | undefined>
    ) => {
      for (const [method, verb] of Object.entries(actions)) {
        const original = (target as Record<string, (...args: unknown[]) => Promise<unknown>>)[
          method
        ]!.bind(target);
        Object.defineProperty(target, method, {
          value: async (...args: unknown[]) => {
            if (!observing || acting) return original(...args);
            acting = true;
            try {
              if (verb) await presses.start(verb(args));
              else await presses.stop();
              return await original(...args);
            } finally {
              acting = false;
            }
          }
        });
      }
    };
    watch(page.mainFrame(), {
      ...FRAME_PRESSES,
      ...Object.fromEntries(FRAME_ACTIONS.map((method) => [method, undefined]))
    });
    watch(page.keyboard, KEYBOARD_PRESSES);
    watch(page.mouse, MOUSE_PRESSES);

    await use(page);
    if (!page.isClosed()) await presses.stop();
    observing = false;

    // A test that never loads a page, such as one that only calls `page.request`, leaves the blank
    // page every tab starts on, and checking that would report its missing title and language.
    const leftAPage = loaded || page.url() !== "about:blank";
    const passed = testInfo.status === testInfo.expectedStatus && !page.isClosed() && leftAPage;
    if (passed) await checkpoint("test end");
    const { laneId, steps, diagnostics, manifestFile } = await lane.finish();
    if (steps.length === 0 && diagnostics.length === 0) return;
    const observed = presses.result();

    const firstUrl = steps[0]?.pageUrl ?? page.url();
    const endUrl = page.url();
    // Why this test's page is not checked by keyboard and with the reader, if it is not.
    const skipped: PageChecksSkipped | undefined = !aee.keyboardAndReader
      ? "turned-off"
      : testInfo.status !== testInfo.expectedStatus
        ? "test-did-not-pass"
        : page.isClosed() || !onTheWeb(endUrl)
          ? "no-web-page"
          : (await claimPageForRun(testInfo, endUrl))
            ? undefined
            : "checked-in-another-test";
    const checkInFull = skipped === undefined;
    const assessment: AssessmentInProgress = {
      assessmentDir,
      childManifestFiles: [manifestFile],
      actions: [],
      findings: [],
      diagnostics
    };
    await collectPageCheckpointActions(
      assessmentDir,
      "test",
      { laneId, steps },
      assessment.actions,
      assessment.findings
    );
    if (observed.pressed.length > 0) {
      await recordObservedPresses(assessment, {
        journeyId: "test",
        targetUrl: endUrl,
        startedAt,
        observed
      });
    }
    let readerCommands: VirtualScreenReaderCommand[] = [];
    if (checkInFull) {
      // A timeout of 0 is no timeout.
      if (testInfo.timeout > 0) testInfo.setTimeout(testInfo.timeout + PAGE_CHECK_TIME_MS);
      ({ readerCommands } = await base.step(
        "AEE: keyboard and screen reader",
        () =>
          runPageLanes(assessment, {
            target: { page },
            journeyId: "test",
            startUrl: endUrl,
            allowedOrigins: [endUrl],
            activateControls: false,
            commands: TEST_READER_COMMANDS,
            stopAtEnd: true
          }),
        { box: true }
      ));
    }

    const slug = toSafeId(testInfo.title, "test");
    const scenario: AeeScenario = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      id: /^[a-z]/.test(slug) ? slug : `test-${slug}`,
      name: testInfo.title,
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
          forbiddenActions: [],
          // The plan lists the reader's moves that ran, so a page read to its end is complete.
          ...(checkInFull ? { virtualScreenReaderCommands: readerCommands } : {})
        }
      ],
      approval: { required: true }
    };
    const { headline, reportFiles } = await finishAssessment({
      assessmentId: `${scenario.id}-${Date.now()}`,
      scenario,
      plan: compileScenarioPlan(scenario),
      startedAt,
      plannedLanes: (checkInFull ? 3 : 1) + (observed.pressed.length > 0 ? 1 : 0),
      pageChecksSkipped: skipped,
      ...assessment
    });
    await testInfo.attach("aee-report.html", { path: reportFiles.html, contentType: "text/html" });
    await testInfo.attach("aee-pr-comment.md", {
      path: reportFiles.prComment,
      contentType: "text/markdown"
    });
    await testInfo.attach("aee-fixes.csv", { path: reportFiles.csv, contentType: "text/csv" });
    // The test passes or fails on its own assertions, so say where its accessibility verdict is.
    console.log(`AEE: ${headline}. Report: ${path.relative(process.cwd(), reportFiles.html)}`);
  },
  checkpoint: async ({ page }, use) => {
    await use(checkpoints.get(page)!);
  }
});

// With Playwright's types, such as `Page`, so swapping a spec's import is the only change. `expect`
// is named, not starred: an ES module importing this CommonJS file sees only the names it spells out.
export { expect } from "@playwright/test";
export type * from "@playwright/test";
