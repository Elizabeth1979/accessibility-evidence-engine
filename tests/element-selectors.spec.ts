import { readFile } from "node:fs/promises";

import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

import {
  captureElementMap,
  createPortableVirtualScreenReader,
  describeAxeTarget,
  runAeeOnPage,
  sweepKeyboardAndPointer,
  withPageSessions
} from "@aee/playwright";

import { startHtmlServer } from "./scenario-helpers";

/** An element wrapped in this many plain `<div>`s. */
const nested = (depth: number, inner: string) =>
  Array.from({ length: depth }).reduce<string>((html) => `<div>${html}</div>`, inner);

const DOT = `data:image/svg+xml,${encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20"/></svg>'
)}`;

/**
 * Two shelves built the same way, each two unnamed buttons and two images with no alt text deep
 * inside it, so the last eight steps up to each element are the same on both shelves. Then a
 * component whose unnamed button and image sit in its shadow root, after a named button in the
 * page that a selector ignoring the shadow root would find first.
 */
const SHELF = `<ul>${`<li><button type="button"></button><img src="${DOT}"></li>`.repeat(2)}</ul>`;
const PAGE = `<!doctype html><html lang="en"><head><title>Orders</title></head><body>
  <main>
    <h1>Orders</h1>
    <section><h2>Spring</h2>${nested(10, SHELF)}</section>
    <section><h2>Autumn</h2>${nested(10, SHELF)}</section>
    <div><button type="button">Save</button><img src="${DOT}" alt="Saved"></div>
    <order-card></order-card>
  </main>
  <script>
    customElements.define("order-card", class extends HTMLElement {
      constructor() {
        super();
        this.attachShadow({ mode: "open" }).innerHTML =
          '<div><button type="button"></button><img src="${DOT}"></div>';
      }
    });
  </script>
</body></html>`;

async function ordersPage(page: Page) {
  const server = await startHtmlServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(PAGE);
  });
  const url = `${server.origin}/`;
  await page.goto(url);
  return { server, url };
}

/** axe's own path to each element it reports for a rule, as AEE writes one in a line. */
async function axeTargets(page: Page, rule: string): Promise<string[]> {
  const { violations } = await new AxeBuilder({ page }).withRules([rule]).analyze();
  return violations.flatMap(({ nodes }) => nodes.map(({ target }) => describeAxeTarget(target)));
}

/**
 * How many elements a path selects, through the shadow roots its ">>>" steps into: one when it
 * points at its element alone.
 */
function selectedCount(page: Page, path: string): Promise<number> {
  return page.evaluate((steps) => {
    let scopes: ParentNode[] = [document];
    let found: Element[] = [];
    for (const step of steps) {
      found = scopes.flatMap((scope) => [...scope.querySelectorAll(step)]);
      scopes = found.flatMap((element) => (element.shadowRoot ? [element.shadowRoot] : []));
    }
    return found.length;
  }, path.split(" >>> "));
}

test("the reader names each element by axe's own path to it, which selects it alone", async ({
  page
}) => {
  const { server } = await ordersPage(page);
  try {
    const reader = createPortableVirtualScreenReader(page);
    const entries = [await reader.command("start")];
    while (entries.at(-1)!.item && entries.length < 200) {
      entries.push(await reader.command("next-item"));
    }
    const unnamed = entries
      .map(({ item }) => item)
      .filter((item) => item?.role === "button" && !item.name)
      .map((item) => item!.nodePath);

    // Before, the path stopped after eight steps, so the Spring and Autumn shelves' buttons had the
    // same two paths, which select the Spring shelf's. Guidepup's reader reads no shadow root
    // (guidepup/virtual-screen-reader#183), so the component's button is not read at all.
    expect(unnamed).toEqual((await axeTargets(page, "button-name")).slice(0, 4));
    for (const path of unnamed) expect(await selectedCount(page, path), path).toBe(1);
  } finally {
    await server.close();
  }
});

test("the element map points at each image as axe does", async ({ page, context }) => {
  const { server } = await ordersPage(page);
  try {
    const map = await withPageSessions(context, page, captureElementMap);
    const missing = map.elements
      .filter(({ kind, alt }) => kind === "image" && alt === "missing")
      .map(({ selector }) => selector);

    // Before, both shelves' images had the same two eight-step paths, and the component's image
    // had "html > body > main > order-card > div > img", which selects nothing.
    expect(missing).toEqual(await axeTargets(page, "image-alt"));
    for (const path of missing) expect(await selectedCount(page, path), path).toBe(1);
  } finally {
    await server.close();
  }
});

test("the focus observer names the focused control by axe's own path to it", async ({
  page
}, testInfo) => {
  const { server } = await ordersPage(page);
  try {
    // Focus starts on the Autumn shelf's second button and ends on the component's button.
    await page.locator("section").nth(1).locator("button").nth(1).focus();
    const result = await runAeeOnPage({
      page,
      projectRoot: process.cwd(),
      outputDir: testInfo.outputPath("focus-selectors"),
      observers: ["focus"],
      judges: ["release"],
      checkpointName: "focus-selectors",
      interaction: { kind: "focus", actor: "test" },
      async performInteraction() {
        await page.locator("order-card button").focus();
      }
    });
    const report = JSON.parse(
      await readFile(
        result.reporterFiles.find((file) => file.endsWith("aee-report.json"))!,
        "utf8"
      )
    ) as { records: Array<{ observerId: string; phase: string; meta?: Record<string, unknown> }> };
    const focused = (phase: string) =>
      (
        report.records.find((record) => record.observerId === "focus" && record.phase === phase)
          ?.meta?.focusTarget as { deepActiveElement: { nodePath: string } }
      ).deepActiveElement.nodePath;
    const [, , , autumnSecond, inComponent] = await axeTargets(page, "button-name");

    // Before, the path was every tag up from the button with no positions, the same for all four
    // shelf buttons, and the component's button was "div > button", the light page's first match.
    expect([focused("before"), focused("after")]).toEqual([autumnSecond, inComponent]);
    for (const path of [autumnSecond!, inComponent!])
      expect(await selectedCount(page, path)).toBe(1);
  } finally {
    await server.close();
  }
});

test("the sweep names each Tab stop by axe's own path to it", async ({ page }) => {
  const { server, url } = await ordersPage(page);
  try {
    const result = await sweepKeyboardAndPointer({ page, url, activateControls: false });
    const shelfButtons = (await axeTargets(page, "button-name")).slice(0, 4);

    // Before, the sweep wrote every step from <html> down by its position among same-tag siblings,
    // so a finding's place never matched axe's for the same button.
    expect(result.tabStops.slice(0, 4).map(({ selector }) => selector)).toEqual(shelfButtons);
  } finally {
    await server.close();
  }
});
