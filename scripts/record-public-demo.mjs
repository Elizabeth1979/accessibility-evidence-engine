import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "@playwright/test";
import { runAeeOnPage } from "@aee/playwright";

const projectRoot = process.cwd();
const siteRoot = path.join(projectRoot, "site");
const runId = "recorded-keyboard-save";
const outputRoot = path.join(siteRoot, "demo-artifacts");
const runOutput = path.join(outputRoot, runId);
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

await rm(runOutput, { recursive: true, force: true });

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
  const context = await browser.newContext({
    colorScheme: "dark",
    recordVideo: {
      dir: videoTempDir,
      size: { width: 1280, height: 720 }
    },
    viewport: { width: 1280, height: 720 }
  });
  const page = await context.newPage();
  const video = page.video();

  await page.goto(`http://127.0.0.1:${port}/?recording=1`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  await page.locator("#recorded-title").evaluate((heading) => {
    const activeWindow = heading.ownerDocument.defaultView;
    activeWindow?.scrollTo({
      top: heading.getBoundingClientRect().top + (activeWindow.scrollY ?? 0) - 40
    });
  });
  await page.waitForTimeout(900);

  const saveButton = page.getByRole("button", { name: "Save changes" });
  await saveButton.focus();
  await page.waitForTimeout(700);

  const result = await runAeeOnPage({
    page,
    projectRoot,
    outputDir: "site/demo-artifacts",
    runId,
    observers: ["dom", "accessibility-tree", "focus", "visual"],
    judges: ["keyboard", "change-response", "release"],
    checkpointName: "public-demo-save",
    policy: {
      name: "public-demo",
      capture: {
        stabilizeAfterInteractionMs: 700
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

  await page.waitForTimeout(1100);
  await page.locator("#recorded-output").scrollIntoViewIfNeeded();
  await page.waitForTimeout(1400);
  await context.close();

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

  await normalizePublishedPaths([
    ...result.reporterFiles,
    path.join(runOutput, "bundle.json"),
    path.join(runOutput, "run.json")
  ]);

  const report = JSON.parse(await readFile(path.join(runOutput, "aee-report.json"), "utf8"));
  const verdicts = Object.fromEntries(
    report.judgments.map((judgment) => [judgment.judgeId, judgment.verdict])
  );

  if (
    report.run.status !== "completed" ||
    verdicts.keyboard !== "pass" ||
    verdicts["change-response"] !== "pass" ||
    verdicts.release !== "pass"
  ) {
    throw new Error(`Unexpected public demo verdicts: ${JSON.stringify(verdicts)}`);
  }

  console.log(
    `Recorded public demo and AEE evidence in ${path.relative(projectRoot, outputRoot)}.`
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
  await rm(videoTempDir, { recursive: true, force: true });
}

async function normalizePublishedPaths(filePaths) {
  for (const filePath of filePaths) {
    const content = await readFile(filePath, "utf8");
    await writeFile(filePath, content.replaceAll(projectRoot, "."), "utf8");
  }
}
