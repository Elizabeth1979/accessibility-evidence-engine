import {
  accessibleElementOf,
  type AccessibilityNode,
  type AccessibilityTree,
  type CdpSession
} from "./accessibility-tree";

/** The composite widgets whose items the arrow keys move between, with the roles of their items. */
const COMPOSITE_ITEM_ROLES: Record<string, string[]> = {
  tablist: ["tab"],
  radiogroup: ["radio"],
  listbox: ["option"],
  menu: ["menuitem", "menuitemcheckbox", "menuitemradio"],
  menubar: ["menuitem", "menuitemcheckbox", "menuitemradio"],
  tree: ["treeitem"],
  grid: ["gridcell", "rowheader", "columnheader"]
};

const DIALOG_ROLES = ["dialog", "alertdialog"];

/** Released after each description, with every remote object it created. */
const OBJECT_GROUP = "aee-focus-accessibility";

/** The dialog an element sits in, as the accessibility tree has it. */
export interface DialogContext {
  tagName: string;
  id?: string;
  role: string;
  /** Its accessible name, which ARIA takes from the author only: empty when it has none. */
  name: string;
  /** Whether the tree treats it as modal, from `aria-modal` or from `showModal()`. */
  modal: boolean;
}

/**
 * A focused element as the accessibility tree has it: its role, name and states, and the dialog
 * and composite widget it sits in, found by walking up the tree.
 */
export interface FocusAccessibility {
  role: string;
  name: string;
  selected?: boolean;
  checked?: boolean | "mixed";
  dialogContext?: DialogContext;
  compositeRole?: string;
  compositeOrientation?: string;
  /** Its place among the widget's items, counted from 0, in the order the tree has them. */
  compositeItemIndex?: number;
  compositeItemCount?: number;
}

/** A focused element's description, with the tree node it came from. */
export interface DescribedFocusElement {
  nodeId: string;
  backendDOMNodeId?: number;
  accessibility: FocusAccessibility;
}

/**
 * Describes each element of the array that `expression` evaluates to, in order. An entry that is
 * not an element, or that the tree does not have, is undefined.
 */
export async function describeFocusElements(
  session: CdpSession,
  expression: string
): Promise<Array<DescribedFocusElement | undefined>> {
  const { result } = (await session.send("Runtime.evaluate", {
    expression,
    objectGroup: OBJECT_GROUP
  })) as { result: { objectId?: string } };
  try {
    if (!result.objectId) return [];
    const { result: entries } = (await session.send("Runtime.getProperties", {
      objectId: result.objectId,
      ownProperties: true
    })) as { result: Array<{ name: string; value?: { objectId?: string; subtype?: string } }> };
    const elements = entries
      .filter(({ name }) => /^\d+$/.test(name))
      .sort((first, second) => Number(first.name) - Number(second.name))
      .map(({ value }) => (value?.subtype === "node" ? value.objectId : undefined));
    const described: Array<DescribedFocusElement | undefined> = [];
    for (const objectId of elements) {
      described.push(objectId ? await describeFocusElement(session, objectId) : undefined);
    }
    return described;
  } finally {
    await session.send("Runtime.releaseObjectGroup", { objectGroup: OBJECT_GROUP });
  }
}

async function describeFocusElement(
  session: CdpSession,
  objectId: string
): Promise<DescribedFocusElement | undefined> {
  const { node: domNode } = (await session.send("DOM.describeNode", { objectId })) as {
    node: { backendNodeId: number };
  };
  const { nodes } = (await session.send("Accessibility.getPartialAXTree", {
    objectId,
    fetchRelatives: true
  })) as AccessibilityTree;
  const own = nodes.find(({ backendDOMNodeId }) => backendDOMNodeId === domNode.backendNodeId);
  if (!own) return undefined;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const ancestors: AccessibilityNode[] = [];
  for (
    let parent = byId.get(own.parentId ?? "");
    parent;
    parent = byId.get(parent.parentId ?? "")
  ) {
    ancestors.push(parent);
  }
  const exposedWith = (roles: string[]) => (node: AccessibilityNode) =>
    !node.ignored && roles.includes(String(node.role?.value));
  const element = accessibleElementOf(own);
  const dialog = [own, ...ancestors].find(exposedWith(DIALOG_ROLES));
  const composite = ancestors.find(exposedWith(Object.keys(COMPOSITE_ITEM_ROLES)));

  return {
    nodeId: own.nodeId,
    ...(own.backendDOMNodeId === undefined ? {} : { backendDOMNodeId: own.backendDOMNodeId }),
    accessibility: {
      role: element.role,
      name: element.name,
      ...states(element.properties),
      ...(dialog ? { dialogContext: await describeDialog(session, dialog) } : {}),
      ...(composite ? await describeComposite(session, composite, own) : {})
    }
  };
}

/** Selected and checked as the tree has them, which covers native check boxes and radio buttons. */
function states(
  properties: Record<string, unknown>
): Pick<FocusAccessibility, "selected" | "checked"> {
  const { selected, checked } = properties;
  return {
    ...(typeof selected === "boolean" ? { selected } : {}),
    ...(checked === "mixed"
      ? { checked }
      : checked === undefined
        ? {}
        : { checked: checked === "true" })
  };
}

async function describeDialog(
  session: CdpSession,
  dialog: AccessibilityNode
): Promise<DialogContext> {
  const { role, name, properties } = accessibleElementOf(dialog);
  const { node } = (await session.send("DOM.describeNode", {
    backendNodeId: dialog.backendDOMNodeId
  })) as { node: { localName: string; attributes?: string[] } };
  const attributes = node.attributes ?? [];
  const id = attributes[attributes.indexOf("id") + 1];
  return {
    tagName: node.localName,
    ...(attributes.includes("id") && id ? { id } : {}),
    role,
    name,
    modal: properties.modal === true
  };
}

async function describeComposite(
  session: CdpSession,
  composite: AccessibilityNode,
  own: AccessibilityNode
): Promise<Partial<FocusAccessibility>> {
  const compositeRole = String(composite.role?.value);
  const itemRoles = COMPOSITE_ITEM_ROLES[compositeRole] ?? [];
  // With no role or name asked for, the query returns the widget's whole subtree in page order.
  const { nodes } = (await session.send("Accessibility.queryAXTree", {
    backendNodeId: composite.backendDOMNodeId
  })) as AccessibilityTree;
  const items = nodes.filter(
    (node) => !node.ignored && itemRoles.includes(String(node.role?.value))
  );
  const index = items.findIndex(
    ({ backendDOMNodeId }) => backendDOMNodeId === own.backendDOMNodeId
  );
  const { orientation } = accessibleElementOf(composite).properties;
  return {
    compositeRole,
    ...(typeof orientation === "string" ? { compositeOrientation: orientation } : {}),
    ...(index >= 0 ? { compositeItemIndex: index } : {}),
    ...(items.length > 0 ? { compositeItemCount: items.length } : {})
  };
}
