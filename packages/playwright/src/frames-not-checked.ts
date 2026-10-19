import { redactUrl } from "@aee/core";

import {
  accessibleElementOf,
  capturePageDom,
  fetchAccessibilityNode,
  type CapturedDom,
  type DomNodeRef,
  type PageSessions
} from "./accessibility-tree";

/**
 * A frame left out of the page's checks (`framesInsideOrigins`), such as one whose page is outside
 * the allowed origins. Its element is the page's own and is checked there; nothing inside it is
 * read.
 */
export interface FrameNotChecked {
  /** Its page's address, with no credentials, query values or fragment. */
  url: string;
  /** Why it was left out, naming the site when its page is outside the allowed origins. */
  reason: string;
  /** Its element's accessible name, as Chrome's accessibility tree gives it. */
  name: string;
  /**
   * Its element: a CSS selector in each document from the top one down, the way axe-core's
   * `target` lists a node inside frames.
   */
  selector: [string, ...string[]];
}

/**
 * The frames `framesInsideOrigins` left out of frames it kept, each with its element's name and
 * selector: the frames whose elements are on the page that is read. A frame whose element no
 * selector names on its own cannot be kept out of a check, so it fails rather than be read.
 */
export async function framesNotChecked(page: PageSessions): Promise<FrameNotChecked[]> {
  const leftOut = page.framesNotRead.filter(({ owner }) => owner);
  if (!leftOut.length) return [];
  const dom = await capturePageDom(page);
  return Promise.all(
    leftOut.map(async ({ url, reason, owner }) => {
      const selector = owner && (await selectorOf(dom, owner));
      if (!owner || !selector) {
        throw new Error(
          `No selector names the element that holds the frame at ${redactUrl(url)} on its own, so the frame cannot be kept out of the checks.`
        );
      }
      const node = await fetchAccessibilityNode(page, owner);
      return {
        url: redactUrl(url),
        reason,
        name: node ? accessibleElementOf(node).name : "",
        selector
      };
    })
  );
}

/** Where a locator is made: a page, or a frame of it (Playwright's `Page` and `FrameLocator`). */
export interface LocatorScope {
  locator(selector: string): unknown;
  frameLocator(selector: string): LocatorScope;
}

/**
 * Each frame's element as a Playwright locator, for a screenshot's `mask` option, which covers it
 * so nothing of the frame's page is kept.
 */
export function frameMasks(page: LocatorScope, frames: FrameNotChecked[]): unknown[] {
  return frames.map(({ selector }) =>
    selector
      .slice(0, -1)
      .reduce((scope, frameSelector) => scope.frameLocator(frameSelector), page)
      .locator(selector[selector.length - 1]!)
  );
}

/**
 * The element's path in each document from the top one down, axe-core's own (`CapturedDom.paths`),
 * which selects it alone in its document. Undefined when it, or a frame's element it is inside, is
 * gone or is inside a shadow root, where a selector in the document does not reach it.
 */
async function selectorOf(
  dom: CapturedDom,
  element: DomNodeRef
): Promise<[string, ...string[]] | undefined> {
  const [path] = await dom.paths([element]);
  if (!path) return undefined;
  const [outer, ...inner] = [...path.frames, path.element];
  return typeof outer === "string" && inner.every((step) => typeof step === "string")
    ? [outer, ...inner]
    : undefined;
}
