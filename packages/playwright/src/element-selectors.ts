import type Axe from "axe-core";

import type { CdpSession } from "./accessibility-tree";
import { describeAxeTarget, type AxeTargetStep } from "./axe-results";
import { AXE_SCRIPT, callOn, loadPageScript, type PageObject } from "./frame-documents";

/**
 * How the page reaches an element's selector, once `loadElementSelectors` has loaded it: `stepOf`
 * gives axe-core's own path to the element in its document, a selector or a path through shadow
 * roots, exactly as axe writes it in a result's `target`; `textOf` writes that path in one line, as
 * `describeAxeTarget` does.
 */
export interface ElementSelectorsInPage {
  stepOf(element: Element): AxeTargetStep;
  textOf(element: Element): string;
}

/** The global the page holds its `ElementSelectorsInPage` in. */
export const ELEMENT_SELECTORS_GLOBAL = "__aeeElementSelectors";

/**
 * Made in the page from the axe-core it loaded and `describeAxeTarget`, and sent as source, so it
 * uses nothing from outside itself. axe's selector is the shortest one that selects the element
 * alone in its document or shadow root, checked against an index of the whole document
 * (`axe.setup`), which is most of the cost. So one index serves every element asked about in the
 * same task, and is dropped as the task ends (a microtask), before the page's own code runs again
 * and can change what is unique.
 */
function elementSelectorsInPage(
  axe: typeof Axe,
  describe: typeof describeAxeTarget
): ElementSelectorsInPage {
  let indexed = false;
  const stepOf = (element: Element): AxeTargetStep => {
    if (!indexed) {
      axe.setup(document);
      indexed = true;
      queueMicrotask(() => {
        axe.teardown();
        indexed = false;
      });
    }
    return new axe.utils.DqElement(element).selector[0]!;
  };
  return { stepOf, textOf: (element) => describe([stepOf(element)]) };
}

/**
 * Loads axe-core and `ElementSelectorsInPage` into a frame's own page through an object in it, such
 * as its `document`, once: a page that already has them keeps them.
 */
export async function loadElementSelectors(cdp: CdpSession, objectId: string): Promise<void> {
  await loadPageScript(cdp, objectId, AXE_SCRIPT);
  await callOn(
    cdp,
    objectId,
    `function () {
      if (typeof globalThis.${ELEMENT_SELECTORS_GLOBAL} === "object") return;
      globalThis.${ELEMENT_SELECTORS_GLOBAL} = (${elementSelectorsInPage})(
        globalThis.${AXE_SCRIPT.global},
        ${describeAxeTarget}
      );
    }`
  );
}

/**
 * Each element's path in its document, as axe-core writes it in a result's `target`
 * (`ElementSelectorsInPage.stepOf`), all in one task, so axe indexes the document once. The
 * elements are of one frame's document, and the call runs on the first of them, in that frame's
 * own page.
 */
export async function elementSelectors(
  cdp: CdpSession,
  elements: PageObject[]
): Promise<AxeTargetStep[]> {
  const [first] = elements;
  if (!first) return [];
  // One call when the page has the selectors already, which it has after the first.
  const read = () =>
    callOn<AxeTargetStep[] | null>(
      cdp,
      first.objectId,
      `function (...elements) {
        const selectors = globalThis.${ELEMENT_SELECTORS_GLOBAL};
        return selectors ? elements.map((element) => selectors.stepOf(element)) : null;
      }`,
      elements
    );
  const steps = await read();
  if (steps) return steps;
  await loadElementSelectors(cdp, first.objectId);
  return (await read())!;
}

/**
 * axe-core's path to an element across frames: the path of each `<iframe>` element it is inside,
 * outermost first, each in the document that holds it, then its own in its document. Together they
 * are the `target` axe gives the element.
 */
export interface ElementPath {
  frames: AxeTargetStep[];
  element: AxeTargetStep;
}

/**
 * An element's place as AEE's evidence names it: `nodePath`, its path in the document that holds
 * it, and `framePath`, its frames' paths, each in one line as `describeAxeTarget` writes a step.
 */
export function placeOf({ frames, element }: ElementPath): {
  nodePath: string;
  framePath: string[];
} {
  return {
    nodePath: describeAxeTarget([element]),
    framePath: frames.map((step) => describeAxeTarget([step]))
  };
}
