import { readFile, stat } from "node:fs/promises";

import { expect, test, type Page } from "@playwright/test";

import { runKeyboardPointerSweepLane, sweepKeyboardAndPointer } from "@aee/playwright";

import { startHtmlServer } from "./scenario-helpers";

// Every press is reported back to the test, so it can prove what the sweep did and did not press.
const pageUrl = `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head><title>Sweep safety</title></head>
  <body>
    <main>
      <h1>Sweep safety</h1>
      <a id="leave" href="#left">Leave this page</a>
      <form id="send">
        <label for="note">Note</label><input id="note" />
        <button id="submit">Send</button>
      </form>
      <button id="safe" type="button">Show details</button>
    </main>
    <script>
      document.querySelector("#leave").addEventListener("click", () => window.record("link"));
      document.querySelector("#send").addEventListener("submit", (event) => {
        event.preventDefault();
        window.record("submit");
      });
      document.querySelector("#safe").addEventListener("click", () => window.record("button"));
    </script>
  </body>
</html>`)}`;

async function recordPresses(page: Page): Promise<string[]> {
  const presses: string[] = [];
  await page.exposeFunction("record", (what: string) => presses.push(what));
  return presses;
}

test("the sweep never presses links or form submit buttons", async ({ page }) => {
  const presses = await recordPresses(page);
  const result = await sweepKeyboardAndPointer({ page, url: pageUrl, activateControls: true });

  expect(result.activated).toEqual(["#safe"]);
  expect(presses).not.toContain("link");
  expect(presses).not.toContain("submit");
  expect(presses).toContain("button");
  expect(result.findings).toEqual([]);
});

test("the sweep presses nothing unless activation is allowed", async ({ page }) => {
  const presses = await recordPresses(page);
  const result = await sweepKeyboardAndPointer({ page, url: pageUrl, activateControls: false });

  expect(result.tabStops).toEqual(["#leave", "#note", "#submit", "#safe"]);
  expect(result.activated).toEqual([]);
  expect(presses).toEqual([]);
});

test("the sweep lane keeps pressed controls inside the allowed origins and reports no page load as lost focus", async ({
  browser
}, testInfo) => {
  let visitsElsewhere = 0;
  const elsewhere = await startHtmlServer((_request, response) => {
    visitsElsewhere += 1;
    response.end("Another site");
  });
  const site = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
  <head><title>Leave</title></head>
  <body>
    <main>
      <h1>Leave</h1>
      <button id="away" type="button">Open the other site</button>
      <button id="next" type="button">Next page</button>
    </main>
    <script>
      document.querySelector("#away").addEventListener("click", () => {
        location.href = "${elsewhere.origin}/";
      });
      document.querySelector("#next").addEventListener("click", () => {
        location.href = "/next";
      });
    </script>
  </body>
</html>`);
  });
  try {
    const lane = await runKeyboardPointerSweepLane({
      browser,
      projectRoot: testInfo.outputPath(),
      targetUrl: `${site.origin}/`,
      allowedOrigins: [site.origin],
      activateControls: true
    });

    expect(lane.activated).toEqual(["#away", "#next"]);
    expect(lane.blockedNavigations.length).toBeGreaterThan(0);
    expect(new Set(lane.blockedNavigations)).toEqual(new Set([`${elsewhere.origin}/`]));
    expect(visitsElsewhere).toBe(0);
    expect(lane.findings).toEqual([]);
  } finally {
    await site.close();
    await elsewhere.close();
  }
});

test("the sweep lane records a video whose descriptions name each step", async ({
  browser
}, testInfo) => {
  const site = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
  <head><title>Steps</title></head>
  <body>
    <main>
      <h1>Steps</h1>
      <a href="#top">Back to top</a>
      <button id="save" type="button">Save</button>
      <button id="icon" type="button"></button>
    </main>
  </body>
</html>`);
  });
  try {
    const lane = await runKeyboardPointerSweepLane({
      browser,
      projectRoot: testInfo.outputPath(),
      targetUrl: `${site.origin}/`,
      allowedOrigins: [site.origin],
      activateControls: true
    });

    const captions = await readFile(lane.video!.captionsFile, "utf8");
    const cues = captions.split("\n").filter((line) => /^(Tab|Press) /.test(line));
    expect(cues).toEqual([
      "Tab 1: “Back to top”",
      "Tab 2: “Save”",
      "Tab 3: a control with no name (#icon)",
      "Press “Save” with Enter, then click it",
      "Press a control with no name (#icon) with Enter, then click it"
    ]);
    expect((await stat(lane.video!.videoFile)).size).toBeGreaterThan(0);
    const manifest = JSON.parse(await readFile(lane.manifestFile, "utf8")) as {
      artifacts: Array<{ kind: string }>;
    };
    expect(manifest.artifacts.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["interaction-video", "video-sidecar", "video-captions"])
    );
  } finally {
    await site.close();
  }
});
