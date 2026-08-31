import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "@playwright/test";
import { runAeeOnPage } from "@aee/playwright";

const projectRoot = process.cwd();
const siteRoot = path.join(projectRoot, "site");
const issueRunId = "recorded-keyboard-save-issue";
const fixedRunId = "recorded-keyboard-save-fixed";
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
  rm(path.join(outputRoot, issueRunId), { recursive: true, force: true }),
  rm(path.join(outputRoot, fixedRunId), { recursive: true, force: true })
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
  const issueResult = await runEvidenceScenario(browser, {
    implementation: "broken",
    runId: issueRunId,
    expectedVerdict: "fail"
  });
  const fixedResult = await runEvidenceScenario(browser, {
    implementation: "fixed",
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

  await prepareRecordingPage(playbackPage, "broken");
  await setRecordingStage(playbackPage, "reproduce", "Reproduce: Enter produces no response");
  await setRecordingOutcome(playbackPage, "pending");
  await playbackPage.waitForTimeout(700);

  const saveButton = playbackPage.getByRole("button", { name: "Save changes" });
  await saveButton.focus();
  await playbackPage.waitForTimeout(400);
  await playbackPage.keyboard.press("Enter");
  await playbackPage.waitForTimeout(650);
  await setRecordingStage(playbackPage, "detected", "AEE detects the missing response");
  await setRecordingOutcome(playbackPage, "fail");
  await playbackPage.waitForTimeout(1100);
  await setRecordingStage(playbackPage, "fix", "Fix: add the missing click handler");
  await applyPlaybackFix(playbackPage);
  await playbackPage.waitForTimeout(900);
  await setRecordingStage(playbackPage, "rerun", "Rerun the same Enter interaction");
  await setRecordingOutcome(playbackPage, "pending");
  await saveButton.focus();
  await playbackPage.waitForTimeout(350);
  await playbackPage.keyboard.press("Enter");
  await playbackPage.waitForTimeout(650);
  await setRecordingOutcome(playbackPage, "pass");
  await setRecordingStage(playbackPage, "complete", "Fixed: the rerun now passes");
  await playbackPage.waitForTimeout(1300);
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

async function runEvidenceScenario(activeBrowser, options) {
  const context = await activeBrowser.newContext({
    colorScheme: "dark",
    viewport: { width: 1280, height: 720 }
  });

  try {
    const page = await context.newPage();
    await prepareRecordingPage(page, options.implementation);
    await page.getByRole("button", { name: "Save changes" }).focus();

    return await runAeeOnPage({
      page,
      projectRoot,
      outputDir: "site/demo-artifacts",
      runId: options.runId,
      observers: ["dom", "focus", "visual"],
      judges: ["keyboard", "change-response", "release"],
      checkpointName: `public-demo-${options.implementation}`,
      policy: {
        name: "public-demo",
        capture: {
          stabilizeAfterInteractionMs: 500
        }
      },
      interaction: {
        kind: "enter",
        input: "Enter",
        actor: "test",
        target: {
          role: "button",
          name: "Save changes"
        }
      },
      async performInteraction({ page: activePage }) {
        await activePage.keyboard.press("Enter");
      }
    });
  } finally {
    await context.close();
  }
}

async function prepareRecordingPage(page, implementation) {
  await page.goto(`http://127.0.0.1:${port}/?recording=1&implementation=${implementation}`, {
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
      const orderedStages = ["reproduce", "detected", "fix", "rerun"];
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
        summary: "Playwright is exercising the focused Save changes button with Enter."
      },
      fail: {
        verdict: "Fail",
        className: "verdict fail",
        title: "Issue reproduced",
        summary: "AEE observed no DOM or focus response after Enter. The release gate is blocked."
      },
      pass: {
        verdict: "Pass",
        className: "verdict pass",
        title: "Fixed rerun passed",
        summary: "The same Enter interaction now changes the visible status from Idle to Saved."
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

async function applyPlaybackFix(page) {
  await page.locator("#real-save").evaluate((button) => {
    const status = button.ownerDocument.querySelector("#real-status");
    status.textContent = "Idle";
    button.classList.remove("saved");
    button.addEventListener(
      "click",
      () => {
        status.textContent = "Saved";
        button.classList.add("saved");
      },
      { once: true }
    );
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
    verdicts.keyboard !== expectedVerdict ||
    verdicts["change-response"] !== expectedVerdict ||
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
    await writeFile(filePath, content.replaceAll(projectRoot, "."), "utf8");
  }
}
