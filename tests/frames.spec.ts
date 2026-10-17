import { readFile } from "node:fs/promises";

import { expect, test, type Frame, type Page } from "@playwright/test";

import {
  captureElementMap,
  createPortableVirtualScreenReader,
  fetchAccessibilityTree,
  findHeadingLookalikes,
  runAeeOnPage,
  withPageSessions
} from "@aee/playwright";

import { startHtmlServer } from "./scenario-helpers";

// Site isolation renders a cross-site frame in a process of its own, as desktop Chrome does by
// default. Playwright's own out-of-process iframe tests launch Chromium the same way.
test.use({ launchOptions: { args: ["--site-per-process"] } });

/**
 * A page on 127.0.0.1 with a same-origin frame and a cross-site frame on localhost (another site,
 * so another process), each bordered, padded and placed, so a box is right only if it counts the
 * frame's position, border and padding.
 */
async function framedPage(page: Page) {
  const server = await startHtmlServer((request, response) => {
    // The same server under another host name: localhost is another site than 127.0.0.1.
    const otherSite = `http://${request.headers.host!.replace("127.0.0.1", "localhost")}`;
    const inner = `<!doctype html><html lang="en"><head><title>Inside</title></head>
      <body style="margin:0">
        <h2 style="margin:12px 0 0 9px">Billing details</h2>
        <div style="font-size:30px;font-weight:700">Payment method</div>
        <p>Cards and bank transfers are accepted for every invoice on the account.</p>
        <button type="button">Pay now</button>
      </body></html>`;
    const pages: Record<string, string> = {
      "/": `<!doctype html><html lang="en"><head><title>Frames</title></head>
        <body style="margin:8px">
          <main>
            <section aria-label="Intro"><div><h1>Invoices</h1></div></section>
            <p>Review the bills below before paying them from this page.</p>
            <iframe id="same" title="Billing, same origin" src="/inner"
              style="position:absolute;left:40px;top:220px;width:420px;height:260px;border:5px solid;padding:7px"></iframe>
            <iframe id="cross" title="Billing, other site" src="${otherSite}/inner?session=abc123#access_token=xyz"
              style="position:absolute;left:520px;top:900px;width:420px;height:260px;border:3px solid;padding:4px"></iframe>
            <div style="height:1400px"></div>
            <h2>After the frames</h2>
          </main>
        </body></html>`,
      "/inner": inner
    };
    const body = pages[new URL(request.url ?? "/", "http://localhost").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  await page.goto(`${server.origin}/`);
  const same = frameAt(page, "127.0.0.1", "/inner");
  const cross = frameAt(page, "localhost", "/inner");
  await Promise.all([same, cross].map((frame) => frame.locator("button").waitFor()));
  return { server, same, cross };
}

function frameAt(page: Page, hostname: string, pathname: string): Frame {
  return page.frames().find((frame) => {
    const url = new URL(frame.url());
    return url.hostname === hostname && url.pathname === pathname;
  })!;
}

/**
 * Where an element is on the page by the CSS box model, measured in the page itself: the
 * element's box in its frame, plus each frame element's box, border and padding above it.
 */
async function pageBox(frame: Frame, selector: string) {
  const box = await frame.locator(selector).evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  });
  for (let child = frame; child.parentFrame(); child = child.parentFrame()!) {
    const holder = await child.frameElement();
    const inset = await holder.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        x: rect.x + element.clientLeft + Number.parseFloat(style.paddingLeft),
        y: rect.y + element.clientTop + Number.parseFloat(style.paddingTop)
      };
    });
    box.x += inset.x;
    box.y += inset.y;
  }
  const scroll = await frame.page().evaluate(() => ({ x: scrollX, y: scrollY }));
  return { ...box, x: box.x + scroll.x, y: box.y + scroll.y };
}

test("the accessibility tree is read in every frame, the cross-site one through its own session", async ({
  page,
  context
}) => {
  const { server } = await framedPage(page);
  try {
    // The cross-site frame is rendered in another process: Playwright gives it a session of its own.
    const cross = frameAt(page, "localhost", "/inner");
    await (await context.newCDPSession(cross)).detach();

    const tree = await withPageSessions(context, page, fetchAccessibilityTree);

    expect(tree.framesNotRead).toBeUndefined();
    expect(
      tree.frames?.map(({ url, parentFrameId }) => ({ url, child: Boolean(parentFrameId) }))
    ).toEqual([
      { url: expect.stringMatching(/127\.0\.0\.1:\d+\/$/), child: false },
      { url: expect.stringMatching(/127\.0\.0\.1:\d+\/inner$/), child: true },
      // A frame's address is kept without its query values or fragment, which can hold tokens.
      { url: expect.stringMatching(/localhost:\d+\/inner\?session=%5BREDACTED%5D$/), child: true }
    ]);
    // Each frame's own <iframe> element in the top document holds it.
    const iframes = tree.nodes.filter(({ role }) => role?.value === "Iframe");
    expect(tree.frames?.slice(1).map(({ ownerBackendNodeId }) => ownerBackendNodeId)).toEqual(
      iframes.map(({ backendDOMNodeId }) => backendDOMNodeId)
    );
    const buttons = tree.nodes.filter(({ role }) => role?.value === "button");
    expect(buttons.map(({ name, frameId }) => ({ name: name?.value, frameId }))).toEqual(
      tree.frames!.slice(1).map(({ frameId }) => ({ name: "Pay now", frameId }))
    );
  } finally {
    await server.close();
  }
});

test("the element map lists headings inside frames, in document order, at their place on the page", async ({
  page,
  context
}) => {
  const { server, same, cross } = await framedPage(page);
  try {
    // The page and the cross-site frame are both scrolled; a box counts each scroll.
    await page.evaluate(() => scrollTo(0, 120));
    await cross.evaluate(() => {
      document.body.style.height = "2000px";
      scrollTo(0, 10);
    });
    const map = await withPageSessions(context, page, captureElementMap);
    const headings = map.elements.filter(({ kind }) => kind === "heading");

    // Before, only the top document was read, and in Chrome's breadth-first order the nested
    // "Invoices" came after "After the frames"; now frames are read where they sit.
    expect(headings.map(({ name, framePath }) => ({ name, framePath }))).toEqual([
      { name: "Invoices", framePath: undefined },
      { name: "Billing details", framePath: ["#same"] },
      { name: "Billing details", framePath: ["#cross"] },
      { name: "After the frames", framePath: undefined }
    ]);
    const [, inSame, inCross] = headings;
    expect(inSame!.box).toEqual(await pageBox(same, "h2"));
    expect(inCross!.box).toEqual(await pageBox(cross, "h2"));
    expect(inCross!.box).toEqual(
      expect.objectContaining({ x: 520 + 3 + 4 + 9, y: 900 + 3 + 4 + 12 - 10 })
    );
  } finally {
    await server.close();
  }
});

test("a title styled as a heading is found inside a cross-site frame", async ({
  page,
  context
}) => {
  const { server } = await framedPage(page);
  try {
    const lookalikes = await withPageSessions(context, page, findHeadingLookalikes);

    expect(lookalikes.map(({ text, framePath }) => ({ text, framePath }))).toEqual([
      { text: "Payment method", framePath: ["#same"] },
      { text: "Payment method", framePath: ["#cross"] }
    ]);
  } finally {
    await server.close();
  }
});

test("focus and the saved accessibility tree reach inside a cross-site frame", async ({
  page
}, testInfo) => {
  const { server, cross } = await framedPage(page);
  try {
    const result = await runAeeOnPage({
      page,
      projectRoot: process.cwd(),
      outputDir: testInfo.outputPath("cross-frame-focus"),
      observers: ["focus", "accessibility-tree"],
      judges: ["release"],
      checkpointName: "cross-frame-focus",
      interaction: { kind: "focus", actor: "test" },
      async performInteraction() {
        await cross.locator("button").focus();
      }
    });
    const report = JSON.parse(
      await readFile(
        result.reporterFiles.find((file) => file.endsWith("aee-report.json"))!,
        "utf8"
      )
    ) as { records: Array<{ observerId: string; phase: string; meta?: Record<string, unknown> }> };
    const after = report.records.find(
      ({ observerId, phase }) => observerId === "focus" && phase === "after"
    );

    // Before, only the top document was read, so focus in any frame was "not exposed".
    expect(
      (after?.meta?.focusTarget as { accessibilityFocus?: unknown }).accessibilityFocus
    ).toEqual(
      expect.objectContaining({
        status: "matched",
        role: "button",
        name: "Pay now",
        frameId: expect.any(String)
      })
    );
    // The accessibility-tree evidence holds every frame's nodes, each with its frame.
    const tree = report.records.find(
      ({ observerId, phase }) => observerId === "accessibility-tree" && phase === "after"
    );
    const buttons = (
      tree?.meta?.semanticNodes as Array<{ role: string; name?: string; frameId?: string }>
    ).filter(({ role }) => role === "button");
    expect(buttons.map(({ name }) => name)).toEqual(["Pay now", "Pay now"]);
    expect(new Set(buttons.map(({ frameId }) => frameId)).size).toBe(2);
  } finally {
    await server.close();
  }
});

test("Guidepup's reader reads each frame as one item and does not enter it", async ({ page }) => {
  const { server } = await framedPage(page);
  try {
    const reader = createPortableVirtualScreenReader(page);
    const said: string[] = [(await reader.command("start")).announcement];
    for (let step = 0; step < 20; step++) {
      const entry = await reader.command("next-item");
      if (!entry.item) break;
      said.push(entry.announcement);
    }
    const frames = (await reader.snapshot()).entries.filter(({ item }) => item?.role === "Iframe");

    // @guidepup/virtual-screen-reader 0.32 walks childNodes, so a frame's document is never read:
    // it says the frame's title and moves on. NVDA and JAWS read a frame's content in place.
    expect(frames.map(({ announcement }) => announcement)).toEqual([
      "Billing, same origin",
      "Billing, other site"
    ]);
    expect(said).not.toContain("heading, Billing details, level 2");
    // Each item names its frame, so it joins to that frame's accessibility tree and no other.
    expect(new Set(frames.map(({ item }) => item?.frameId)).size).toBe(1);
    expect(frames[0]?.item?.visualBounds).toEqual({ x: 40, y: 220, width: 444, height: 284 });
  } finally {
    await server.close();
  }
});
