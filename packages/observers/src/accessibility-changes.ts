import {
  TRACKED_ACCESSIBILITY_STATES,
  type AccessibilityChange,
  type AccessibilityChanges,
  type AccessibilityNodeRef,
  type LiveRegionRef,
  type TrackedAccessibilityState
} from "@aee/core";

/**
 * What changed in the browser's accessibility tree between two snapshots, for the states a
 * control reports to assistive technology. The values are Chrome's own: the tree is CDP's
 * `Accessibility.getFullAXTree`, computed from the W3C mappings (HTML-AAM, Core-AAM, accname) the
 * browser implements. This only compares them; it decides nothing about what they mean.
 */

/** Enough to name every change one press makes; a page that changes more is listed in part. */
const MAXIMUM_CHANGES = 200;

/** Chromium's per-line layout boxes; their text is already on the StaticText node above them. */
const LAYOUT_ONLY_ROLES = new Set(["InlineTextBox"]);

interface AxValue {
  type?: string;
  value?: unknown;
  relatedNodes?: Array<{ backendDOMNodeId?: number }>;
}

interface AxNode {
  nodeId?: string;
  parentId?: string;
  childIds?: string[];
  frameId?: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: Array<{ name: string; value: AxValue }>;
  backendDOMNodeId?: number;
}

/**
 * The tracked state changes, nodes shown or hidden, and name changes between two CDP
 * accessibility trees, or undefined when either snapshot is not a CDP tree (`{ nodes: [...] }`).
 */
export function diffAccessibilityTrees(
  before: unknown,
  after: unknown
): AccessibilityChanges | undefined {
  const beforeNodes = readTree(before);
  const afterNodes = readTree(after);
  if (!beforeNodes || !afterNodes) return undefined;
  const beforeStructure = readStructure(before);
  const afterStructure = readStructure(after);

  const controllers = new Map<number, Map<number, AccessibilityNodeRef>>();
  for (const nodes of [beforeNodes, afterNodes]) {
    for (const node of nodes.values()) {
      const controller = refOf(node);
      for (const related of property(node, "controls")?.relatedNodes ?? []) {
        if (related.backendDOMNodeId === undefined) continue;
        const known = controllers.get(related.backendDOMNodeId) ?? new Map();
        known.set(controller.nodeId, controller);
        controllers.set(related.backendDOMNodeId, known);
      }
    }
  }

  const changes: AccessibilityChange[] = [];
  const liveRegions = new Map<number, LiveRegionRef>();
  let truncated = false;
  const add = (node: AxNode, change: Omit<AccessibilityChange, keyof AccessibilityNodeRef>) => {
    if (changes.length >= MAXIMUM_CHANGES) {
      truncated = true;
      return;
    }
    const structure = change.kind === "hidden" ? beforeStructure : afterStructure;
    const region = liveRegionOf(node, structure);
    if (region?.backendDOMNodeId !== undefined && !liveRegions.has(region.backendDOMNodeId)) {
      const later = afterStructure.byBackendId.get(region.backendDOMNodeId);
      liveRegions.set(
        region.backendDOMNodeId,
        later ? liveRegionRef(later, afterStructure) : liveRegionRef(region, beforeStructure)
      );
    }
    const ref = refOf(node);
    const controlledBy = [...(controllers.get(ref.nodeId)?.values() ?? [])];
    changes.push({ ...ref, ...change, ...(controlledBy.length > 0 ? { controlledBy } : {}) });
  };

  for (const [nodeId, afterNode] of afterNodes) {
    const beforeNode = beforeNodes.get(nodeId);
    if (!beforeNode) {
      add(afterNode, { kind: "shown" });
      continue;
    }
    if (textOf(beforeNode.name) !== textOf(afterNode.name)) {
      add(afterNode, {
        kind: "name",
        before: textOf(beforeNode.name) ?? null,
        after: textOf(afterNode.name) ?? null
      });
    }
    for (const state of TRACKED_ACCESSIBILITY_STATES) {
      const was = stateOf(beforeNode, state);
      const is = stateOf(afterNode, state);
      if (was !== is) add(afterNode, { kind: "state", state, before: was, after: is });
    }
  }
  for (const [nodeId, beforeNode] of beforeNodes) {
    if (!afterNodes.has(nodeId)) add(beforeNode, { kind: "hidden" });
  }

  const focusedBefore = focusedNode(beforeNodes);
  const focusedAfter = focusedNode(afterNodes);
  return {
    ...(focusedBefore ? { focusedBefore } : {}),
    ...(focusedAfter ? { focusedAfter } : {}),
    changes,
    truncated,
    ...(liveRegions.size > 0 ? { liveRegions: [...liveRegions.values()] } : {})
  };
}

/** Every node of a snapshot, ignored ones too, so a node's ancestors and a region's text are whole. */
interface TreeStructure {
  byKey: Map<string, AxNode>;
  byBackendId: Map<number, AxNode>;
}

function readStructure(snapshot: unknown): TreeStructure {
  const { nodes } = snapshot as { nodes: AxNode[] };
  const structure: TreeStructure = { byKey: new Map(), byBackendId: new Map() };
  for (const node of nodes) {
    if (node.nodeId !== undefined) structure.byKey.set(keyOf(node.frameId, node.nodeId), node);
    if (node.backendDOMNodeId !== undefined) structure.byBackendId.set(node.backendDOMNodeId, node);
  }
  return structure;
}

/** A node's id in its frame's tree; each frame's tree numbers its nodes from one. */
function keyOf(frameId: string | undefined, nodeId: string): string {
  return `${frameId ?? ""} ${nodeId}`;
}

/**
 * The live region a node is in: the node or its nearest ancestor that Chrome gives a `live`
 * property of polite or assertive. Chrome sets `live` on the region's root only, so the region is
 * found through the node's ancestors. A region marked `off` (a `timer`, say) is not announced.
 */
function liveRegionOf(node: AxNode, structure: TreeStructure): AxNode | undefined {
  let current: AxNode | undefined =
    node.nodeId !== undefined ? structure.byKey.get(keyOf(node.frameId, node.nodeId)) : undefined;
  while (current) {
    const live = property(current, "live")?.value;
    if (live === "polite" || live === "assertive") return current;
    if (live === "off") return undefined;
    current =
      current.parentId !== undefined
        ? structure.byKey.get(keyOf(current.frameId, current.parentId))
        : undefined;
  }
  return undefined;
}

function liveRegionRef(root: AxNode, structure: TreeStructure): LiveRegionRef {
  const words: string[] = [];
  const collect = (node: AxNode) => {
    if (!node.ignored && String(node.role?.value) === "StaticText") {
      const text = textOf(node.name);
      if (text) words.push(text);
    }
    for (const childId of node.childIds ?? []) {
      const child = structure.byKey.get(keyOf(node.frameId, childId));
      if (child) collect(child);
    }
  };
  collect(root);
  return {
    ...refOf(root),
    politeness: property(root, "live")?.value as LiveRegionRef["politeness"],
    text: words.join(" ")
  };
}

/** The tree's nodes a person can perceive, by DOM node id. Ignored nodes are left out, as AT does. */
function readTree(snapshot: unknown): Map<number, AxNode> | undefined {
  if (typeof snapshot !== "object" || snapshot === null) return undefined;
  const { nodes } = snapshot as { nodes?: unknown };
  if (!Array.isArray(nodes)) return undefined;
  const perceivable = new Map<number, AxNode>();
  for (const node of nodes as AxNode[]) {
    if (node.ignored || node.backendDOMNodeId === undefined) continue;
    if (LAYOUT_ONLY_ROLES.has(String(node.role?.value ?? ""))) continue;
    perceivable.set(node.backendDOMNodeId, node);
  }
  return perceivable;
}

function refOf(node: AxNode): AccessibilityNodeRef {
  const name = textOf(node.name);
  return {
    nodeId: node.backendDOMNodeId!,
    role: String(node.role?.value ?? ""),
    ...(name ? { name } : {})
  };
}

function property(node: AxNode, name: string): AxValue | undefined {
  return node.properties?.find((candidate) => candidate.name === name)?.value;
}

/** A tracked state as Chrome reports it; null when the node does not have it. */
function stateOf(node: AxNode, state: TrackedAccessibilityState): string | number | boolean | null {
  const value = state === "value" ? node.value?.value : property(node, state)?.value;
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

function textOf(value: AxValue | undefined): string | undefined {
  const text = typeof value?.value === "string" ? value.value.trim() : "";
  return text || undefined;
}

/**
 * The focused element. Chrome marks the document (RootWebArea) focused too whenever the page has
 * focus, so the element is the deepest focused node, the last in tree order.
 */
function focusedNode(nodes: Map<number, AxNode>): AccessibilityNodeRef | undefined {
  let focused: AxNode | undefined;
  for (const node of nodes.values()) {
    if (property(node, "focused")?.value === true) focused = node;
  }
  return focused && refOf(focused);
}
