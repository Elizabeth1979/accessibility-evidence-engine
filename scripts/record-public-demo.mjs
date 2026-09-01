import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium } from "@playwright/test";
import { proposeAccessibleLabelFix } from "@aee/ai-fixes";
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
  rm(path.join(outputRoot, "ai-label-suggestion.json"), { force: true })
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
  await setRecordingStage(playbackPage, "scan", "axe: icon button has no accessible name");
  await setRecordingOutcome(playbackPage, "axe-fail");
  await playbackPage.waitForTimeout(1200);
  await setRecordingStage(playbackPage, "label", "AI proposal: “Delete Project Alpha”");
  await applyPlaybackLabelFix(playbackPage);
  await setRecordingOutcome(playbackPage, "label-review");
  await playbackPage.waitForTimeout(1400);
  await setRecordingStage(playbackPage, "interact", "AEE: open the confirmation dialog");
  await setRecordingOutcome(playbackPage, "pending");
  await deleteButton.focus();
  await playbackPage.waitForTimeout(350);
  await deleteButton.click();
  await playbackPage.waitForTimeout(650);
  await setRecordingOutcome(playbackPage, "focus-fail");
  await playbackPage.waitForTimeout(1300);
  await setRecordingStage(playbackPage, "focus-fix", "Fix: move focus into the modal");
  await applyPlaybackFocusFix(playbackPage);
  await playbackPage.waitForTimeout(1100);
  await setRecordingStage(playbackPage, "verify", "Rerun the identical interaction");
  await setRecordingOutcome(playbackPage, "pending");
  await deleteButton.focus();
  await playbackPage.waitForTimeout(350);
  await deleteButton.click();
  await playbackPage.waitForTimeout(650);
  await setRecordingOutcome(playbackPage, "pass");
  await setRecordingStage(playbackPage, "complete", "Verified: focus moved inside the dialog");
  await playbackPage.waitForTimeout(1400);
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

async function writeAxeArtifact(fileName, result) {
  await writeFile(
    path.join(outputRoot, fileName),
    `${JSON.stringify(
      {
        tool: {
          name: "axe-core",
          version: result.testEngine.version
        },
        url: "./?recording=1",
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
          "AI used the project heading, trash icon, and dialog copy to suggest “Delete Project Alpha”."
      },
      "focus-fail": {
        verdict: "Fail",
        className: "verdict fail",
        title: "AEE: focus remained behind",
        summary:
          "Dialog opened. Active element: #delete-project — outside the dialog. Release blocked."
      },
      pass: {
        verdict: "Pass",
        className: "verdict pass",
        title: "Verified rerun passed",
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
