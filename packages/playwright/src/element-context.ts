import {
  capturePageDom,
  describeSelectedElement,
  domNodeOf,
  fetchAccessibilityTree,
  mainFrameOf,
  type AccessibilityTree,
  type CapturedDom,
  type DomNodeRef,
  type PageSessions
} from "./accessibility-tree";
import type { ElementLocationPage } from "./element-locations";

/**
 * The page around an element, captured with the axe result so an AI specialist reads evidence,
 * never the live page. Text is trimmed and capped: it is only as much as a name needs. Its role,
 * name and whether a screen reader is given it at all come from the browser's accessibility
 * tree, the same one NVDA and JAWS read from Chrome.
 */
export interface ElementContext {
  tagName: string;
  /** Its role as the accessibility tree has it, such as `link`, `image` or `generic`. */
  role: string;
  /** Its accessible name from the tree; empty when it has none. */
  name: string;
  /**
   * Why the tree leaves it out, such as `emptyAlt`, `presentationalRole` or `ariaHiddenSubtree`:
   * a screen reader is given nothing of it. Empty when it is exposed.
   */
  ignoredReasons: string[];
  /** Visible text inside the element. */
  text: string;
  /** No text of its own, but an svg, img or icon element inside: the icon is all a sighted user sees. */
  iconOnly: boolean;
  /** What the markup says about the icon: an svg title, a sprite id, an img alt or file, icon classes, the id. */
  iconHints: string[];
  /** The name of the nearest heading before it, as the tree has headings. */
  nearbyHeading?: string;
  /** The visible text of its closest container that has text besides the element's own. */
  nearbyText?: string;
  /** Where a link goes. */
  destination?: string;
  image?: {
    source?: string;
    alt?: string;
    title?: string;
    caption?: string;
    /** The text of the link or button it sits in, and whether the image is all of its content. */
    linkOrButtonText?: string;
    soleContentOfLinkOrButton: boolean;
  };
}

type PageFacts = Omit<
  ElementContext,
  "role" | "name" | "ignoredReasons" | "nearbyHeading" | "image"
> & {
  image: NonNullable<ElementContext["image"]>;
};

/** The tree's role for an image, whether an img element or anything with role="img". */
const IMAGE_ROLE = "image";

/**
 * Describes the first element each selector matches. A selector that matches nothing, or does not
 * parse, gets null, so the result lines up with the selectors.
 */
export async function describeElementContexts(
  page: ElementLocationPage,
  sessions: PageSessions,
  selectors: string[]
): Promise<Array<ElementContext | null>> {
  const facts = await pageFacts(page, selectors);
  if (facts.every((fact) => fact === null)) return facts as null[];
  // The selectors are axe's, which point into the top document.
  const { frameId, session } = mainFrameOf(sessions);
  const tree = await fetchAccessibilityTree(sessions);
  const dom = await capturePageDom(sessions);
  const contexts: Array<ElementContext | null> = [];
  for (const [index, fact] of facts.entries()) {
    const element = fact && (await describeSelectedElement(session, selectors[index]!));
    if (!fact || !element) {
      contexts.push(null);
      continue;
    }
    const { image, ...rest } = fact;
    const nearbyHeading =
      element.backendNodeId === undefined
        ? undefined
        : nearbyHeadingIn(tree, dom, { frameId, backendNodeId: element.backendNodeId });
    contexts.push({
      ...rest,
      role: element.role,
      name: element.name,
      ignoredReasons: element.ignoredReasons,
      ...(nearbyHeading === undefined ? {} : { nearbyHeading }),
      ...(fact.tagName === "img" || element.role === IMAGE_ROLE ? { image } : {})
    });
  }
  return contexts;
}

/**
 * The name of the heading before the element in the closest container that has one. Headings and
 * their names are the tree's, so `role="heading"` counts and a heading made presentational does
 * not; containers and order are the DOM's, which holds every element, including an ignored image
 * the full tree leaves out. An empty heading there is the answer too: a heading from another
 * section would mislabel the element.
 */
function nearbyHeadingIn(
  { nodes }: AccessibilityTree,
  dom: CapturedDom,
  targetNode: DomNodeRef
): string | undefined {
  const target = dom.element(targetNode);
  if (!target) return undefined;
  const headings = nodes
    .filter((node) => !node.ignored && node.role?.value === "heading")
    .flatMap((node) => {
      const headingNode = domNodeOf(node);
      const element = headingNode && dom.element(headingNode);
      return headingNode && element && element.order < target.order
        ? [{ name: node.name, element, containers: dom.ancestorElements(headingNode) }]
        : [];
    })
    .sort((first, second) => first.element.order - second.element.order);
  for (const container of dom.ancestorElements(targetNode).slice(1)) {
    const before = headings.filter(({ containers }) => containers.includes(container));
    const last = before[before.length - 1];
    if (last)
      return typeof last.name?.value === "string" ? last.name.value.trim() || undefined : undefined;
  }
  return undefined;
}

/** What the page itself shows about each element: its text, icons, link target and image. */
async function pageFacts(
  page: ElementLocationPage,
  selectors: string[]
): Promise<Array<PageFacts | null>> {
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
      const control =
        element.parentElement?.closest("a[href], button, [role='button'], [role='link']") ?? null;
      return {
        source: element.getAttribute("src") ?? undefined,
        alt: element.getAttribute("alt") ?? undefined,
        title: element.getAttribute("title") ?? undefined,
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
        text,
        iconOnly: !text && element.querySelector(ICON) !== null,
        iconHints: iconHints(element),
        nearbyText: nearbyText(element),
        destination: element.getAttribute("href") ?? undefined,
        image: image(element)
      };
    });
  }, selectors)) as Array<PageFacts | null>;
}
