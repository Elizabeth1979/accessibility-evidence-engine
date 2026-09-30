import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { chromium, expect, test, type Page } from "@playwright/test";
import { marked } from "marked";

import { aeeRunModelProvider } from "@aee/cli";

import { serveDirectory, startHtmlServer } from "./scenario-helpers";
import { contract, readerWalk, runOnLabPage } from "./test-lab-helpers";

// `npm run site:shots` regenerates site/shots from a real run of the test lab's demo page, so no
// shot is hand-made or stale. site/features.json says what each shot shows; the homepage's
// feature cards are generated from the same file.
const shotsDir = path.resolve("site", "shots");
/** Slows every browser step, so the recorded sweep moves at a pace a person can follow. */
const WATCHABLE_SLOW_MO_MS = 800;
const HIGHLIGHT_COLOR = "#c2185b";

interface Shot {
  /** The report tab the shot is on, or the run's pull-request comment. */
  panel: "overview" | "page" | "findings" | "comment";
  /** The shot is the smallest box around all of these, highlighted. */
  targets: string[];
}

interface Feature {
  id: string;
  shot?: Shot;
  video?: { file: string; captions?: string; text: string };
}

const { features } = JSON.parse(readFileSync("site/features.json", "utf8")) as {
  features: Feature[];
};

test("product shots and videos come from a real run of the demo page", async ({
  page
}, testInfo) => {
  await rm(shotsDir, { recursive: true, force: true });
  await mkdir(shotsDir, { recursive: true });

  const browser = await chromium.launch({ slowMo: WATCHABLE_SLOW_MO_MS });
  // AEE_LLM_PROVIDER names the model, as for `aee run`: the Pages deploy names one.
  const aiProvider = aeeRunModelProvider();
  const run = await runOnLabPage(
    browser,
    contract.pages.issues,
    ["focus", "hover", "activate-page-controls"],
    testInfo,
    { readerCommands: readerWalk, aiProvider }
  ).finally(() => browser.close());
  // With a model named, the AI card shows its answer, never a note on how to turn AI on; a failure
  // says why, from the notes that carry the model's error.
  const buttonAi = run.report.synthesis.findings.find(({ ruleId }) => ruleId === "button-name")
    ?.remediation.ai;
  expect(buttonAi?.status, buttonAi?.notes?.join("\n")).toBe(
    aiProvider.id === "stub" ? "not-configured" : "suggested"
  );
  // The whole run is the sample report the feature cards link to.
  await cp(run.outputDir, path.join(shotsDir, "report"), { recursive: true });

  // The keyboard video is the sweep lane's own recording, with its step-by-step descriptions.
  const sweepFile = (kind: string) => {
    const artifact = run.report.artifacts.find(
      (candidate) =>
        candidate.kind === kind && candidate.provenance?.laneId?.endsWith("-keyboard-pointer-sweep")
    );
    expect(artifact, `the sweep lane's ${kind}`).toBeTruthy();
    return path.join(run.outputDir, artifact!.path);
  };
  const captions = await readFile(sweepFile("video-captions"), "utf8");
  await copyFile(sweepFile("interaction-video"), path.join(shotsDir, "keyboard.webm"));
  await writeFile(path.join(shotsDir, "keyboard.vtt"), captions, "utf8");
  await writeFile(path.join(shotsDir, "keyboard.txt"), stepsFromCaptions(captions), "utf8");

  const commentFile = testInfo.outputPath("pr-comment.html");
  await writeFile(
    commentFile,
    commentPage(await readFile(path.join(run.outputDir, "aee-pr-comment.md"), "utf8")),
    "utf8"
  );
  const urls = {
    report: pathToFileURL(run.reportFiles.html).href,
    comment: pathToFileURL(commentFile).href
  };
  for (const { id, shot } of features) {
    if (shot) await captureShot(page, urls, id, shot);
  }

  await recordScreenReader(
    path.join(shotsDir, "screen-reader.webm"),
    path.join(shotsDir, "screen-reader.txt")
  );

  // Every file the feature list names must now exist, or a card would show nothing.
  for (const { id, shot, video } of features) {
    const files = [
      ...(shot ? [`${id}.png`] : []),
      ...(video ? [video.file, video.text, ...(video.captions ? [video.captions] : [])] : [])
    ];
    for (const file of files) {
      expect((await stat(path.join(shotsDir, file))).size, file).toBeGreaterThan(0);
    }
  }

  // And every homepage card shows its real shot or video.
  await page.goto(pathToFileURL(path.resolve("site", "index.html")).href);
  const cards = page.locator("#story img, #story video");
  await expect(cards).toHaveCount(features.length);
  for (const card of await cards.all()) {
    await card.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        card.evaluate((element) =>
          element instanceof HTMLImageElement
            ? element.complete && element.naturalWidth > 0
            : (element as HTMLVideoElement).readyState >= HTMLMediaElement.HAVE_METADATA
        )
      )
      .toBe(true);
  }
});

/** The text version of a captioned recording: its steps, one per line, without the timings. */
function stepsFromCaptions(vtt: string): string {
  const cues = vtt.split(/\n\n+/).slice(1);
  return `${cues.map((cue) => cue.split("\n").slice(2).join(" ")).join("\n")}\n`;
}

/** The run's pull-request comment, styled like a GitHub comment, with its first fix opened as a
 * reviewer would. */
function commentPage(markdown: string): string {
  const body = marked.parse(markdown.replace("<details>", "<details open>"), { async: false });
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Pull-request comment</title>
<style>
body{margin:0;padding:24px;color:#1f2328;background:#fff;font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif}
main{max-width:760px;padding:8px 24px;border:1px solid #d1d9e0;border-radius:6px}
h2{padding-bottom:.3em;border-bottom:1px solid #d1d9e0}
table{border-collapse:collapse}th,td{padding:6px 13px;border:1px solid #d1d9e0}
code{padding:.2em .4em;border-radius:6px;background:#eff1f3;font:85% ui-monospace,SFMono-Regular,Menlo,monospace}
a{color:#0969da}details{margin-bottom:16px}
</style>
</head>
<body><main>${body}</main></body>
</html>
`;
}

/** Saves one highlighted crop of the report or comment: the box around the shot's targets, with a
 * margin. */
async function captureShot(
  page: Page,
  urls: { report: string; comment: string },
  id: string,
  shot: Shot
) {
  if (shot.panel === "comment") {
    await page.goto(urls.comment);
  } else {
    await page.goto(urls.report);
    await page.locator(`[data-tab][href="#panel-${shot.panel}"]`).click();
  }
  for (const selector of shot.targets) {
    const target = page.locator(selector);
    await expect(target, `${id}: ${selector}`).toBeVisible();
    await target.scrollIntoViewIfNeeded();
  }
  // Lazy images load once scrolled to; the crop must not catch one half-loaded.
  await expect
    .poll(() =>
      page.evaluate(
        (selectors) =>
          selectors
            .flatMap((selector) => [
              ...document.querySelectorAll<HTMLImageElement>(`${selector} img`)
            ])
            .every((image) => image.complete && image.naturalWidth > 0),
        shot.targets
      )
    )
    .toBe(true);
  const box = await page.evaluate(
    ({ selectors, color }) => {
      const rects = selectors.map((selector) =>
        document.querySelector(selector)!.getBoundingClientRect()
      );
      const left = Math.min(...rects.map(({ left }) => left)) + scrollX;
      const top = Math.min(...rects.map(({ top }) => top)) + scrollY;
      const right = Math.max(...rects.map(({ right }) => right)) + scrollX;
      const bottom = Math.max(...rects.map(({ bottom }) => bottom)) + scrollY;
      const inset = 10;
      const mark = document.createElement("div");
      Object.assign(mark.style, {
        position: "absolute",
        left: `${left - inset}px`,
        top: `${top - inset}px`,
        width: `${right - left + inset * 2}px`,
        height: `${bottom - top + inset * 2}px`,
        border: `4px solid ${color}`,
        borderRadius: "14px",
        boxSizing: "border-box",
        pointerEvents: "none",
        zIndex: "2147483647"
      });
      document.body.append(mark);
      return { left, top, right, bottom, pageWidth: document.documentElement.scrollWidth };
    },
    { selectors: shot.targets, color: HIGHLIGHT_COLOR }
  );
  const margin = 32;
  const x = Math.max(0, box.left - margin);
  const y = Math.max(0, box.top - margin);
  await page.screenshot({
    path: path.join(shotsDir, `${id}.png`),
    fullPage: true,
    clip: {
      x,
      y,
      width: Math.min(box.pageWidth, box.right + margin) - x,
      height: box.bottom + margin - y
    }
  });
}

/** screen-reader-cli reads the demo page aloud, step by step, and records it; what it says is the
 * video's text version. */
async function recordScreenReader(videoFile: string, textFile: string) {
  const packageFile = require.resolve("screen-reader-cli/package.json");
  const { bin } = JSON.parse(readFileSync(packageFile, "utf8")) as {
    bin: { screenreader: string };
  };
  const server = await startHtmlServer(serveDirectory("site"));
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [
      path.join(path.dirname(packageFile), bin.screenreader),
      "audit",
      `${server.origin}/${contract.pages.issues.url}`,
      "--record",
      videoFile
    ]);
    await writeFile(textFile, stdout, "utf8");
  } finally {
    await server.close();
  }
}
