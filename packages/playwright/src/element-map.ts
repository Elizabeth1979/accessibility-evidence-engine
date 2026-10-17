import {
  capturePageDom,
  fetchAccessibilityNode,
  fetchAccessibilityTree,
  type AccessibilityNode,
  type CdpSession
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
  selector: string;
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
 * Reads the accessibility tree and one DOM snapshot, joined by node, so each heading and image
 * carries the browser's own role, name and level together with its box. The full tree leaves out
 * some ignored images (an `alt=""` image in a paragraph), so each of those is asked about on its
 * own and placed in document order among the rest.
 */
export async function captureElementMap(session: CdpSession): Promise<ElementMap> {
  const [tree, dom] = await Promise.all([fetchAccessibilityTree(session), capturePageDom(session)]);
  const inTree = new Set(tree.nodes.map(({ backendDOMNodeId }) => backendDOMNodeId));
  const leftOut = await Promise.all(
    dom
      .elementIds("img")
      .filter((id) => !inTree.has(id))
      .map((id) => fetchAccessibilityNode(session, id))
  );
  const order = (node: AccessibilityNode) =>
    node.backendDOMNodeId === undefined ? -1 : (dom.element(node.backendDOMNodeId)?.order ?? -1);
  const nodes = [...tree.nodes];
  for (const image of leftOut) {
    if (!image) continue;
    const at = nodes.findIndex((node) => order(node) > order(image));
    nodes.splice(at === -1 ? nodes.length : at, 0, image);
  }
  return { schemaVersion: "0.1.0", captureType: "element-map", elements: nodes.flatMap(toEntries) };

  function toEntries(node: AccessibilityNode): ElementMapEntry[] {
    const element =
      node.backendDOMNodeId === undefined ? undefined : dom.element(node.backendDOMNodeId);
    // Only what the page lays out; an empty heading still has a place on the page.
    if (!element?.layoutBounds) return [];
    const role = String(node.role?.value ?? "");
    const name = typeof node.name?.value === "string" ? node.name.value.trim() : "";
    const common = { role, name, selector: element.nodePath, box: element.layoutBounds };
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
