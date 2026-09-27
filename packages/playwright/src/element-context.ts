import type { ElementLocationPage } from "./element-locations";

/**
 * The page around an element, captured with the axe result so an AI specialist reads evidence,
 * never the live page. Text is trimmed and capped: it is only as much as a name needs.
 */
export interface ElementContext {
  tagName: string;
  role?: string;
  /** Visible text inside the element. */
  text: string;
  /** No text of its own, but an svg, img or icon element inside: the icon is all a sighted user sees. */
  iconOnly: boolean;
  /** What the markup says about the icon: an svg title, a sprite id, an img alt or file, icon classes, the id. */
  iconHints: string[];
  /** The nearest non-empty heading before it. */
  nearbyHeading?: string;
  /** The visible text of its closest container that has text besides the element's own. */
  nearbyText?: string;
  /** Where a link goes. */
  destination?: string;
  image?: {
    source?: string;
    alt?: string;
    title?: string;
    role?: string;
    ariaHidden: boolean;
    caption?: string;
    /** The text of the link or button it sits in, and whether the image is all of its content. */
    linkOrButtonText?: string;
    soleContentOfLinkOrButton: boolean;
  };
}

/**
 * Describes the first element each selector matches. A selector that matches nothing, or does not
 * parse, gets null, so the result lines up with the selectors.
 */
export async function describeElementContexts(
  page: ElementLocationPage,
  selectors: string[]
): Promise<Array<ElementContext | null>> {
  return (await page.evaluate((requested: string[]) => {
    const LIMIT = 300;
    const clean = (value: string | null | undefined) =>
      (value ?? "").replace(/\s+/g, " ").trim().slice(0, LIMIT);
    const visibleText = (element: Element) =>
      clean(element instanceof HTMLElement ? element.innerText : element.textContent);
    const find = (selector: string): Element | null => {
      try {
        return selector ? document.querySelector(selector) : null;
      } catch {
        return null;
      }
    };
    const ICON = "svg, img, i, [class*='icon' i], [data-icon]";
    const iconHints = (element: Element) =>
      [
        ...[element, ...element.querySelectorAll(ICON)].flatMap((node) => [
          node.querySelector(":scope > title")?.textContent,
          node.querySelector("use")?.getAttribute("href")?.split("#").pop(),
          node.getAttribute("data-icon"),
          node instanceof HTMLImageElement ? node.alt || node.src.split("/").pop() : undefined,
          ...[...node.classList].filter((name) => /icon/i.test(name))
        ]),
        element.id
      ]
        .map((hint) => clean(hint))
        .filter((hint, index, hints) => hint && hints.indexOf(hint) === index);
    // The heading of the closest container that has one before the element. An empty heading
    // there is the answer too: a heading from another section would mislabel the element.
    const HEADING = "h1, h2, h3, h4, h5, h6, [role='heading']";
    const nearbyHeading = (element: Element) => {
      for (let scope = element.parentElement; scope; scope = scope.parentElement) {
        const before = [...scope.querySelectorAll(HEADING)].filter(
          (heading) => heading.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING
        );
        if (before.length > 0) return visibleText(before[before.length - 1]!) || undefined;
      }
      return undefined;
    };
    const nearbyText = (element: Element) => {
      const own = visibleText(element);
      for (let parent = element.parentElement; parent && parent !== document.body;) {
        const text = clean(visibleText(parent).replace(own, ""));
        if (text) return text;
        parent = parent.parentElement;
      }
      return undefined;
    };
    const image = (element: Element) => {
      if (!(element instanceof HTMLImageElement) && element.getAttribute("role") !== "img") {
        return undefined;
      }
      const control =
        element.parentElement?.closest("a[href], button, [role='button'], [role='link']") ?? null;
      return {
        source: element.getAttribute("src") ?? undefined,
        alt: element.getAttribute("alt") ?? undefined,
        title: element.getAttribute("title") ?? undefined,
        role: element.getAttribute("role") ?? undefined,
        ariaHidden: element.closest("[aria-hidden='true']") !== null,
        caption:
          clean(element.closest("figure")?.querySelector("figcaption")?.textContent) || undefined,
        linkOrButtonText: control ? visibleText(control) || undefined : undefined,
        soleContentOfLinkOrButton: control !== null && !visibleText(control)
      };
    };

    return requested.map((selector) => {
      const element = find(selector);
      if (!element) return null;
      const text = visibleText(element);
      return {
        tagName: element.tagName.toLowerCase(),
        role: element.getAttribute("role") ?? undefined,
        text,
        iconOnly: !text && element.querySelector(ICON) !== null,
        iconHints: iconHints(element),
        nearbyHeading: nearbyHeading(element),
        nearbyText: nearbyText(element),
        destination: element.getAttribute("href") ?? undefined,
        image: image(element)
      };
    });
  }, selectors)) as Array<ElementContext | null>;
}
