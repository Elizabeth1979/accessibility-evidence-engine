import { readFile } from "node:fs/promises";

import { expect, test, type Frame, type Page } from "@playwright/test";

import {
  captureElementMap,
  createPortableVirtualScreenReader,
  fetchAccessibilityTree,
  findHeadingLookalikes,
  renderPortableVirtualScreenReaderTranscript,
  runAeeOnPage,
  withPageSessions,
  type PortableVirtualScreenReader,
  type VirtualScreenReaderEntry
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

/** Reads on until the reader says `announcement`, as a user arrows down to it. */
async function readTo(reader: PortableVirtualScreenReader, announcement: string) {
  for (let step = 0; step < 50; step++) {
    const entry = await reader.command("next-item");
    if (entry.announcement === announcement) return entry;
    if (!entry.item) break;
  }
  throw new Error(`The reader never said "${announcement}"`);
}

/** Every step from the top of the page to its end, one item at a time. */
async function readThrough(reader: PortableVirtualScreenReader) {
  const entries = [await reader.command("start")];
  while (entries.at(-1)!.item && entries.length < 100) {
    entries.push(await reader.command("next-item"));
  }
  return entries;
}

/** Where an item is: the frame whose document holds it, and the frame elements it is inside. */
function placeOf({ item }: VirtualScreenReaderEntry) {
  return item && `${item.frameId} ${item.key}`;
}

const INSIDE_A_FRAME = [
  "heading, Billing details, level 2",
  "Payment method",
  "paragraph",
  "Cards and bank transfers are accepted for every invoice on the account.",
  "end of paragraph",
  "button, Pay now"
];

test("the reader reads each frame where it sits, the cross-site one in its own process", async ({
  page,
  context
}) => {
  const { server, cross } = await framedPage(page);
  try {
    const reader = createPortableVirtualScreenReader(page);
    const entries = await readThrough(reader);
    const { frames } = await withPageSessions(context, page, fetchAccessibilityTree);
    const [top, same, other] = frames!;
    const said = entries.map(({ announcement }) => announcement);

    // Before, the reader said each frame's title and moved past it. Now it reads each frame's
    // content in place, as NVDA and JAWS do, and Guidepup still says every word.
    expect(said.slice(said.indexOf("Billing, same origin"))).toEqual([
      "Billing, same origin",
      ...INSIDE_A_FRAME,
      "Billing, other site",
      ...INSIDE_A_FRAME,
      "heading, After the frames, level 2",
      "end of main",
      "end of document"
    ]);
    // Each item names the frame whose document holds it, and the frame elements it is inside.
    const at = (announcement: string, nth = 0) =>
      entries.filter((entry) => entry.announcement === announcement)[nth]!;
    expect(at("Billing, same origin").item).toEqual(
      expect.objectContaining({ role: "Iframe", frameId: top!.frameId })
    );
    expect(at("Billing, same origin").item?.framePath).toBeUndefined();
    for (const [title, frame, framePath] of [
      ["Billing, same origin", same!, ["#same"]],
      ["Billing, other site", other!, ["#cross"]]
    ] as const) {
      const first = entries.indexOf(at(title)) + 1;
      for (const { item } of entries.slice(first, first + INSIDE_A_FRAME.length)) {
        expect(item).toEqual(expect.objectContaining({ frameId: frame.frameId, framePath }));
      }
    }
    // The item joins to its own frame's accessibility tree, though node ids repeat across processes.
    const { nodes } = await withPageSessions(context, page, fetchAccessibilityTree);
    for (const nth of [0, 1]) {
      const { item } = at("button, Pay now", nth);
      const node = nodes.find(
        ({ frameId, backendDOMNodeId }) =>
          frameId === item!.frameId && backendDOMNodeId === item!.backendDOMNodeId
      );
      expect({ role: node?.role?.value, name: node?.name?.value }).toEqual({
        role: "button",
        name: "Pay now"
      });
    }
    expect(at("button, Pay now", 1).item?.visualBounds).toEqual(await pageBox(cross, "button"));

    // Where the reader goes into a frame and comes out of it, and what AEE notes in the transcript.
    const sameFrame = {
      frameId: same!.frameId,
      framePath: ["#same"],
      name: "Billing, same origin"
    };
    const otherFrame = {
      frameId: other!.frameId,
      framePath: ["#cross"],
      name: "Billing, other site"
    };
    expect(
      entries
        .filter(({ framesLeft, framesEntered }) => framesLeft || framesEntered)
        .map(({ announcement, framesLeft, framesEntered }) => ({
          announcement,
          framesLeft,
          framesEntered
        }))
    ).toEqual([
      { announcement: INSIDE_A_FRAME[0], framesLeft: undefined, framesEntered: [sameFrame] },
      { announcement: "Billing, other site", framesLeft: [sameFrame], framesEntered: undefined },
      { announcement: INSIDE_A_FRAME[0], framesLeft: undefined, framesEntered: [otherFrame] },
      {
        announcement: "heading, After the frames, level 2",
        framesLeft: [otherFrame],
        framesEntered: undefined
      }
    ]);
    const transcript = renderPortableVirtualScreenReaderTranscript(await reader.snapshot());
    expect(transcript).toMatch(
      /\nAEE: left frame Billing, other site\n\d+\. next-item: heading, After the frames, level 2\n/
    );
    expect(transcript).toMatch(
      /\nAEE: entered frame Billing, same origin\n\d+\. next-item: heading, Billing details, level 2\n/
    );
  } finally {
    await server.close();
  }
});

test("a step back retraces every step through the frames, and peeking leaves the reader in place", async ({
  page
}) => {
  const { server } = await framedPage(page);
  try {
    const reader = createPortableVirtualScreenReader(page);
    const forward = (await readThrough(reader)).map(placeOf).filter(Boolean);
    const back: string[] = [];
    for (let entry = await reader.command("previous-item"); entry.item;) {
      back.push(placeOf(entry)!);
      entry = await reader.command("previous-item");
    }
    // Back from below a frame goes in at its last item; back from its first item, out to its element.
    expect(back).toEqual(forward.reverse());

    await reader.command("start");
    await readTo(reader, "Billing, same origin");
    expect(await reader.peek("next-item")).toEqual(
      expect.objectContaining({ name: "Billing details", framePath: ["#same"] })
    );
    expect((await reader.command("read-current")).announcement).toBe("Billing, same origin");

    await readTo(reader, "button, Pay now");
    expect(await reader.peek("next-item")).toEqual(
      expect.objectContaining({ role: "Iframe", name: "Billing, other site" })
    );
    expect((await reader.command("read-current")).item?.framePath).toEqual(["#same"]);

    await readTo(reader, "heading, After the frames, level 2");
    expect(await reader.peek("previous-item")).toEqual(
      expect.objectContaining({ name: "Pay now", framePath: ["#cross"] })
    );
    expect((await reader.command("read-current")).announcement).toBe(
      "heading, After the frames, level 2"
    );
    // The step after the peeks goes where it would have gone without them.
    expect((await reader.command("previous-item")).item).toEqual(
      expect.objectContaining({ name: "Pay now", framePath: ["#cross"] })
    );
  } finally {
    await server.close();
  }
});

test("a heading jump goes into each frame and out again, both ways", async ({ page }) => {
  const { server } = await framedPage(page);
  try {
    const reader = createPortableVirtualScreenReader(page);
    await reader.command("start");
    const jump = async (command: "next-heading" | "previous-heading") => {
      const visited = [];
      for (let entry = await reader.command(command); entry.item;) {
        visited.push({
          said: entry.announcement,
          framePath: entry.item.framePath,
          left: entry.framesLeft?.map(({ name }) => name),
          entered: entry.framesEntered?.map(({ name }) => name)
        });
        entry = await reader.command(command);
      }
      return visited;
    };

    expect(await jump("next-heading")).toEqual([
      { said: "heading, Invoices, level 1" },
      {
        said: "heading, Billing details, level 2",
        framePath: ["#same"],
        entered: ["Billing, same origin"]
      },
      {
        said: "heading, Billing details, level 2",
        framePath: ["#cross"],
        left: ["Billing, same origin"],
        entered: ["Billing, other site"]
      },
      { said: "heading, After the frames, level 2", left: ["Billing, other site"] }
    ]);
    expect((await jump("previous-heading")).map(({ framePath }) => framePath)).toEqual([
      undefined,
      ["#cross"],
      ["#same"],
      undefined
    ]);
  } finally {
    await server.close();
  }
});

test("a frame inside a frame is read in place, and an empty frame is stepped over", async ({
  page,
  context
}) => {
  const server = await startHtmlServer((request, response) => {
    const otherSite = `http://${request.headers.host!.replace("127.0.0.1", "localhost")}`;
    const pages: Record<string, string> = {
      "/": `<!doctype html><html lang="en"><head><title>Account</title></head><body>
        <h1>Account</h1>
        <iframe id="outer" title="Settings" src="/settings"></iframe>
        <iframe id="empty" title="Nothing here" srcdoc=""></iframe>
        <h2>Done</h2>
      </body></html>`,
      "/settings": `<!doctype html><html lang="en"><head><title>Settings</title></head><body>
        <h2>Settings</h2>
        <iframe id="inner" title="Card" src="${otherSite}/card"></iframe>
        <h3>Saved</h3>
      </body></html>`,
      "/card": `<!doctype html><html lang="en"><head><title>Card</title></head><body>
        <button type="button">Update card</button>
      </body></html>`
    };
    const body = pages[new URL(request.url ?? "/", "http://localhost").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  try {
    await page.goto(`${server.origin}/`);
    await frameAt(page, "localhost", "/card").locator("button").waitFor();
    const reader = createPortableVirtualScreenReader(page);
    const entries = await readThrough(reader);
    const { frames } = await withPageSessions(context, page, fetchAccessibilityTree);
    const card = frames!.find(({ url }) => url.includes("localhost"))!;

    expect(
      entries.map(({ announcement, item, framesLeft, framesEntered }) => ({
        said: announcement,
        framePath: item?.framePath,
        left: framesLeft?.map(({ name }) => name),
        entered: framesEntered?.map(({ name }) => name)
      }))
    ).toEqual([
      { said: "heading, Account, level 1" },
      { said: "Settings" },
      { said: "heading, Settings, level 2", framePath: ["#outer"], entered: ["Settings"] },
      { said: "Card", framePath: ["#outer"] },
      { said: "button, Update card", framePath: ["#outer", "#inner"], entered: ["Card"] },
      { said: "heading, Saved, level 3", framePath: ["#outer"], left: ["Card"] },
      // The empty frame is read as its element; the step after it goes on past it.
      { said: "Nothing here", left: ["Settings"] },
      { said: "heading, Done, level 2" },
      { said: "end of document" }
    ]);
    expect(entries[4]!.item?.frameId).toBe(card.frameId);
    expect(entries[4]!.framesEntered?.[0]?.framePath).toEqual(["#outer", "#inner"]);

    const back: string[] = [];
    for (let entry = await reader.command("previous-item"); entry.item;) {
      back.push(placeOf(entry)!);
      entry = await reader.command("previous-item");
    }
    expect(back).toEqual(entries.map(placeOf).filter(Boolean).reverse());
  } finally {
    await server.close();
  }
});

test("DOM focus names the focused control inside a cross-site frame, not the frame", async ({
  page,
  context
}) => {
  const { server, cross } = await framedPage(page);
  try {
    await cross.locator("button").focus();
    const reader = createPortableVirtualScreenReader(page);
    const entry = await reader.command("start");
    const { frames, nodes } = await withPageSessions(context, page, fetchAccessibilityTree);
    const other = frames!.find(({ url }) => url.includes("localhost"))!;

    // Before, focus was read in the top document only, which names the <iframe>: "#cross".
    const inCross = {
      nodePath: "html > body > button",
      backendDOMNodeId: expect.any(Number),
      frameId: other.frameId,
      framePath: ["#cross"]
    };
    expect(entry).toEqual(
      expect.objectContaining({
        domFocusBefore: inCross,
        domFocusAfter: inCross,
        focusMoved: false
      })
    );
    // The focus joins to the button in its own frame's accessibility tree.
    const focused = nodes.find(
      ({ frameId, backendDOMNodeId }) =>
        frameId === entry.domFocusAfter!.frameId &&
        backendDOMNodeId === entry.domFocusAfter!.backendDOMNodeId
    );
    expect({ role: focused?.role?.value, name: focused?.name?.value }).toEqual({
      role: "button",
      name: "Pay now"
    });
    expect(renderPortableVirtualScreenReaderTranscript(await reader.snapshot())).toContain(
      "   DOM focus: #cross >>> html > body > button -> #cross >>> html > body > button; moved: no\n"
    );
  } finally {
    await server.close();
  }
});

test("focus moving between two controls inside one frame counts as moved", async ({ page }) => {
  const { server, cross } = await framedPage(page);
  try {
    await cross.locator("button").focus();
    // The frame moves focus on its own while the reader reads, as a page with a timer can: every
    // few milliseconds onto a new button, so focus is on another control at any later moment.
    await cross.evaluate(() => {
      let step = 0;
      const timer = setInterval(() => {
        const button = document.createElement("button");
        button.textContent = `Step ${++step}`;
        document.body.append(button);
        button.focus();
      }, 5);
      Object.assign(globalThis, { stopMoving: () => clearInterval(timer) });
    });
    const reader = createPortableVirtualScreenReader(page);
    const entry = await reader.command("start");
    await cross.evaluate(() => (globalThis as unknown as { stopMoving(): void }).stopMoving());

    // Before, both ends named the <iframe>, so a move inside the frame was "not moved".
    const before = entry.domFocusBefore!;
    const after = entry.domFocusAfter!;
    expect(entry.focusMoved).toBe(true);
    expect(before.frameId).toBe(after.frameId);
    expect([before.framePath, after.framePath]).toEqual([["#cross"], ["#cross"]]);
    expect(before.backendDOMNodeId).not.toBe(after.backendDOMNodeId);
    expect(before.nodePath).not.toBe(after.nodePath);
  } finally {
    await server.close();
  }
});

test("DOM focus is followed through a shadow root into the frame it holds", async ({ page }) => {
  const server = await startHtmlServer((request, response) => {
    const otherSite = `http://${request.headers.host!.replace("127.0.0.1", "localhost")}`;
    const pages: Record<string, string> = {
      "/": `<!doctype html><html lang="en"><head><title>Checkout</title></head><body>
        <h1>Checkout</h1>
        <payment-widget id="widget"></payment-widget>
        <script>
          const root = document.getElementById("widget").attachShadow({ mode: "open" });
          root.innerHTML = '<iframe id="card" title="Card" src="${otherSite}/card"></iframe>';
        </script>
      </body></html>`,
      "/card": `<!doctype html><html lang="en"><head><title>Card</title></head><body>
        <label>Card number <input id="number"></label>
      </body></html>`
    };
    const body = pages[new URL(request.url ?? "/", "http://localhost").pathname];
    response.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" }).end(body);
  });
  try {
    await page.goto(`${server.origin}/`);
    const card = frameAt(page, "localhost", "/card");
    await card.locator("#number").focus();
    const entry = await createPortableVirtualScreenReader(page).command("start");

    // The top document names the shadow host as its active element; its shadow root names the
    // frame, and the frame's own document the field.
    expect(entry.domFocusAfter).toEqual(
      expect.objectContaining({ nodePath: "#number", framePath: [expect.stringContaining("card")] })
    );
  } finally {
    await server.close();
  }
});
