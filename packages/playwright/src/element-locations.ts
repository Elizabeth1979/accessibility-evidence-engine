/** Where an element sits on the whole page, so a report can point at it on a full-page screenshot. */
export interface ElementLocation {
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
}

export interface ElementLocationPage {
  evaluate<Arg>(pageFunction: (arg: Arg) => unknown, arg: Arg): Promise<unknown>;
}

/**
 * Locates the first element each selector matches, in page coordinates. A selector that matches
 * nothing, or does not parse, gets null, so the result lines up with the selectors.
 */
export async function locateElements(
  page: ElementLocationPage,
  selectors: string[]
): Promise<Array<ElementLocation | null>> {
  return (await page.evaluate((requested: string[]) => {
    const root = document.documentElement;
    const pageWidth = Math.max(root.scrollWidth, document.body?.scrollWidth ?? 0);
    const pageHeight = Math.max(root.scrollHeight, document.body?.scrollHeight ?? 0);
    const find = (selector: string): Element | null => {
      try {
        return selector ? document.querySelector(selector) : null;
      } catch {
        return null;
      }
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
