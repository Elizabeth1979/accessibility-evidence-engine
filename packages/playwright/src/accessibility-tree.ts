/** A Chrome DevTools Protocol session, as Playwright's `CDPSession` provides it. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach?(): Promise<void>;
}

export interface CdpContext {
  newCDPSession(page: unknown): Promise<CdpSession>;
}

export interface AccessibilityValue {
  type: string;
  value?: unknown;
}

/** One node of the browser's accessibility tree (CDP `Accessibility.AXNode`). */
export interface AccessibilityNode {
  nodeId: string;
  ignored: boolean;
  /** Why an ignored node is left out, such as `notRendered` or `emptyAlt`. */
  ignoredReasons?: Array<{ name: string }>;
  /** `type` is `role` for an ARIA role and `internalRole` for Chromium's own names. */
  role?: AccessibilityValue;
  name?: AccessibilityValue;
  properties?: Array<{ name: string; value: AccessibilityValue }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface AccessibilityTree {
  nodes: AccessibilityNode[];
}

/** Opens a session on the page, runs `use` with it, and always detaches it. */
export async function withCdpSession<Result>(
  context: CdpContext,
  page: unknown,
  use: (session: CdpSession) => Promise<Result>
): Promise<Result> {
  const session = await context.newCDPSession(page);
  try {
    return await use(session);
  } finally {
    await session.detach?.();
  }
}

/**
 * The page's full accessibility tree as the browser computes it: roles, names and states follow
 * the W3C mappings (HTML-AAM, accname) the browser implements. Every part of the engine that needs
 * them reads this tree rather than inferring them from the DOM.
 */
export async function fetchAccessibilityTree(session: CdpSession): Promise<AccessibilityTree> {
  return (await session.send("Accessibility.getFullAXTree")) as AccessibilityTree;
}

/**
 * The focused element's role and name as the accessibility tree has them, which is what a screen
 * reader announces when focus arrives. Nothing when focus is on no element.
 */
export async function describeFocusedElement(
  session: CdpSession
): Promise<{ role: string; name: string } | undefined> {
  const { result } = (await session.send("Runtime.evaluate", {
    expression: "document.activeElement"
  })) as { result: { objectId?: string } };
  if (!result.objectId) return undefined;
  try {
    const { nodes } = (await session.send("Accessibility.getPartialAXTree", {
      objectId: result.objectId,
      fetchRelatives: false
    })) as AccessibilityTree;
    const node = nodes[0];
    if (!node) return undefined;
    return {
      role: String(node.role?.value ?? ""),
      name: typeof node.name?.value === "string" ? node.name.value : ""
    };
  } finally {
    await session.send("Runtime.releaseObject", { objectId: result.objectId });
  }
}

/** An element as one CDP DOM snapshot records it. */
export interface CapturedElement {
  tagName: string;
  /** Its id, or up to eight tag steps with their position among same-tag siblings. */
  nodePath: string;
  attribute(name: string): string | undefined;
  /** The computed styles the snapshot was asked for, by property name. */
  style: Record<string, string>;
  /** Its box, when it has an area: what a sighted user can see. */
  visualBounds?: { x: number; y: number; width: number; height: number };
  /** Its box whenever the page lays it out, even with no area, as an empty heading has. */
  layoutBounds?: { x: number; y: number; width: number; height: number };
}

export interface CapturedDom {
  element(backendNodeId: number): CapturedElement | undefined;
  /** The node itself when it is an element, else its parent element (for a text node). */
  closestElement(backendNodeId: number): CapturedElement | undefined;
  /** The closest element and each element above it, nearest first. */
  ancestorElements(backendNodeId: number): CapturedElement[];
}

interface DomSnapshot {
  strings: string[];
  documents: Array<{
    nodes: {
      parentIndex: number[];
      nodeType: number[];
      nodeName: number[];
      backendNodeId: number[];
      attributes: number[][];
    };
    layout: { nodeIndex: number[]; bounds: number[][]; styles?: number[][] };
  }>;
}

/**
 * One CDP snapshot of the DOM: every element's tag, attributes, place in the tree, layout box and
 * the computed styles asked for. Joined to the accessibility tree by backend node id.
 */
export async function capturePageDom(
  session: CdpSession,
  computedStyles: string[] = []
): Promise<CapturedDom> {
  const { strings, documents } = (await session.send("DOMSnapshot.captureSnapshot", {
    computedStyles
  })) as DomSnapshot;
  const { nodes, layout } = documents[0]!;
  const indexByBackendId = new Map(nodes.backendNodeId.map((id, index) => [id, index]));
  const layoutIndex = new Map(layout.nodeIndex.map((node, index) => [node, index]));
  const tagName = (index: number) => strings[nodes.nodeName[index]!]!.toLowerCase();
  const isElement = (index: number) =>
    nodes.nodeType[index] === 1 && !tagName(index).startsWith("::");
  const attribute = (index: number, name: string) => {
    const pairs = nodes.attributes[index] ?? [];
    for (let at = 0; at < pairs.length; at += 2) {
      if (strings[pairs[at]!] === name) return strings[pairs[at + 1]!];
    }
    return undefined;
  };
  const elementChildren = new Map<number, number[]>();
  nodes.parentIndex.forEach((parent, index) => {
    if (!isElement(index)) return;
    const siblings = elementChildren.get(parent) ?? [];
    siblings.push(index);
    elementChildren.set(parent, siblings);
  });
  const nodePath = (index: number) => {
    const id = attribute(index, "id");
    if (id)
      return /^[A-Za-z_][\w-]*$/.test(id) ? `#${id}` : `[id="${id.replace(/["\\]/g, "\\$&")}"]`;
    const segments: string[] = [];
    for (
      let current = index;
      current >= 0 && isElement(current) && segments.length < 8;
      current = nodes.parentIndex[current]!
    ) {
      const tag = tagName(current);
      const sameTag = (elementChildren.get(nodes.parentIndex[current]!) ?? []).filter(
        (sibling) => tagName(sibling) === tag
      );
      segments.unshift(
        sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(current) + 1})` : tag
      );
    }
    return segments.join(" > ");
  };
  const captured = new Map<number, CapturedElement>();
  const capture = (index: number): CapturedElement => {
    const known = captured.get(index);
    if (known) return known;
    const box = layoutIndex.get(index);
    const [x = 0, y = 0, width = 0, height = 0] = box === undefined ? [] : layout.bounds[box]!;
    const styles = box === undefined ? [] : (layout.styles?.[box] ?? []);
    const element: CapturedElement = {
      tagName: tagName(index),
      nodePath: nodePath(index),
      attribute: (name) => attribute(index, name),
      style: Object.fromEntries(
        computedStyles.map((name, at) => [name, strings[styles[at] ?? -1] ?? ""])
      ),
      ...(box === undefined ? {} : { layoutBounds: { x, y, width, height } }),
      ...(width > 0 && height > 0 ? { visualBounds: { x, y, width, height } } : {})
    };
    captured.set(index, element);
    return element;
  };
  const ancestorElements = (backendNodeId: number) => {
    const found: CapturedElement[] = [];
    for (
      let index = indexByBackendId.get(backendNodeId);
      index !== undefined && index >= 0;
      index = nodes.parentIndex[index]
    ) {
      if (isElement(index)) found.push(capture(index));
    }
    return found;
  };

  return {
    element(backendNodeId) {
      const index = indexByBackendId.get(backendNodeId);
      return index === undefined || !isElement(index) ? undefined : capture(index);
    },
    closestElement: (backendNodeId) => ancestorElements(backendNodeId)[0],
    ancestorElements
  };
}
