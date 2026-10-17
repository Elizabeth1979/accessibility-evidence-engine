import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Browser, Page } from "@playwright/test";

import { frameNotes } from "@aee/core";
import {
  createPortableVirtualScreenReader,
  renderPortableVirtualScreenReaderTranscript,
  type VirtualScreenReaderEntry
} from "@aee/playwright";

/** Long enough to read a caption, short enough that 100 steps stay under two minutes. */
const STEP_MS = 800;
const SIZE = { width: 1280, height: 720 };
const OVERLAY_ID = "aee-reader-recording";

/**
 * A video of AEE's virtual screen reader reading `url` from top to bottom: a box around each item
 * as it is read, and a caption bar with what it says. Writes the video to `videoFile` and the
 * transcript to `textFile`.
 *
 * The overlay hangs off <html>, outside <body>, and is aria-hidden, so it is not in the
 * accessibility tree the reader reads, and recording never changes what is announced.
 */
export async function recordVirtualReader(
  browser: Browser,
  url: string,
  videoFile: string,
  textFile: string
) {
  const videoDir = await mkdtemp(path.join(os.tmpdir(), "aee-reader-"));
  try {
    const context = await browser.newContext({
      viewport: SIZE,
      recordVideo: { dir: videoDir, size: SIZE }
    });
    const page = await context.newPage();
    try {
      await page.goto(url);
      await attachOverlay(page);
      const reader = createPortableVirtualScreenReader(page);
      let step = 0;
      for (let entry = await reader.command("start"); entry.item;) {
        await showStep(page, ++step, entry);
        entry = await reader.command("next-item");
      }
      await writeFile(
        textFile,
        renderPortableVirtualScreenReaderTranscript(await reader.snapshot()),
        "utf8"
      );
    } finally {
      // The video is only complete once its page's context is closed.
      await context.close();
    }
    await page.video()?.saveAs(videoFile);
  } finally {
    await rm(videoDir, { recursive: true, force: true });
  }
}

async function attachOverlay(page: Page) {
  await page.evaluate((id) => {
    const overlay = document.createElement("div");
    overlay.id = id;
    overlay.setAttribute("aria-hidden", "true");
    overlay.innerHTML =
      '<div data-box style="position:absolute;border:4px solid #fc0;border-radius:4px;pointer-events:none;z-index:2147483646"></div>' +
      '<div data-caption style="position:fixed;inset:auto 0 0 0;padding:14px 20px;background:#000;color:#fc0;font:600 20px/1.35 system-ui,sans-serif;white-space:pre-line;border-top:3px solid #fc0;z-index:2147483647"></div>';
    document.documentElement.append(overlay);
  }, OVERLAY_ID);
}

async function showStep(page: Page, step: number, entry: VirtualScreenReaderEntry) {
  await page.evaluate(
    ({ id, caption, bounds }) => {
      const overlay = document.getElementById(id);
      const box = overlay?.querySelector<HTMLElement>("[data-box]");
      const captionBar = overlay?.querySelector("[data-caption]");
      if (!box || !captionBar) return;
      // An item with no rendered box (a hidden heading, say) is read without one drawn.
      box.hidden = !bounds;
      if (bounds) {
        window.scrollTo({ top: bounds.y + bounds.height / 2 - innerHeight / 2 });
        Object.assign(box.style, {
          left: `${bounds.x - 6}px`,
          top: `${bounds.y - 6}px`,
          width: `${bounds.width + 12}px`,
          height: `${bounds.height + 12}px`
        });
      }
      captionBar.textContent = caption;
    },
    {
      id: OVERLAY_ID,
      // AEE's note that the reader left or entered a frame sits above what Guidepup said.
      caption: [...frameNotes(entry), `🔊 ${step}. ${entry.announcement}`].join("\n"),
      bounds: entry.item?.visualBounds
    }
  );
  await page.waitForTimeout(STEP_MS);
}
