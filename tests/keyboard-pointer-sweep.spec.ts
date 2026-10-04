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

test("the sweep reports a message a press shows only when a screen reader does not say it", async ({
  page
}) => {
  const html = `<!doctype html>
<html lang="en">
  <head><title>Messages</title></head>
  <body>
    <main>
      <h1>Messages</h1>
      <button id="into-status" type="button">Save draft</button>
      <p id="status" role="status"></p>
      <button id="into-paragraph" type="button">Copy link</button>
      <p id="plain"></p>
      <button id="later" type="button">Sync</button>
      <p id="later-note"></p>
      <button id="new-region" type="button">Share</button>
      <button id="new-alert" type="button">Delete</button>
      <button id="disclosure" type="button" aria-expanded="false">More</button>
      <p id="more" hidden>Extra settings live here.</p>
      <label><input id="share-team" type="checkbox"> Share with a team</label>
      <fieldset id="team" hidden><legend>Team</legend><label>Team name <input></label></fieldset>
      <button id="to-message" type="button">Check</button>
      <p id="result" tabindex="-1"></p>
      <button id="show-hidden" type="button">Load</button>
      <p id="hidden-note" hidden>Three items loaded.</p>
      <button id="toast" type="button">Archive</button>
      <button id="redraw" type="button">Refresh</button>
      <ul id="list"><li>First</li><li>Second</li></ul>
    </main>
    <script>
      const on = (id, handler) => document.getElementById(id).addEventListener("click", handler);
      const added = (html) => document.querySelector("main").insertAdjacentHTML("beforeend", html);
      on("into-status", () => (document.getElementById("status").textContent = "Draft saved."));
      on("into-paragraph", () => (document.getElementById("plain").textContent = "Link copied."));
      on("later", () =>
        setTimeout(() => (document.getElementById("later-note").textContent = "Synced."), 100)
      );
      on("new-region", () => added('<p id="shared" role="status">Shared with the team.</p>'));
      on("new-alert", () => added('<p role="alert">Could not delete.</p>'));
      on("disclosure", (event) => {
        event.currentTarget.setAttribute("aria-expanded", "true");
        document.getElementById("more").hidden = false;
      });
      on("share-team", (event) => (document.getElementById("team").hidden = !event.currentTarget.checked));
      on("to-message", () => {
        const result = document.getElementById("result");
        result.textContent = "All checks passed.";
        result.focus();
      });
      on("show-hidden", () => (document.getElementById("hidden-note").hidden = false));
      on("toast", () =>
        added('<div class="toast"><p role="alert">Archived.</p><button type="button">Undo</button></div>')
      );
      // Drawn again with the same text, as a framework re-render does: nothing new to say.
      on("redraw", () => {
        document.getElementById("list").innerHTML = "<li>First</li><li>Second</li>";
      });
    </script>
  </body>
</html>`;
  const url = `data:text/html,${encodeURIComponent(html)}`;
  const result = await sweepKeyboardAndPointer({ page, url, activateControls: true });

  // Said: a live region that was there before, an alert (also inside a toast with a button), a
  // disclosure that says it expanded, a check box that says it is checked as its fields appear, and
  // a message focus moved to. Nothing new: a list drawn again
  // with the same text. Not said: a plain paragraph, even a moment later, a region added with its
  // text, and a paragraph that was hidden.
  expect(result.findings.map(({ kind, selector, label }) => ({ kind, selector, label }))).toEqual([
    { kind: "status-not-announced", selector: "#plain", label: "Link copied." },
    { kind: "status-not-announced", selector: "#later-note", label: "Synced." },
    { kind: "status-not-announced", selector: "#shared", label: "Shared with the team." },
    { kind: "status-not-announced", selector: "#hidden-note", label: "Three items loaded." }
  ]);
  expect(result.findings[0]?.summary).toContain("Pressing “Copy link” with Enter shows this text");
});

test("the sweep reports a request a press sends that fails when the page shows and says nothing", async ({
  page
}) => {
  const html = `<!doctype html>
<html lang="en">
  <head><title>Failures</title></head>
  <body>
    <main>
      <h1>Failures</h1>
      <button id="silent" type="button">Save</button>
      <button id="offline" type="button">Upload</button>
      <button id="alerted" type="button">Send</button>
      <button id="shown" type="button">Publish</button>
      <p id="plain"></p>
      <button id="image" type="button">Preview</button>
      <button id="succeeds" type="button">Refresh</button>
    </main>
    <script>
      const on = (id, handler) => document.getElementById(id).addEventListener("click", handler);
      const send = (path) => fetch(path).then((response) => response.ok, () => false);
      on("silent", () => send("/api/broken"));
      // Nothing listens on port 9, so the request gets no response at all.
      on("offline", () => send("http://127.0.0.1:9/api/upload"));
      on("alerted", async () => {
        if (await send("/api/broken")) return;
        document.querySelector("main").insertAdjacentHTML("beforeend", '<p role="alert">Could not send.</p>');
      });
      on("shown", async () => {
        if (!(await send("/api/broken"))) document.getElementById("plain").textContent = "Could not publish.";
      });
      // A missing image is no action's result.
      on("image", () => {
        const image = new Image();
        image.alt = "";
        image.src = "/missing.png";
        document.querySelector("main").append(image);
      });
      on("succeeds", () => send("/api/fine"));
    </script>
  </body>
</html>`;
  const server = await startHtmlServer((request, response) => {
    if (request.url === "/") response.writeHead(200, { "content-type": "text/html" }).end(html);
    else if (request.url === "/api/fine") response.writeHead(204).end();
    else response.writeHead(request.url === "/api/broken" ? 500 : 404).end();
  });
  try {
    const result = await sweepKeyboardAndPointer({
      page,
      url: `${server.origin}/`,
      activateControls: true
    });

    // An alert says the failure; a message the page shows but does not say is its own finding.
    expect(result.findings.map(({ kind, selector }) => ({ kind, selector }))).toEqual([
      { kind: "failure-not-announced", selector: "#silent" },
      { kind: "failure-not-announced", selector: "#offline" },
      { kind: "status-not-announced", selector: "#plain" }
    ]);
    expect(result.findings[0]?.summary).toContain("(GET, status 500)");
    expect(result.findings[1]?.summary).toContain("(GET, no response)");
  } finally {
    await server.close();
  }
});

test("a press that shows a new view is no message, and one in an open dialog is read", async ({
  page
}) => {
  // As a single-page app does: signing in swaps the main content for a new view at the same
  // address, and saving in a dialog that is already open shows its error inside it.
  const html = `<!doctype html>
<html lang="en">
  <head><title>Albums</title></head>
  <body>
    <main id="sign-in-view">
      <h1>Albums</h1>
      <button id="sign-in" type="button">Sign in</button>
      <dialog open aria-label="Edit story">
        <button id="save" type="button">Save</button>
        <p id="save-error"></p>
      </dialog>
    </main>
    <script>
      document.getElementById("sign-in").addEventListener("click", () => {
        const view = document.createElement("main");
        view.innerHTML = "<h1>Your albums</h1><p>Every story you keep lives here.</p>";
        document.getElementById("sign-in-view").replaceWith(view);
      });
      document.getElementById("save").addEventListener("click", async () => {
        const response = await fetch("/api/save").catch(() => undefined);
        if (!response?.ok) document.getElementById("save-error").textContent = "Could not save.";
      });
    </script>
  </body>
</html>`;
  const server = await startHtmlServer((request, response) => {
    if (request.url === "/") response.writeHead(200, { "content-type": "text/html" }).end(html);
    else response.writeHead(500).end();
  });
  try {
    const result = await sweepKeyboardAndPointer({
      page,
      url: `${server.origin}/`,
      activateControls: true
    });

    // The new view is not a message, though focus is lost with the button it removed. The failed
    // save shows its error in the open dialog, where no live region says it: that error is the
    // finding, not a failure nobody is told about.
    expect(result.findings.map(({ kind, selector }) => ({ kind, selector }))).toEqual([
      { kind: "focus-lost", selector: "#sign-in" },
      { kind: "status-not-announced", selector: "#save-error" }
    ]);
  } finally {
    await server.close();
  }
});

test("the sweep reports an item that stands out from its like neighbours by colour alone", async ({
  page
}) => {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <title>Colours</title>
    <style>
      a { color: #1f2937; border-bottom: 2px solid transparent; }
      .current { color: #1d4ed8; }
      #bold .current { font-weight: 700; }
      #bar .current { border-bottom-color: #1d4ed8; }
      #icon .current::before { content: "› "; }
      #light .current { color: #93c5fd; }
      #filled .current { background-color: #dbeafe; }
      .off { color: #b91c1c; }
      button[disabled] { opacity: 0.5; }
      #swatches li:nth-child(1) { color: #b91c1c; }
      #swatches li:nth-child(2) { color: #15803d; }
      #swatches li:nth-child(3) { color: #1d4ed8; }
    </style>
  </head>
  <body>
    <main>
      <h1>Colours</h1>
      <nav id="colour" aria-label="Colour only">
        <a href="#a">Home</a><a href="#b" class="current" aria-current="page">Reports</a><a href="#c">Help</a>
      </nav>
      <nav id="bold" aria-label="Also bold">
        <a href="#a">Home</a><a href="#b" class="current" aria-current="page">Reports</a><a href="#c">Help</a>
      </nav>
      <nav id="bar" aria-label="Also a bar">
        <a href="#a">Home</a><a href="#b" class="current" aria-current="page">Reports</a><a href="#c">Help</a>
      </nav>
      <nav id="icon" aria-label="Also an icon">
        <a href="#a">Home</a><a href="#b" class="current" aria-current="page">Reports</a><a href="#c">Help</a>
      </nav>
      <nav id="light" aria-label="Much lighter">
        <a href="#a">Home</a><a href="#b" class="current" aria-current="page">Reports</a><a href="#c">Help</a>
      </nav>
      <nav id="filled" aria-label="Filled">
        <a href="#a">Home</a><a href="#b" class="current" aria-current="page">Reports</a><a href="#c">Help</a>
      </nav>
      <ul id="pills"><li>Active</li><li>Active</li><li class="off">Inactive</li></ul>
      <ul id="pair"><li>Yes</li><li class="off">No</li></ul>
      <ul id="swatches"><li>Red</li><li>Green</li><li>Blue</li></ul>
      <div id="tools"><button>Cut</button><button>Copy</button><button disabled>Paste</button></div>
    </main>
  </body>
</html>`;
  const result = await sweepKeyboardAndPointer({
    page,
    url: `data:text/html,${encodeURIComponent(html)}`,
    activateControls: false
  });

  // Not reported: the same item also bold, with a bar, with an icon, 3:1 lighter or filled; pills
  // whose words differ; a pair, too few to say what is usual; a row where every item differs; a
  // disabled button.
  const colourOnly = result.findings.filter(({ kind }) => kind === "colour-only");
  expect(colourOnly.map(({ selector, label }) => ({ selector, label }))).toEqual([
    { selector: "#colour > a:nth-of-type(2)", label: "Reports" }
  ]);
  expect(colourOnly[0]?.summary).toContain("Stands out from its 2 neighbours by colour alone");
  expect(colourOnly[0]?.summary).toContain("color: rgb(29, 78, 216) instead of rgb(31, 41, 55)");
  expect(colourOnly[0]?.summary).toContain('It is marked aria-current="page"');
});

test("the sweep reports an image that may be words drawn as pixels", async ({ page }) => {
  const svg = (body: string, width = 480, height = 96) =>
    `data:image/svg+xml,${encodeURIComponent(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${body}</svg>`
    )}`;
  const words = `<rect width="100%" height="100%" fill="#142824"/><text x="20" y="60" fill="#f1f8f5" font-size="28" font-family="sans-serif">Spring sale: 40% off</text>`;
  const photo = `<defs><linearGradient id="g"><stop offset="0" stop-color="#f97316"/><stop offset="0.5" stop-color="#7c3aed"/><stop offset="1" stop-color="#0ea5e9"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>`;
  const html = `<!doctype html>
<html lang="en">
  <head><title>Images</title></head>
  <body>
    <main>
      <h1>Images</h1>
      <img id="banner" src="${svg(words)}" alt="Spring sale: 40% off" width="480" height="96" />
      <img id="logo" src="${svg(words)}" alt="Spring Shop logo" width="480" height="96" />
      <img id="photo" src="${svg(photo)}" alt="Sunset over the harbour" width="480" height="96" />
      <img id="chart" src="${svg(words)}" alt="Chart of sales by month" width="480" height="96" />
      <img id="icon" src="${svg(words, 48, 48)}" alt="Open settings" width="48" height="48" />
      <img id="word" src="${svg(words)}" alt="Sale" width="480" height="96" />
      <img id="screenshot" src="${svg(words)}" alt="The report's summary row, with its result and a link to the full report" width="480" height="96" />
      <img id="blank" src="${svg('<rect width="100%" height="100%" fill="#142824"/>')}" alt="Spring sale soon" width="480" height="96" />
    </main>
  </body>
</html>`;
  const result = await sweepKeyboardAndPointer({
    page,
    url: `data:text/html,${encodeURIComponent(html)}`,
    activateControls: false
  });

  // Not reported: a logo, a photograph-like gradient, a chart, a square icon, a one-word name, a
  // long name that describes a picture, and an image of one colour.
  expect(
    result.findings
      .filter(({ kind }) => kind === "text-in-image")
      .map(({ selector, label }) => ({ selector, label }))
  ).toEqual([{ selector: "#banner", label: "Spring sale: 40% off" }]);
});
