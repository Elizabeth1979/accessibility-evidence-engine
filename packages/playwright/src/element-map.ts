import {
  capturePageDom,
  fetchAccessibilityTree,
  type AccessibilityNode,
  type CapturedElement,
  type CdpSession
} from "./accessibility-tree";

/** How an image is exposed: with a text alternative, marked decorative, or with neither. */
export type ElementMapAlt = "text" | "decorative" | "missing";

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
 * carries the browser's own role, name and level together with its box.
 */
export async function captureElementMap(session: CdpSession): Promise<ElementMap> {
  const [tree, dom] = await Promise.all([fetchAccessibilityTree(session), capturePageDom(session)]);
  const elements = tree.nodes.flatMap((node): ElementMapEntry[] => {
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
      return [{ kind: "image", ...common, alt: imageAlt(node, element, name) }];
    }
    return [];
  });
  return { schemaVersion: "0.1.0", captureType: "element-map", elements };
}

/** Left out because nobody can see it, not because it was marked decorative. */
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

/**
 * An image the accessibility tree ignores, or one marked with an empty alt, is decorative: screen
 * readers skip it. One with a name has a text alternative. Anything else has none.
 */
function imageAlt(node: AccessibilityNode, element: CapturedElement, name: string): ElementMapAlt {
  if (name) return "text";
  if (node.ignored || element.attribute("alt") === "") return "decorative";
  return "missing";
}
