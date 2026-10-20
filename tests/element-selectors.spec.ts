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

interface FocusJudgmentReport {
  records: Array<{ observerId: string; phase: string; meta?: Record<string, unknown> }>;
  judgments: Array<{ judgeId: string; verdict: string; summary: string }>;
}

/** An interaction's target as a scenario gives it: a selector, or a role and name. */
type InteractionTarget = { selector: string } | { role: "button" | "link"; name: string };

/** The element `target` names, found as a scenario's action finds it. */
const locate = (page: Page, target: InteractionTarget) =>
  "selector" in target
    ? page.locator(target.selector)
    : page.getByRole(target.role, { name: target.name, exact: true });

/**
 * Runs an interaction on `target` and returns the focus judge's judgment, with the element that
 * has focus afterwards as the focus observer wrote it. By default it is a focus action, as a
 * scenario's focus step runs it (`focusExpectation: "target"`); a hover expects focus to stay
 * where it was (`preserve`).
 */
async function judgeFocusOn(
  page: Page,
  outputDir: string,
  target: string | InteractionTarget,
  interact?: () => Promise<void>,
  expectation: "target" | "preserve" = "target"
) {
  const requested = typeof target === "string" ? { selector: target } : target;
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir,
    observers: ["focus"],
    judges: ["focus-management"],
    checkpointName: "focus-target",
    interaction: {
      kind: expectation === "preserve" ? "hover" : "focus",
      actor: "test",
      target: requested,
      meta: { focusExpectation: expectation }
    },
    performInteraction: interact ?? (() => locate(page, requested).focus())
  });
  const report = JSON.parse(
    await readFile(
      result.reporterFiles.find((file) => file.endsWith("aee-report.json"))!,
      "utf8"
    )
  ) as FocusJudgmentReport;
  const after = report.records.find(
    (record) => record.observerId === "focus" && record.phase === "after"
  )?.meta?.focusTarget as { deepActiveElement: { nodePath: string; framePath?: string[] } };
  return {
    judgment: report.judgments.find(({ judgeId }) => judgeId === "focus-management")!,
    focused: after.deepActiveElement
  };
}

/**
 * Two identical Save buttons: the first in an embedded frame, the second in the page, above a
 * Help link. Focusing the page's Save button, or hovering Help (`on`), moves focus to the frame's
 * Save button, as a misplaced focus handler would.
 */
async function showTwoSaveButtons(page: Page, on: "focus" | "hover" = "focus") {
  const [trigger, event] = on === "focus" ? ["main > button", "focus"] : ["a", "mouseenter"];
  await page.setContent(`
    <iframe title="Draft" srcdoc="<main><button type='button'>Save</button></main>"></iframe>
    <main><button type="button">Save</button></main>
    <a href="#help">Help</a>
    <script>
      document.querySelector("${trigger}").addEventListener("${event}", () => {
        document.querySelector("iframe").contentDocument.querySelector("button").focus();
      });
    </script>
  `);
  await page.frameLocator("iframe").locator("button").waitFor();
}

test("the focus judge fails focus on a different button whose path reads the same", async ({
  page
}, testInfo) => {
  await showTwoSaveButtons(page);
  const selector = "button";

  const { judgment, focused } = await judgeFocusOn(page, testInfo.outputPath("other"), selector);

  // The frame's button has the same path in its own document as the scenario's selector, so
  // comparing the two as text passed it. It is not the element the selector selects.
  expect(focused.framePath).toHaveLength(1);
  expect(focused.nodePath).toBe(selector);
  expect(judgment.verdict).toBe("fail");
});

test("the focus judge passes the requested element however its selector is written", async ({
  page
}, testInfo) => {
  await page.setContent(`<form><button id="save" type="submit">Save</button></form>`);
  const selector = 'form > button[type="submit"]';

  const { judgment, focused } = await judgeFocusOn(page, testInfo.outputPath("same"), selector);

  // axe writes the button as "#save"; the scenario's selector selects the same button.
  expect(focused.nodePath).toBe("#save");
  expect(judgment.verdict).toBe("pass");
});

test("the focus judge finds the requested element in a shadow root, and not its host", async ({
  page
}, testInfo) => {
  await page.setContent(`<save-bar></save-bar>`);
  await page.evaluate(() => {
    const host = document.querySelector("save-bar")!;
    host.attachShadow({ mode: "open" }).innerHTML = `<button type="button">Save</button>`;
    host.setAttribute("tabindex", "-1");
  });

  // Playwright's selector reaches into the open shadow root, as the scenario's action does.
  const inside = await judgeFocusOn(page, testInfo.outputPath("inside"), "save-bar button");
  expect(inside.focused.nodePath).toBe("save-bar >>> button");
  expect(inside.judgment.verdict).toBe("pass");

  // The host is requested, but focus is on the button inside it.
  const host = await judgeFocusOn(page, testInfo.outputPath("host"), "save-bar", () =>
    page.locator("save-bar button").focus()
  );
  expect(host.judgment.verdict).toBe("fail");
});

test("the focus judge leaves focus unknown when the selector selects several elements", async ({
  page
}, testInfo) => {
  await page.setContent(`<button type="button">Save</button><button type="button">Save</button>`);

  const { judgment } = await judgeFocusOn(page, testInfo.outputPath("several"), "button", () =>
    page.locator("button").first().focus()
  );

  expect(judgment.verdict).toBe("unknown");
  expect(judgment.summary).toMatch(/selector button matches 2 elements/);
});

const SAVE = { role: "button", name: "Save" } as const;

test("the focus judge fails focus on another button with the requested role and name", async ({
  page
}, testInfo) => {
  await showTwoSaveButtons(page);

  const { judgment, focused } = await judgeFocusOn(page, testInfo.outputPath("other-role"), SAVE);

  // The frame's button is a button named "Save" too, so comparing role and name passed it.
  // Playwright's getByRole, as the action used it, finds the page's button.
  expect(focused.framePath).toHaveLength(1);
  expect(judgment.verdict).toBe("fail");
  expect(judgment.summary).toMatch(
    /requested target \(button named "Save"\).*at iframe >>> button/
  );
});

test("the focus judge passes focus on the one button with the requested role and name", async ({
  page
}, testInfo) => {
  await page.setContent(`<form><button id="save" type="submit">Save</button></form>`);

  const { judgment } = await judgeFocusOn(page, testInfo.outputPath("one-role"), SAVE);

  expect(judgment.verdict).toBe("pass");
});

test("the focus judge leaves focus unknown when several elements have the requested role and name", async ({
  page
}, testInfo) => {
  await page.setContent(`<button type="button">Save</button><button type="button">Save</button>`);

  const { judgment } = await judgeFocusOn(page, testInfo.outputPath("several-role"), SAVE, () =>
    locate(page, SAVE).first().focus()
  );

  expect(judgment.verdict).toBe("unknown");
  expect(judgment.summary).toMatch(/button named "Save" matches 2 elements/);
});

test("the focus judge fails a hover that moves focus to an identical button in a frame", async ({
  page
}, testInfo) => {
  await showTwoSaveButtons(page, "hover");
  await locate(page, SAVE).focus();
  const help = { role: "link", name: "Help" } as const;

  const { judgment, focused } = await judgeFocusOn(
    page,
    testInfo.outputPath("hover-moves"),
    help,
    () => locate(page, help).hover(),
    "preserve"
  );

  // Before and after, focus is on a button named "Save" whose path in its own document reads the
  // same, so comparing path, id, role and name said focus stayed.
  expect(focused.framePath).toHaveLength(1);
  expect(judgment.verdict).toBe("fail");
});

test("the focus judge passes a hover that leaves focus where it was, though its path changed", async ({
  page
}, testInfo) => {
  await page.setContent(`
    <main><button type="button">Save</button><button type="button">Help</button></main>
    <script>
      document.querySelector("main > button + button").addEventListener("mouseenter", () => {
        document.querySelector("main").insertAdjacentHTML("afterbegin", '<p role="status" style="position: absolute">Opens the help pages.</p>');
      });
    </script>
  `);
  await locate(page, SAVE).focus();
  const help = { role: "button", name: "Help" } as const;

  const { judgment } = await judgeFocusOn(
    page,
    testInfo.outputPath("hover-stays"),
    help,
    () => locate(page, help).hover(),
    "preserve"
  );

  // The tip put before Save changes Save's shortest path, so comparing paths said focus moved.
  // Focus is on the same element.
  expect(judgment.verdict).toBe("pass");
});
