import { readFile, stat } from "node:fs/promises";
import path from "node:path";

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

  expect(result.tabStops.map(({ selector }) => selector)).toEqual([
    "#leave",
    "#note",
    "#submit",
    "#safe"
  ]);
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

test("the sweep lane records where each Tab stop is and whether focus visibly changes it", async ({
  browser
}, testInfo) => {
  // Four ways a page shows focus, or does not: the browser's own ring, a ring removed with no
  // replacement, a ring drawn on the field's wrapper, and a colour change far down a long page.
  const site = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
  <head>
    <title>Focus</title>
    <style>
      html { scroll-behavior: smooth; }
      #bare:focus { outline: none; }
      .field:focus-within { box-shadow: 0 0 0 3px #1a56db; }
      .field input:focus { outline: none; }
      #colour { margin-top: 1600px; }
      #colour:focus { outline: none; background: #ffe066; }
    </style>
  </head>
  <body>
    <main>
      <h1>Focus</h1>
      <button id="ring" type="button">Browser ring</button>
      <button id="bare" type="button">No ring</button>
      <span class="field"><label>Search <input id="search" type="search"></label></span>
      <button id="colour" type="button">Colour change</button>
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
      activateControls: false
    });

    expect(lane.tabStops.map(({ selector, focusVisible }) => ({ selector, focusVisible }))).toEqual(
      [
        { selector: "#ring", focusVisible: true },
        { selector: "#bare", focusVisible: false },
        { selector: "#search", focusVisible: true },
        { selector: "#colour", focusVisible: true }
      ]
    );
    const laneDir = path.dirname(lane.sweepFile);
    for (const [index, stop] of lane.tabStops.entries()) {
      expect(stop.focusCrop).toBe(`tab-stop-${index + 1}.png`);
      expect((await stat(path.join(laneDir, stop.focusCrop!))).size).toBeGreaterThan(0);
      expect(stop.targetBox!.pageHeight).toBeGreaterThan(1600);
    }
    // The last stop is measured where it is, far down the page.
    expect(lane.tabStops[3]!.targetBox!.y).toBeGreaterThan(1600);
    const manifest = JSON.parse(await readFile(lane.manifestFile, "utf8")) as {
      artifacts: Array<{ kind: string }>;
    };
    expect(manifest.artifacts.filter(({ kind }) => kind === "focus-crop")).toHaveLength(4);
  } finally {
    await site.close();
  }
});

test("the sweep hovers only what a mouse can reach, such as not a skip link parked above the page", async ({
  page
}) => {
  const result = await sweepKeyboardAndPointer({
    page,
    url: `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head>
    <title>Skip link</title>
    <style>
      a:hover { text-decoration-thickness: 2px; }
      .skip-link { position: absolute; left: 1rem; top: -5rem; }
      .skip-link:focus { top: 1rem; }
      .tip { display: none; }
      .card:hover .tip { display: block; }
    </style>
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    <main id="main">
      <h1>Skip link</h1>
      <div class="card">Plan<p class="tip">Renews on 1 March</p></div>
    </main>
  </body>
</html>`)}`,
    activateControls: false
  });

  expect(result.tabStops.map(({ selector }) => selector)).toEqual([
    "html > body:nth-of-type(1) > a:nth-of-type(1)"
  ]);
  expect(result.findings.map(({ kind, label }) => ({ kind, label }))).toEqual([
    { kind: "hover-only", label: "Renews on 1 March" }
  ]);
});
