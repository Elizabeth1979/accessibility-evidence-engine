import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { proposeAccessibleLabelFix, routeContextualReview } from "@aee/ai-fixes";
import { runAeeOnPage } from "@aee/playwright";

const projectRoot = process.cwd();
const siteRoot = path.join(projectRoot, "site");
const issueRunId = "recorded-modal-focus-issue";
const fixedRunId = "recorded-modal-focus-fixed";
const outputRoot = path.join(siteRoot, "demo-artifacts");
const videoTempDir = await mkdtemp(path.join(tmpdir(), "aee-demo-video-"));
const port = Number.parseInt(process.env.AEE_DEMO_PORT ?? "4173", 10);

const contentTypes = new Map([
  [".css", "text/css; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".md", "text/markdown; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webm", "video/webm"]
]);

await Promise.all([
  rm(path.join(outputRoot, "recorded-keyboard-save"), { recursive: true, force: true }),
  rm(path.join(outputRoot, "recorded-keyboard-save-issue"), { recursive: true, force: true }),
  rm(path.join(outputRoot, "recorded-keyboard-save-fixed"), { recursive: true, force: true }),
  rm(path.join(outputRoot, issueRunId), { recursive: true, force: true }),
  rm(path.join(outputRoot, fixedRunId), { recursive: true, force: true }),
  rm(path.join(outputRoot, "axe-unnamed-icon.json"), { force: true }),
  rm(path.join(outputRoot, "axe-named-icon.json"), { force: true }),
  rm(path.join(outputRoot, "axe-open-dialog.json"), { force: true }),
  rm(path.join(outputRoot, "ai-label-suggestion.json"), { force: true }),
  rm(path.join(outputRoot, "heading-structure"), { recursive: true, force: true }),
  rm(path.join(outputRoot, "axe-heading-structure.json"), { force: true }),
  rm(path.join(outputRoot, "ai-heading-suggestion.json"), { force: true })
]);

const server = createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const relativePath = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
    const targetPath = path.resolve(siteRoot, relativePath);

    if (!targetPath.startsWith(`${siteRoot}${path.sep}`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }

    const body = await readFile(targetPath);
    response.writeHead(200, {
      "Content-Type": contentTypes.get(path.extname(targetPath)) ?? "application/octet-stream"
    });
    response.end(body);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(port, "127.0.0.1", resolve);
});

let browser;

try {
  browser = await chromium.launch({ headless: true });
  await generateAxeEvidence(browser);
  await generateReviewedAiSuggestion();
  await generateHeadingStructureStory(browser);
  const issueResult = await runEvidenceScenario(browser, {
    focusImplementation: "broken",
    runId: issueRunId,
    expectedVerdict: "fail"
  });
  const fixedResult = await runEvidenceScenario(browser, {
    focusImplementation: "fixed",
    runId: fixedRunId,
    expectedVerdict: "pass"
  });

  await normalizeRunOutput(issueRunId, issueResult.reporterFiles);
  await normalizeRunOutput(fixedRunId, fixedResult.reporterFiles);
  await assertRunVerdicts(issueRunId, "fail");
  await assertRunVerdicts(fixedRunId, "pass");

  const playbackContext = await browser.newContext({
    colorScheme: "dark",
    recordVideo: {
      dir: videoTempDir,
      size: { width: 1280, height: 720 }
    },
    viewport: { width: 1280, height: 720 }
  });
  const playbackPage = await playbackContext.newPage();
  const video = playbackPage.video();

  await prepareRecordingPage(playbackPage, { label: "missing", focus: "broken" });
  const deleteButton = playbackPage.locator("#delete-project");
  await deleteButton.focus();
  await setRecordingStage(playbackPage, "scan", "BEFORE — icon button has no accessible name");
  await setRecordingOutcome(playbackPage, "axe-fail");
  await playbackPage.waitForTimeout(2500);
  await setRecordingStage(playbackPage, "label", "REVIEW — icon meaning requires context");
  await applyPlaybackLabelFix(playbackPage);
  await setRecordingOutcome(playbackPage, "label-review");
  await playbackPage.waitForTimeout(3000);
  await setRecordingStage(playbackPage, "interact", "BEFORE — test the broken focus behavior");
  await setRecordingOutcome(playbackPage, "before-run");
  await deleteButton.focus();
  await playbackPage.waitForTimeout(600);
  await deleteButton.click();
  await playbackPage.waitForTimeout(900);
  await setRecordingOutcome(playbackPage, "focus-fail");
  await playbackPage.waitForTimeout(3200);
  await setRecordingStage(playbackPage, "focus-fix", "FIX — move focus into the modal");
  await applyPlaybackFocusFix(playbackPage);
  await setRecordingOutcome(playbackPage, "fix-review");
  await playbackPage.waitForTimeout(2600);
  await setRecordingStage(playbackPage, "verify", "AFTER — rerun the identical interaction");
  await setRecordingOutcome(playbackPage, "after-run");
  await deleteButton.focus();
  await playbackPage.waitForTimeout(600);
  await deleteButton.click();
  await playbackPage.waitForTimeout(900);
  await setRecordingOutcome(playbackPage, "pass");
  await setRecordingStage(playbackPage, "complete", "AFTER — focus moved inside the dialog");
  await playbackPage.waitForTimeout(3200);
  await playbackContext.close();

  if (!video) {
    throw new Error("Playwright did not create a video for the public demo.");
  }

  const recordedVideoPath = await video.path();
  const webmPath = path.join(outputRoot, "playwright-aee-demo.webm");
  const mp4Path = path.join(outputRoot, "playwright-aee-demo.mp4");
  await writeFile(webmPath, await readFile(recordedVideoPath));
  await rm(mp4Path, { force: true });

  try {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-loglevel",
        "error",
        "-i",
        webmPath,
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-movflags",
        "+faststart",
        mp4Path
      ],
      { stdio: "inherit" }
    );
  } catch {
    console.warn("ffmpeg is unavailable; the WebM recording was still generated.");
  }

  console.log(
    `Recorded public demo and AEE evidence in ${path.relative(projectRoot, outputRoot)}.`
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(videoTempDir, { recursive: true, force: true });
}

async function generateAxeEvidence(activeBrowser) {
  const context = await activeBrowser.newContext({
    colorScheme: "dark",
    viewport: { width: 1280, height: 720 }
  });

  try {
    const page = await context.newPage();
    await prepareRecordingPage(page, { label: "missing", focus: "broken" });
    const unnamedResult = await new AxeBuilder({ page }).withRules(["button-name"]).analyze();
    const buttonNameViolation = unnamedResult.violations.find(
      (violation) => violation.id === "button-name"
    );

    if (!buttonNameViolation?.nodes.some((node) => node.target.includes("#delete-project"))) {
      throw new Error("Expected axe to find the unnamed delete icon button.");
    }

    await writeAxeArtifact("axe-unnamed-icon.json", unnamedResult);
    await page.locator("#delete-project").evaluate((button) => {
      button.setAttribute("aria-label", "Delete Project Alpha");
    });
    const namedResult = await new AxeBuilder({ page }).withRules(["button-name"]).analyze();

    if (namedResult.violations.some((violation) => violation.id === "button-name")) {
      throw new Error("Expected axe button-name to pass after applying the contextual label.");
    }

    await writeAxeArtifact("axe-named-icon.json", namedResult);
    await page.getByRole("button", { name: "Delete Project Alpha" }).click();
    const openDialogResult = await new AxeBuilder({ page })
      .withRules(["button-name", "aria-dialog-name"])
      .analyze();

    if (openDialogResult.violations.length > 0) {
      throw new Error(
        `Expected the named open-dialog state to pass the selected axe rules: ${openDialogResult.violations.map((violation) => violation.id).join(", ")}`
      );
    }

    await writeAxeArtifact("axe-open-dialog.json", openDialogResult);
  } finally {
    await context.close();
  }
}

async function generateReviewedAiSuggestion() {
  const labelContext = {
    selector: "#delete-project",
    role: "button",
    iconDescription: "trash can",
    nearbyHeading: "Project Alpha",
    nearbyText: "Production workspace",
    destinationText: "Delete Project Alpha? This action cannot be undone."
  };
  const routing = routeContextualReview({
    kind: "icon-label",
    hasAccessibleName: false,
    isIconOnly: true,
    contextSignals: ["trash can icon", "Project Alpha heading", "destructive dialog copy"]
  });
  const fix = await proposeAccessibleLabelFix(labelContext, {
    id: "codex-reviewed-demo-suggestion",
    async suggestLabel() {
      return {
        label: "Delete Project Alpha",
        rationale:
          "The trash icon, Project Alpha heading, and matching destructive confirmation copy establish the control's purpose and object.",
        confidence: 0.96
      };
    }
  });

  await writeFile(
    path.join(outputRoot, "ai-label-suggestion.json"),
    `${JSON.stringify(
      {
        schemaVersion: "0.1.0",
        generation: {
          mode: "reviewed-demo-example",
          liveModelCall: false,
          note: "This checked-in proposal was authored with Codex and reviewed for the public demo. CI does not receive API credentials. The @aee/ai-fixes package supports live, injected model providers."
        },
        routing,
        context: labelContext,
        proposal: fix,
        verificationRequired: true
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function generateHeadingStructureStory(activeBrowser) {
  const context = await activeBrowser.newContext({
    colorScheme: "dark",
    viewport: { width: 1120, height: 660 },
    deviceScaleFactor: 1
  });
  const headingOutput = path.join(outputRoot, "heading-structure");
  await mkdir(headingOutput, { recursive: true });

  try {
    const page = await context.newPage();
    await page.setContent(headingStoryMarkup("visual"));
    const axeResult = await new AxeBuilder({ page })
      .withRules(["heading-order", "page-has-heading-one", "empty-heading"])
      .analyze();

    if (axeResult.violations.length > 0) {
      throw new Error(
        `Expected the intentionally valid heading sequence to pass selected axe rules: ${axeResult.violations.map((violation) => violation.id).join(", ")}`
      );
    }

    await writeAxeArtifact("axe-heading-structure.json", axeResult, "./#heading-demo");
    await page.locator("#story-frame").screenshot({
      path: path.join(headingOutput, "01-visual-page.png")
    });

    await page.setContent(headingStoryMarkup("axe"));
    await page.locator("#story-frame").screenshot({
      path: path.join(headingOutput, "02-axe-result.png")
    });

    const routing = routeContextualReview({
      kind: "heading-structure",
      hasFullPageContext: true,
      needsSemanticOutline: true
    });

    if (routing.route !== "ai-review") {
      throw new Error("Expected the full-page heading example to cross the AI review boundary.");
    }

    const suggestion = {
      safety: "review",
      summary: "Promote the visual Settings label to h2 and nest its three sections at h3.",
      rationale:
        "The full-page layout presents Settings as the parent of General, Members, and Danger zone. The existing DOM outline omits that relationship.",
      before: ["h1 Project Alpha", "h2 General", "h2 Members", "h2 Danger zone"],
      after: [
        "h1 Project Alpha",
        "  h2 Settings",
        "    h3 General",
        "    h3 Members",
        "    h3 Danger zone"
      ],
      verificationRequired: true
    };

    await writeFile(
      path.join(outputRoot, "ai-heading-suggestion.json"),
      `${JSON.stringify(
        {
          schemaVersion: "0.1.0",
          generation: {
            mode: "reviewed-demo-example",
            liveModelCall: false,
            note: "This checked-in contextual outline was authored with Codex and reviewed for the public demo. It is not an automated conformance verdict."
          },
          routing,
          context: {
            pageTitle: "Project Alpha",
            visualParent: "Settings",
            visualChildren: ["General", "Members", "Danger zone"],
            domOutline: suggestion.before
          },
          proposal: suggestion
        },
        null,
        2
      )}\n`,
      "utf8"
    );

    await page.setContent(headingStoryMarkup("aee"));
    await page.locator("#story-frame").screenshot({
      path: path.join(headingOutput, "03-aee-suggestion.png")
    });
  } finally {
    await context.close();
  }
}

function headingStoryMarkup(stage) {
  const stageContent = {
    visual: `
      <div class="callout amber">Visual relationship</div>
      <h2>“Settings” looks like the parent section</h2>
      <p class="explanation">The layout groups three subsections beneath it. That relationship should also exist in the heading outline.</p>`,
    axe: `
      <div class="callout green">axe-core · Pass</div>
      <h2>Selected automatic heading rules find no violation</h2>
      <div class="outline"><strong>DOM outline</strong><code>H1  Project Alpha</code><code>H2  General</code><code>H2  Members</code><code>H2  Danger zone</code></div>
      <p class="explanation">There is an H1, no heading is empty, and levels never skip. The visual parent is not encoded as a heading.</p>`,
    aee: `
      <div class="callout amber">AEE · Review required</div>
      <h2>Full-page context reveals the missing parent</h2>
      <div class="outline proposed"><strong>Proposed outline</strong><code>H1  Project Alpha</code><code>  H2  Settings</code><code>    H3  General</code><code>    H3  Members</code><code>    H3  Danger zone</code></div>
      <p class="explanation">AI proposes the semantic relationship; a person reviews it and a new scan verifies the accepted change.</p>`
  };

  return `<!doctype html>
    <html lang="en"><head><meta charset="utf-8"><style>
      * { box-sizing: border-box; }
      body { margin: 0; padding: 20px; background: #07110e; color: #f5fbf8; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      #story-frame { width: 1080px; height: 620px; display: grid; grid-template-columns: 1.08fr .92fr; gap: 20px; padding: 26px; border: 1px solid #29463d; border-radius: 20px; background: linear-gradient(145deg, #0d1d18, #09130f); }
      .browser { overflow: hidden; border: 1px solid #36584d; border-radius: 14px; background: #f6f2e9; color: #1b2824; }
      .chrome { display: flex; gap: 7px; height: 34px; padding: 13px; background: #d9d4ca; }
      .chrome i { width: 8px; height: 8px; border-radius: 50%; background: #8e8a82; }
      .page { padding: 26px; }
      .page h1 { margin: 0 0 8px; font-size: 30px; }
      .lede { margin: 0 0 24px; color: #65706b; }
      .visual-heading { position: relative; margin-bottom: 14px; padding: 13px 15px; border: 3px solid #d99017; border-radius: 10px; background: #fff9e8; font-size: 22px; font-weight: 800; }
      .visual-heading::after { content: "styled <div>, not a heading"; position: absolute; right: 10px; top: 12px; padding: 5px 8px; border-radius: 20px; background: #452e06; color: #ffe5a1; font-size: 11px; }
      .cards { display: grid; gap: 10px; }
      article { padding: 13px 15px; border: 1px solid #d6d1c7; border-radius: 10px; background: #fff; }
      article h2 { margin: 0 0 3px; font-size: 17px; }
      article p { margin: 0; color: #68736e; font-size: 13px; }
      .analysis { display: flex; flex-direction: column; justify-content: center; padding: 8px 12px; }
      .analysis h2 { margin: 16px 0 10px; font-size: 27px; line-height: 1.12; }
      .callout { align-self: flex-start; padding: 7px 10px; border-radius: 999px; font-size: 12px; font-weight: 850; letter-spacing: .08em; text-transform: uppercase; }
      .amber { background: #3b2c08; color: #ffd76a; }
      .green { background: #0b3a29; color: #70f0b4; }
      .explanation { color: #a9bbb4; line-height: 1.45; }
      .outline { display: grid; gap: 7px; margin: 6px 0 14px; padding: 15px; border: 1px solid #38584d; border-radius: 11px; background: #07110e; }
      .outline strong { margin-bottom: 4px; color: #8fa39b; font-size: 12px; letter-spacing: .08em; text-transform: uppercase; }
      .outline code { color: #e9f5f0; font: 700 15px/1.2 ui-monospace, SFMono-Regular, monospace; white-space: pre; }
      .proposed { border-color: #97721e; background: #181505; }
    </style></head><body>
      <div id="story-frame">
        <div class="browser"><div class="chrome"><i></i><i></i><i></i></div><main class="page">
          <h1>Project Alpha</h1><p class="lede">Manage the people and configuration for this workspace.</p>
          <div class="visual-heading">Settings</div>
          <div class="cards">
            <article><h2>General</h2><p>Workspace name, description, and visibility</p></article>
            <article><h2>Members</h2><p>Roles, invitations, and access</p></article>
            <article><h2>Danger zone</h2><p>Archive or permanently delete this workspace</p></article>
          </div>
        </main></div>
        <section class="analysis">${stageContent[stage]}</section>
      </div>
    </body></html>`;
}

async function writeAxeArtifact(fileName, result, artifactUrl = "./?recording=1") {
  await writeFile(
    path.join(outputRoot, fileName),
    `${JSON.stringify(
      {
        tool: {
          name: "axe-core",
          version: result.testEngine.version
        },
        url: artifactUrl,
        timestamp: result.timestamp,
        testEnvironment: result.testEnvironment,
        testRunner: result.testRunner,
        passes: result.passes,
        incomplete: result.incomplete,
        violations: result.violations
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

async function runEvidenceScenario(activeBrowser, options) {
  const context = await activeBrowser.newContext({
    colorScheme: "dark",
    viewport: { width: 1280, height: 720 }
  });

  try {
    const page = await context.newPage();
    await prepareRecordingPage(page, { label: "fixed", focus: options.focusImplementation });
    await page.getByRole("button", { name: "Delete Project Alpha" }).focus();

    return await runAeeOnPage({
      page,
      projectRoot,
      outputDir: "site/demo-artifacts",
      runId: options.runId,
      observers: ["dom", "focus", "visual"],
      judges: ["focus-management", "change-response", "release"],
      checkpointName: `public-demo-modal-focus-${options.focusImplementation}`,
      policy: {
        name: "public-demo",
        capture: {
          stabilizeAfterInteractionMs: 500
        }
      },
      interaction: {
        kind: "click",
        actor: "test",
        target: {
          role: "button",
          name: "Delete Project Alpha"
        },
        meta: {
          focusExpectation: "inside-dialog"
        }
      },
      async performInteraction({ page: activePage }) {
        await activePage.getByRole("button", { name: "Delete Project Alpha" }).click();
      }
    });
  } finally {
    await context.close();
  }
}

async function prepareRecordingPage(page, options) {
  const parameters = new URLSearchParams({
    recording: "1",
    label: options.label,
    focus: options.focus
  });
  await page.goto(`http://127.0.0.1:${port}/?${parameters}`, {
    waitUntil: "domcontentloaded"
  });
  await page.locator("#recorded-title").evaluate((heading) => {
    const activeWindow = heading.ownerDocument.defaultView;
    heading.ownerDocument.documentElement.style.scrollBehavior = "auto";
    activeWindow?.scrollTo({
      top: heading.getBoundingClientRect().top + (activeWindow.scrollY ?? 0) - 24
    });
  });
}

async function setRecordingStage(page, stage, message) {
  await page.locator("#recording-progress").evaluate(
    (progress, { activeStage, activeMessage }) => {
      const orderedStages = ["scan", "label", "interact", "focus-fix", "verify"];
      const activeIndex =
        activeStage === "complete" ? orderedStages.length : orderedStages.indexOf(activeStage);
      const activeDocument = progress.ownerDocument;
      activeDocument.body.dataset.recordingStage = activeStage;

      const messageNode = progress.querySelector("#recording-message");
      if (messageNode) {
        messageNode.textContent = activeMessage;
      }

      for (const step of progress.querySelectorAll("[data-recording-step]")) {
        const stepIndex = orderedStages.indexOf(step.dataset.recordingStep ?? "");
        step.dataset.state =
          stepIndex < activeIndex ? "complete" : stepIndex === activeIndex ? "active" : "pending";
      }
    },
    { activeStage: stage, activeMessage: message }
  );
}

async function setRecordingOutcome(page, outcome) {
  await page.locator("#recording-result").evaluate((result, activeOutcome) => {
    const verdict = result.querySelector("#recording-verdict");
    const title = result.querySelector("#recording-result-title");
    const summary = result.querySelector("#recording-result-summary");

    const outcomes = {
      pending: {
        verdict: "Running",
        className: "verdict pending",
        title: "Waiting for evidence",
        summary: "Playwright is exercising the icon-button and modal workflow."
      },
      "before-run": {
        verdict: "Before",
        className: "verdict fail",
        title: "Opening the dialog before the focus fix",
        summary: "Watch the focus indicator: it should enter the dialog, but remains on Delete."
      },
      "axe-fail": {
        verdict: "Fail",
        className: "verdict fail",
        title: "axe: button-name",
        summary: "The trash icon button has no accessible name. Static detection is the baseline."
      },
      "label-review": {
        verdict: "Review",
        className: "verdict review",
        title: "Contextual label proposed",
        summary:
          "Escalated: this icon-only control needs the project heading and dialog copy. AI suggests “Delete Project Alpha”."
      },
      "focus-fail": {
        verdict: "Fail",
        className: "verdict fail",
        title: "Before: focus remained behind",
        summary:
          "Dialog opened. Active element: #delete-project — outside the dialog. Release blocked."
      },
      "fix-review": {
        verdict: "Fix",
        className: "verdict review",
        title: "Move focus when the dialog opens",
        summary: "Applied: cancelButton.focus(). Now rerun the identical click to verify it."
      },
      "after-run": {
        verdict: "After",
        className: "verdict pending",
        title: "Rerunning after the focus fix",
        summary: "The same Delete action opens the same dialog with the repaired implementation."
      },
      pass: {
        verdict: "Pass",
        className: "verdict pass",
        title: "After: focus enters the dialog",
        summary:
          "Same click. Active element: #cancel-delete — inside the dialog. Release gate passed."
      }
    };
    const selected = outcomes[activeOutcome];

    if (verdict && title && summary && selected) {
      verdict.textContent = selected.verdict;
      verdict.className = selected.className;
      title.textContent = selected.title;
      summary.textContent = selected.summary;
    }
  }, outcome);
}

async function applyPlaybackLabelFix(page) {
  await page.locator("#delete-project").evaluate((button) => {
    button.setAttribute("aria-label", "Delete Project Alpha");
  });
}

async function applyPlaybackFocusFix(page) {
  await page.locator("#delete-project").evaluate((button) => {
    const activeDocument = button.ownerDocument;
    const dialog = activeDocument.querySelector("#delete-dialog");
    const cancelButton = activeDocument.querySelector("#cancel-delete");
    const focusStatus = activeDocument.querySelector("#real-focus");
    dialog.hidden = true;
    button.focus();
    focusStatus.textContent = "Delete button";
    button.addEventListener("click", () => {
      cancelButton.focus();
      focusStatus.textContent = "Cancel inside dialog";
    });
  });
}

async function normalizeRunOutput(activeRunId, reporterFiles) {
  const runOutput = path.join(outputRoot, activeRunId);
  await normalizePublishedPaths([
    ...reporterFiles,
    path.join(runOutput, "bundle.json"),
    path.join(runOutput, "run.json")
  ]);
}

async function assertRunVerdicts(activeRunId, expectedVerdict) {
  const reportPath = path.join(outputRoot, activeRunId, "aee-report.json");
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const verdicts = Object.fromEntries(
    report.judgments.map((judgment) => [judgment.judgeId, judgment.verdict])
  );

  if (
    report.run.status !== "completed" ||
    verdicts["focus-management"] !== expectedVerdict ||
    verdicts["change-response"] !== "pass" ||
    verdicts.release !== expectedVerdict
  ) {
    throw new Error(
      `Unexpected ${activeRunId} verdicts: expected ${expectedVerdict}, received ${JSON.stringify(verdicts)}`
    );
  }
}

async function normalizePublishedPaths(filePaths) {
  for (const filePath of filePaths) {
    const content = await readFile(filePath, "utf8");
    await writeFile(
      filePath,
      content.replaceAll(projectRoot, ".").replaceAll(`http://127.0.0.1:${port}/`, "./"),
      "utf8"
    );
  }
}
