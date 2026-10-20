import type { FocusedElement } from "@aee/schemas";

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

/** The dialog an element sits in, as the accessibility tree has it. */
export type DialogContext = NonNullable<FocusedElement["dialogContext"]>;

const DIALOG_ROLES: ReadonlyArray<DialogContext["role"]> = ["dialog", "alertdialog"];

/**
 * A focused element as the accessibility tree has it: its role, name and states, and the dialog
 * and composite widget it sits in, found by walking up the tree.
 */
export type FocusAccessibility = Required<Pick<FocusedElement, "role" | "name">> &
  Pick<
    FocusedElement,
    | "selected"
    | "checked"
    | "dialogContext"
    | "compositeRole"
    | "compositeOrientation"
    | "compositeItemIndex"
    | "compositeItemCount"
  >;

/**
 * Describes one element, given as a protocol object in its frame's session, as the accessibility
 * tree has it. Undefined when the tree does not have it.
 */
export async function describeFocusElement(
  session: CdpSession,
  objectId: string
): Promise<FocusAccessibility | undefined> {
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
  const element = accessibleElementOf(own);
  const dialog = firstExposed([own, ...ancestors], DIALOG_ROLES);
  const composite = firstExposed(ancestors, Object.keys(COMPOSITE_ITEM_ROLES));

  return {
    role: element.role,
    name: element.name,
    ...states(element.properties),
    ...(dialog ? { dialogContext: await describeDialog(session, dialog.node, dialog.role) } : {}),
    ...(composite ? await describeComposite(session, composite.node, own) : {})
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

/** The first of the nodes the tree exposes with one of the roles, and that role. */
function firstExposed<Role extends string>(
  nodes: AccessibilityNode[],
  roles: readonly Role[]
): { node: AccessibilityNode; role: Role } | undefined {
  for (const node of nodes) {
    const role = node.ignored ? undefined : roles.find((name) => name === String(node.role?.value));
    if (role) return { node, role };
  }
  return undefined;
}

async function describeDialog(
  session: CdpSession,
  dialog: AccessibilityNode,
  role: DialogContext["role"]
): Promise<DialogContext> {
  const { name, properties } = accessibleElementOf(dialog);
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
    ...(orientation === "horizontal" || orientation === "vertical"
      ? { compositeOrientation: orientation }
      : {}),
    ...(index >= 0 ? { compositeItemIndex: index } : {}),
    ...(items.length > 0 ? { compositeItemCount: items.length } : {})
  };
}
