import {
  TRACKED_ACCESSIBILITY_STATES,
  type AccessibilityChange,
  type AccessibilityChanges,
  type AccessibilityNodeRef,
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
  let truncated = false;
  const add = (node: AxNode, change: Omit<AccessibilityChange, keyof AccessibilityNodeRef>) => {
    if (changes.length >= MAXIMUM_CHANGES) {
      truncated = true;
      return;
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
    truncated
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
