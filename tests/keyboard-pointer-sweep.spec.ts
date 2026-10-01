import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test, type Page } from "@playwright/test";
import { PNG } from "pngjs";

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

test("the sweep lane's video shows the page in every frame, never a close-up in a grey frame", async ({
  browser,
  page
}, testInfo) => {
  // Six Tab stops on a coloured page. Playwright pads a frame smaller than the video with grey, so
  // a frame that shows a close-up or a shrunken page has grey in its corner instead of the page.
  const site = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html>
<html lang="en">
  <head>
    <title>Frames</title>
    <style>body { margin: 0; min-height: 100vh; background: #f4e3b8; }</style>
  </head>
  <body>
    <main>
      <h1>Frames</h1>
      ${["One", "Two", "Three", "Four", "Five", "Six"].map((name) => `<button type="button">${name}</button>`).join("")}
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

    expect(lane.tabStops).toHaveLength(6);
    const corners = await videoCorners(page, lane.video!.videoFile);
    expect(corners.length).toBeGreaterThan(10);
    expect(
      corners.filter((pixel) => pixel.every((channel) => Math.abs(channel - 128) <= 3))
    ).toEqual([]);
  } finally {
    await site.close();
  }
});

/** The bottom-right pixel of a recording every 0.1 seconds, read from screenshots of it. */
async function videoCorners(page: Page, videoFile: string): Promise<number[][]> {
  const player = path.join(path.dirname(videoFile), "player.html");
  await writeFile(player, `<video src="${path.basename(videoFile)}" muted></video>`);
  await page.goto(pathToFileURL(player).href);
  const video = page.locator("video");
  const duration = await video.evaluate(async (element: HTMLVideoElement) => {
    if (element.readyState < 1) {
      await new Promise((loaded) =>
        element.addEventListener("loadedmetadata", loaded, { once: true })
      );
    }
    // A recording states no duration until its end has been read.
    if (!Number.isFinite(element.duration)) {
      element.currentTime = Number.MAX_SAFE_INTEGER;
      await new Promise((read) => element.addEventListener("timeupdate", read, { once: true }));
    }
    return element.duration;
  });
  const corners: number[][] = [];
  for (let time = 0; time < duration; time += 0.1) {
    await video.evaluate(async (element: HTMLVideoElement, seconds) => {
      element.currentTime = seconds;
      while (element.seeking || element.readyState < 2) {
        await new Promise((wait) => setTimeout(wait, 20));
      }
      await new Promise((drawn) => requestAnimationFrame(() => requestAnimationFrame(drawn)));
    }, time);
    const frame = PNG.sync.read(await video.screenshot());
    const corner = ((frame.height - 4) * frame.width + frame.width - 4) * 4;
    corners.push([...frame.data.subarray(corner, corner + 3)]);
  }
  return corners;
}

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

test("the sweep walks Tab from the top of the page, whatever #fragment the address opens at", async ({
  page
}) => {
  const result = await sweepKeyboardAndPointer({
    page,
    url: `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head><title>Fragment</title></head>
  <body>
    <main>
      <h1>Fragment</h1>
      <a id="above" href="#target">Jump to the section</a>
      <div style="height: 1500px"></div>
      <section id="target" aria-label="Section"><button id="inside" type="button">Inside</button></section>
    </main>
  </body>
</html>`)}#target`,
    activateControls: false
  });

  expect(result.tabStops.map(({ selector }) => selector)).toEqual(["#above", "#inside"]);
  expect(result.findings).toEqual([]);
});

test("the sweep reads the page a press loads, even when the load cuts its read short", async ({
  page
}) => {
  const site = await startHtmlServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      request.url === "/next"
        ? `<!doctype html><html lang="en"><head><title>Next</title></head><body><main><h1>Next</h1></main></body></html>`
        : `<!doctype html>
<html lang="en">
  <head><title>Start</title></head>
  <body>
    <main>
      <h1>Start</h1>
      <button id="next" type="button">Next page</button>
    </main>
    <script>
      document.querySelector("#next").addEventListener("click", () => {
        location.href = "/next";
      });
    </script>
  </body>
</html>`
    );
  });
  try {
    const result = await sweepKeyboardAndPointer({
      page: cutShortFirstReadAfterEachLoad(page, "/next"),
      url: `${site.origin}/`,
      activateControls: true
    });

    expect(result.activated).toEqual(["#next"]);
    expect(result.findings).toEqual([]);
  } finally {
    await site.close();
  }
});

/**
 * The page, except that the first read after each load of `pathname` fails as Playwright fails a
 * read the load lands in the middle of. A real browser lands a load mid-read only now and then,
 * under load, so the test makes it happen every time.
 */
function cutShortFirstReadAfterEachLoad(page: Page, pathname: string): Page {
  let cutShort = true;
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) cutShort = new URL(frame.url()).pathname !== pathname;
  });
  return new Proxy(page, {
    get(target, key) {
      if (key === "evaluate") {
        return (...args: Parameters<Page["evaluate"]>) => {
          if (cutShort) return target.evaluate(...args);
          cutShort = true;
          return Promise.reject(
            new Error(
              "page.evaluate: Execution context was destroyed, most likely because of a navigation"
            )
          );
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}

test("the sweep counts a tab arrow keys reach as reachable, and reports a mouse target they do not", async ({
  page
}) => {
  const result = await sweepKeyboardAndPointer({
    page,
    url: `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head><title>Tabs</title><style>[role="tab"], .open { cursor: pointer; }</style></head>
  <body>
    <main>
      <h1>Tabs</h1>
      <div role="tablist" aria-label="Sections">
        <button role="tab" id="first" type="button" aria-selected="true">First</button>
        <button role="tab" id="second" type="button" aria-selected="false" tabindex="-1">Second</button>
        <button role="tab" id="third" type="button" aria-selected="false" tabindex="-1">Third</button>
        <span id="more" onclick="this.textContent = 'More shown'">More</span>
      </div>
      <div role="tabpanel" id="panel-first"><button class="open" type="button">Open first</button></div>
      <div role="tabpanel" id="panel-second" hidden><button class="open" type="button">Open second</button></div>
      <div role="tabpanel" id="panel-third" hidden><button class="open" type="button">Open third</button></div>
    </main>
    <script>
      // The APG tabs pattern: one tab in the Tab order, Left, Right, Home and End move between them.
      const tabs = [...document.querySelectorAll('[role="tab"]')];
      document.querySelector('[role="tablist"]').addEventListener("keydown", (event) => {
        const at = tabs.indexOf(document.activeElement);
        const next = { ArrowRight: at + 1, ArrowLeft: at - 1, Home: 0, End: tabs.length - 1 }[event.key];
        if (next === undefined || at < 0) return;
        const tab = tabs[(next + tabs.length) % tabs.length];
        for (const other of tabs) {
          other.tabIndex = other === tab ? 0 : -1;
          other.setAttribute("aria-selected", String(other === tab));
          document.getElementById("panel-" + other.id).hidden = other !== tab;
        }
        tab.focus();
        event.preventDefault();
      });
    </script>
  </body>
</html>`)}#sections`,
    activateControls: false
  });

  // The arrow keys switch panels; the page is loaded again afterwards, even at a #fragment, so the
  // second and third panels' buttons, which Tab never met, are not reported either.
  expect(result.tabStops.map(({ selector }) => selector)).toEqual([
    "#first",
    "#panel-first > button:nth-of-type(1)"
  ]);
  expect(result.findings.map(({ kind, selector }) => ({ kind, selector }))).toEqual([
    { kind: "pointer-only", selector: "#more" }
  ]);
});

test("the sweep waits for an app to draw the page before it presses Tab", async ({ page }) => {
  // As a single-page app on a busy machine: "Loading" for a while after the load, then the page.
  const result = await sweepKeyboardAndPointer({
    page,
    url: `data:text/html,${encodeURIComponent(`<!doctype html>
<html lang="en">
  <head><title>Late app</title></head>
  <body>
    <div id="root">Loading</div>
    <script>
      let ticks = 0;
      const timer = setInterval(() => {
        ticks += 1;
        if (ticks < 6) return void (document.querySelector("#root").textContent += ".");
        clearInterval(timer);
        document.querySelector("#root").innerHTML =
          '<header><a id="home" href="#home">Home</a><button id="out" type="button">Sign out</button></header>' +
          '<main><h1>Album</h1><button id="rename" type="button">Rename album</button></main>';
      }, 100);
    </script>
  </body>
</html>`)}`,
    activateControls: false
  });

  expect(result.tabStops.map(({ selector }) => selector)).toEqual(["#home", "#out", "#rename"]);
  expect(result.findings).toEqual([]);
});

test("a sweep whose Tab reaches nothing on a page with links and buttons decides nothing", async ({
  browser
}, testInfo) => {
  const site = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    // A script that stops Tab: the walk reaches nothing, so it cannot tell what a mouse alone uses.
    response.end(`<!doctype html>
<html lang="en">
  <head><title>Stopped</title></head>
  <body>
    <main>
      <h1>Stopped</h1>
      <a href="/elsewhere">Elsewhere</a>
      <button type="button">Save</button>
    </main>
    <script>
      document.addEventListener("keydown", (event) => {
        if (event.key === "Tab") event.preventDefault();
      });
    </script>
  </body>
</html>`);
  });
  try {
    const run = runKeyboardPointerSweepLane({
      browser,
      projectRoot: testInfo.outputPath(),
      laneId: "stopped",
      targetUrl: `${site.origin}/`,
      allowedOrigins: [site.origin],
      activateControls: false
    });
    await expect(run).rejects.toThrow(/^Tab reached nothing, though the page has 2 controls/);
    const record = JSON.parse(
      await readFile(
        testInfo.outputPath("aee-output", "stopped", "keyboard-pointer-sweep.json"),
        "utf8"
      )
    ) as { status: string; findings?: unknown[]; diagnostics: string[] };
    expect(record.status).toBe("failed");
    expect(record.findings).toBeUndefined();
    expect(record.diagnostics).toEqual([
      expect.stringMatching(/not decided; try the page by keyboard\.$/)
    ]);
  } finally {
    await site.close();
  }
});
