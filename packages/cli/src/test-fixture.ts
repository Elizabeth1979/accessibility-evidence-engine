import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { test as base, type Locator, type Page, type TestInfo } from "@playwright/test";

import {
  startPageCheckpointLane,
  toSafeId,
  type PageCheckpointLane,
  type VirtualScreenReaderCommand
} from "@aee/playwright";
import { CURRENT_SCHEMA_VERSION } from "@aee/schemas";

import { compileScenarioPlan, type AeeScenario } from "./scenario";
import {
  collectPageCheckpointActions,
  finishAssessment,
  runPageLanes,
  TEST_READER_COMMANDS,
  type AssessmentInProgress,
  type PageChecksSkipped
} from "./scenario-runner";

/** The page loads a test starts; the page is checkpointed as soon as each one returns. */
const PAGE_LOADS = ["goto", "reload", "setContent", "goBack", "goForward"] as const;

/**
 * The actions, of a page and of a locator, that can press a control: what each press shows is
 * read once the page settles, as the sweep reads its own presses.
 */
const PRESSES = ["click", "dblclick", "tap", "check", "uncheck", "setChecked", "press"] as const;

/** The lane reading the presses on each page an AEE test drives, while the test runs. */
const pressLanes = new WeakMap<Page, PageCheckpointLane>();
/** The locator prototypes whose presses are already handed to the lanes. */
const readingPrototypes = new WeakSet<object>();

/**
 * Reads the presses a test makes through a locator, as most tests do. A locator is made afresh by
 * every query and chained call, so the locators' shared prototype carries the reading, once per
 * worker; a locator on a page no AEE test is driving acts as it always does.
 */
function readLocatorPresses(page: Page): void {
  const prototype = Object.getPrototypeOf(page.locator(":root")) as Record<string, unknown>;
  if (readingPrototypes.has(prototype)) return;
  readingPrototypes.add(prototype);
  for (const method of PRESSES) {
    const act = prototype[method] as (this: Locator, ...args: unknown[]) => Promise<unknown>;
    Object.defineProperty(prototype, method, {
      configurable: true,
      writable: true,
      value: function (this: Locator, ...args: unknown[]) {
        const lane = pressLanes.get(this.page());
        return lane ? lane.press(() => act.apply(this, args)) : act.apply(this, args);
      }
    });
  }
}

/** Hands each call of an object's press methods, such as a page's clicks, to `read`. */
function readPresses<Method extends string>(
  owner: Record<Method, (...args: never[]) => Promise<unknown>>,
  methods: readonly Method[],
  read: (act: () => Promise<unknown>) => Promise<unknown>
): void {
  for (const method of methods) {
    const act = owner[method].bind(owner);
    Object.defineProperty(owner, method, {
      value: (...args: never[]) => read(() => act(...args))
    });
  }
}

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
 * races it. Each control the test presses is read for what the press shows that a screen reader
 * does not say; the fixture never presses one itself. Where a passing test ends on a page no other
 * test of the run has, that page is also swept by keyboard and mouse and read with the virtual
 * screen reader, on the test's own page. The fixture reports; it never fails a test.
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
    checkpoints.set(page, checkpoint);
    let loaded = false;
    // The test's own loads are checkpointed and its presses read; the keyboard and reader checks'
    // own, after it, are not.
    let observing = true;
    for (const method of PAGE_LOADS) {
      const load: (...args: never[]) => Promise<unknown> = page[method].bind(page);
      Object.defineProperty(page, method, {
        value: async (...args: never[]) => {
          const response = await load(...args);
          if (observing) {
            loaded = true;
            await checkpoint(`after ${method}`);
          }
          return response;
        }
      });
    }
    pressLanes.set(page, lane);
    readLocatorPresses(page);
    const read = (act: () => Promise<unknown>) => (observing ? lane.press(act) : act());
    readPresses(page, PRESSES, read);
    readPresses(page.keyboard, ["press"], read);

    await use(page);
    observing = false;
    pressLanes.delete(page);

    // A test that never loads a page, such as one that only calls `page.request`, leaves the blank
    // page every tab starts on, and checking that would report its missing title and language.
    const leftAPage = loaded || page.url() !== "about:blank";
    const passed = testInfo.status === testInfo.expectedStatus && !page.isClosed() && leftAPage;
    if (passed) await checkpoint("test end");
    const { laneId, steps, pressFindings, diagnostics, manifestFile } = await lane.finish();
    if (steps.length === 0 && diagnostics.length === 0) return;

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
      { laneId, steps, pressFindings },
      assessment.actions,
      assessment.findings
    );
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
      plannedLanes: checkInFull ? 3 : 1,
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
