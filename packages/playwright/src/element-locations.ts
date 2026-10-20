import type { ElementLocation } from "@aee/schemas";

import type { AxeTargetStep } from "./axe-results";

export type { ElementLocation } from "@aee/schemas";

export interface ElementLocationPage {
  evaluate<Arg>(pageFunction: (arg: Arg) => unknown, arg: Arg): Promise<unknown>;
}

/**
 * Locates the first element each selector matches, in page coordinates. A selector may be a path
 * through shadow roots, as axe's targets give one: each next selector is matched inside the
 * shadow root of the element before it. A selector that matches nothing, or does not parse, gets
 * null, so the result lines up with the selectors.
 */
export async function locateElements(
  page: ElementLocationPage,
  selectors: AxeTargetStep[]
): Promise<Array<ElementLocation | null>> {
  return (await page.evaluate((requested: AxeTargetStep[]) => {
    const root = document.documentElement;
    const pageWidth = Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0);
    const pageHeight = Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0);
    const find = (step: AxeTargetStep): Element | null => {
      let element: Element | null = null;
      let scope: ParentNode | null = document;
      try {
        for (const selector of typeof step === "string" ? [step] : step) {
          element = selector && scope ? scope.querySelector(selector) : null;
          scope = element?.shadowRoot ?? null;
        }
      } catch {
        return null;
      }
      return element;
    };
    return requested.map((selector) => {
      const element = find(selector);
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: rect.left + scrollX,
        y: rect.top + scrollY,
        width: rect.width,
        height: rect.height,
        pageWidth,
        pageHeight
      };
    });
  }, selectors)) as Array<ElementLocation | null>;
}
