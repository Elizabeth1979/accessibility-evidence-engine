import {
  capturePageDom,
  domNodeOf,
  fetchAccessibilityNode,
  fetchAccessibilityTree,
  type AccessibilityNode,
  type PageSessions
} from "./accessibility-tree";

/**
 * How an image is exposed: with a text alternative, left out of the accessibility tree (screen
 * readers skip it), or announced with no text alternative.
 */
export type ElementMapAlt = "text" | "ignored" | "missing";

export interface ElementMapEntry {
  kind: "heading" | "image";
  /** The role in the accessibility tree. */
  role: string;
  /** The accessible name a screen reader announces. */
  name: string;
  /** Headings only: the level a screen reader announces. */
  level?: number;
  /** Images only. */
  alt?: ElementMapAlt;
  /**
   * Images the tree leaves out: Chrome's own reasons, such as `emptyAlt`, `presentationalRole`
   * or `ariaHiddenElement`, exactly as it reports them.
   */
  ignoredReasons?: string[];
  /** Where it is in the document that holds it. */
  selector: string;
  /**
   * Inside a frame: the `<iframe>` elements it is inside, outermost first, each as a path in the
   * document that holds it.
   */
  framePath?: string[];
  /** Where it is on the page, in the full-page screenshot's coordinates. */
  box: { x: number; y: number; width: number; height: number };
}

/**
 * The headings and images on the page at one checkpoint, in reading order, with the roles, names
 * and levels the accessibility tree gives them and where each is on the page.
 */
export interface ElementMap {
  schemaVersion: "0.1.0";
  captureType: "element-map";
  elements: ElementMapEntry[];
}

/**
 * Reads every frame's accessibility tree and DOM snapshot, joined by node, so each heading and
 * image carries the browser's own role, name and level together with its box on the page. The
 * full tree leaves out some ignored images (an `alt=""` image in a paragraph), so each of those is
 * asked about on its own. Everything is listed in the page's document order, a frame's content
 * where its `<iframe>` is.
 */
export async function captureElementMap(page: PageSessions): Promise<ElementMap> {
  const [tree, dom] = await Promise.all([fetchAccessibilityTree(page), capturePageDom(page)]);
  const inTree = new Set(tree.nodes.map((node) => `${node.frameId}\u0000${node.backendDOMNodeId}`));
  const leftOut = await Promise.all(
    dom
      .elements("img")
      .filter(({ frameId, backendNodeId }) => !inTree.has(`${frameId}\u0000${backendNodeId}`))
      .map((image) => fetchAccessibilityNode(page, image))
  );
  const order = (node: AccessibilityNode) => {
    const ref = domNodeOf(node);
    return ref ? (dom.element(ref)?.order ?? -1) : -1;
  };
  const nodes = [...tree.nodes, ...leftOut.filter((node) => node !== undefined)]
    .map((node) => ({ node, at: order(node) }))
    .filter(({ at }) => at !== -1)
    .sort((left, right) => left.at - right.at)
    .map(({ node }) => node);
  return { schemaVersion: "0.1.0", captureType: "element-map", elements: nodes.flatMap(toEntries) };

  function toEntries(node: AccessibilityNode): ElementMapEntry[] {
    const ref = domNodeOf(node);
    const element = ref && dom.element(ref);
    // Only what the page lays out; an empty heading still has a place on the page.
    if (!element?.layoutBounds) return [];
    const role = String(node.role?.value ?? "");
    const name = typeof node.name?.value === "string" ? node.name.value.trim() : "";
    const common = {
      role,
      name,
      selector: element.nodePath,
      ...(element.framePath.length ? { framePath: element.framePath } : {}),
      box: element.layoutBounds
    };
    if (!node.ignored && role === "heading") {
      return [{ kind: "heading", ...common, level: headingLevel(node) }];
    }
    if (isHiddenFromEveryone(node)) return [];
    if (element.tagName === "img" || (!node.ignored && role === "image")) {
      if (node.ignored) {
        const ignoredReasons = (node.ignoredReasons ?? []).map(({ name }) => name);
        return [{ kind: "image", ...common, alt: "ignored", ignoredReasons }];
      }
      return [{ kind: "image", ...common, alt: name ? "text" : "missing" }];
    }
    return [];
  }
}

/** Left out because nobody can see it, not hidden from screen readers alone. */
function isHiddenFromEveryone(node: AccessibilityNode): boolean {
  return (
    node.ignored &&
    (node.ignoredReasons ?? []).some(({ name }) => name === "notRendered" || name === "notVisible")
  );
}

function headingLevel(node: AccessibilityNode): number {
  const level = node.properties?.find(({ name }) => name === "level")?.value.value;
  // A heading with no level is announced as level 2 (WAI-ARIA 1.2, heading role).
  return typeof level === "number" ? level : 2;
}
