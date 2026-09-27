import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { chromium, expect, test, type Page } from "@playwright/test";

import { serveDirectory, startHtmlServer } from "./scenario-helpers";
import { contract, readerWalk, runOnLabPage } from "./test-lab-helpers";

// `npm run site:shots` regenerates site/shots from a real run of the test lab's demo page, so no
// shot is hand-made or stale. site/shots/shots.json lists each file with its caption and alt text.
const shotsDir = path.resolve("site", "shots");
/** Slows every browser step, so the recorded sweep moves at a pace a person can follow. */
const WATCHABLE_SLOW_MO_MS = 800;
const HIGHLIGHT_COLOR = "#c2185b";

interface Shot {
  id: string;
  /** The report tab the shot is on. */
  panel: "overview" | "findings";
  /** The shot is the smallest box around all of these, highlighted. */
  targets: string[];
  /** What the feature means, for a reader who knows neither accessibility nor code. */
  caption: string;
  alt: string;
}

const shots: Shot[] = [
  {
    id: "release-blocked",
    panel: "overview",
    targets: [".status-brief"],
    caption: "It says whether the page is ready to ship, and how many fixes stand in the way.",
    alt: "The report's headline: the release verdict and the number of fixes needed first."
  },
  {
    id: "finds-the-bug",
    panel: "overview",
    targets: [".health-map"],
    caption:
      "It checks keyboard use, screen-reader use, page structure and colour contrast, and marks what needs fixing.",
    alt: "Four report rows, keyboard access, virtual reader, semantics and visual contrast, each with its result."
  },
  {
    id: "screen-reader-hears",
    panel: "overview",
    targets: ['[data-status="reader"]'],
    caption:
      "It lists what a screen reader announces with no name, where a blind user cannot tell what a control does.",
    alt: "The report's virtual reader row, listing each item announced without a name."
  },
  {
    id: "explains-it",
    panel: "findings",
    targets: [
      "#review-color-contrast .fix-main > header",
      "#review-color-contrast .fix-main > header + p"
    ],
    caption: "Each problem says, in plain words, who it affects.",
    alt: "A fix in the report: its title and a sentence on who the problem affects."
  },
  {
    id: "how-to-fix",
    panel: "findings",
    targets: ["#review-color-contrast .contrast-preview"],
    caption: "It proposes a fix you can check: a colour that passes, next to the one that fails.",
    alt: "The current text colour next to a proposed colour, each with its contrast ratio."
  },
  {
    id: "every-affected-spot",
    panel: "findings",
    targets: ["#review-color-contrast .current-state"],
    caption: "It marks each affected spot on a picture of the page.",
    alt: "A crop of the tested page with the affected text outlined and labelled."
  }
];

const videos = [
  {
    id: "keyboard",
    video: "keyboard.webm",
    captions: "keyboard.vtt",
    caption:
      "Using only the keyboard: it tabs to every control, then presses each one to check it does what a click does."
  },
  {
    id: "screen-reader",
    video: "screen-reader.webm",
    caption: "What a blind user hears: a screen reader reads the demo page from top to bottom."
  }
];

test("product shots and videos come from a real run of the demo page", async ({
  page
}, testInfo) => {
  await rm(shotsDir, { recursive: true, force: true });
  await mkdir(shotsDir, { recursive: true });

  const browser = await chromium.launch({ slowMo: WATCHABLE_SLOW_MO_MS });
  const run = await runOnLabPage(
    browser,
    contract.pages.issues,
    ["focus", "hover", "activate-page-controls"],
    testInfo,
    readerWalk
  ).finally(() => browser.close());

  // The keyboard video is the sweep lane's own recording, with its step-by-step descriptions.
  const sweepFile = (kind: string) => {
    const artifact = run.report.artifacts.find(
      (candidate) =>
        candidate.kind === kind && candidate.provenance?.laneId?.endsWith("-keyboard-pointer-sweep")
    );
    expect(artifact, `the sweep lane's ${kind}`).toBeTruthy();
    return path.join(run.outputDir, artifact!.path);
  };
  await copyFile(sweepFile("interaction-video"), path.join(shotsDir, "keyboard.webm"));
  await copyFile(sweepFile("video-captions"), path.join(shotsDir, "keyboard.vtt"));

  const reportUrl = pathToFileURL(run.reportFiles.html).href;
  for (const shot of shots) {
    await captureShot(page, reportUrl, shot);
  }

  await recordScreenReader(path.join(shotsDir, "screen-reader.webm"));

  for (const { video } of videos) {
    expect((await stat(path.join(shotsDir, video))).size, video).toBeGreaterThan(0);
  }
  await writeFile(
    path.join(shotsDir, "shots.json"),
    `${JSON.stringify(
      {
        source: `aee run on the test lab's “${contract.pages.issues.title}”`,
        shots: shots.map(({ id, caption, alt }) => ({ id, image: `${id}.png`, caption, alt })),
        videos
      },
      null,
      2
    )}\n`,
    "utf8"
  );
});

/** Saves one highlighted crop of the report: the box around the shot's targets, with a margin. */
async function captureShot(page: Page, reportUrl: string, shot: Shot) {
  await page.goto(reportUrl);
  await page.locator(`[data-tab][href="#panel-${shot.panel}"]`).click();
  for (const selector of shot.targets) {
    const target = page.locator(selector);
    await expect(target, `${shot.id}: ${selector}`).toBeVisible();
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
    path: path.join(shotsDir, `${shot.id}.png`),
    fullPage: true,
    clip: {
      x,
      y,
      width: Math.min(box.pageWidth, box.right + margin) - x,
      height: box.bottom + margin - y
    }
  });
}

/** screen-reader-cli reads the demo page aloud, step by step, and records it. */
async function recordScreenReader(videoFile: string) {
  const packageFile = require.resolve("screen-reader-cli/package.json");
  const { bin } = JSON.parse(readFileSync(packageFile, "utf8")) as {
    bin: { screenreader: string };
  };
  const server = await startHtmlServer(serveDirectory("site"));
  try {
    await promisify(execFile)(process.execPath, [
      path.join(path.dirname(packageFile), bin.screenreader),
      "audit",
      `${server.origin}/${contract.pages.issues.url}`,
      "--record",
      videoFile
    ]);
  } finally {
    await server.close();
  }
}
