import {
  fetchAccessibilityTree,
  withCdpSession,
  type AccessibilityNode,
  type AccessibilityValue,
  type CdpContext,
  type CdpSession
} from "./accessibility-tree";

export type VirtualScreenReaderCommand =
  | "start"
  | "next-item"
  | "previous-item"
  | "next-heading"
  | "previous-heading"
  | "next-landmark"
  | "next-control"
  | "read-current";

export interface VirtualScreenReaderItem {
  key: string;
  nodePath: string;
  tagName: string;
  /** The role in the browser's accessibility tree. */
  role: string;
  /** The accessible name the browser computed. */
  name?: string;
  /** What is read for an item whose content, not a name, is spoken: a paragraph or a list item. */
  text?: string;
  level?: number;
  states: string[];
  /** Page coordinates; absent when the element has no rendered box. */
  visualBounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export interface VirtualScreenReaderEntry {
  sequence: number;
  timestamp: string;
  command: VirtualScreenReaderCommand;
  announcement: string;
  item?: VirtualScreenReaderItem;
  domFocusBefore?: string;
  domFocusAfter?: string;
  focusMoved: boolean;
}

export interface VirtualScreenReaderTranscript {
  schemaVersion: "0.1.0";
  engine: "aee-portable-virtual-screen-reader";
  engineVersion: "0.1.0";
  mode: "guide";
  fidelity: "semantic-simulation";
  physicalAssistiveTechnology: false;
  pageUrl: string;
  generatedAt: string;
  currentItem?: VirtualScreenReaderItem;
  entries: VirtualScreenReaderEntry[];
}

export function renderPortableVirtualScreenReaderTranscript(
  transcript: VirtualScreenReaderTranscript
): string {
  const lines = [
    "AEE portable virtual screen-reader transcript",
    "Fidelity: semantic simulation; not VoiceOver, NVDA, or another physical assistive technology.",
    `Page: ${transcript.pageUrl}`,
    `Mode: ${transcript.mode}`,
    ""
  ];

  if (transcript.entries.length === 0) {
    lines.push("No commands recorded.");
  } else {
    for (const entry of transcript.entries) {
      lines.push(`${entry.sequence}. ${entry.command}: ${entry.announcement}`);
      lines.push(
        `   DOM focus: ${entry.domFocusBefore ?? "none"} -> ${entry.domFocusAfter ?? "none"}; moved: ${entry.focusMoved ? "yes" : "no"}`
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

export interface PortableVirtualScreenReader {
  command(command: VirtualScreenReaderCommand): Promise<VirtualScreenReaderEntry>;
  snapshot(): Promise<VirtualScreenReaderTranscript>;
}

export interface VirtualScreenReaderPage {
  url(): string;
  context(): CdpContext;
}

interface PageSemanticState {
  items: VirtualScreenReaderItem[];
  focusKey?: string;
}

const LANDMARK_ROLES = new Set([
  "banner",
  "complementary",
  "contentinfo",
  "form",
  "main",
  "navigation",
  "region",
  "search"
]);

const CONTROL_ROLES = new Set([
  "DisclosureTriangle",
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox"
]);

/** Roles that need an accessible name (ARIA: "accessible name required"). */
const NAME_REQUIRED_ROLES = new Set([
  ...CONTROL_ROLES,
  "alertdialog",
  "dialog",
  "heading",
  "image"
]);

/** Whether the reader announced an item whose role needs a name without one. */
export function announcedWithoutName(
  item: Pick<VirtualScreenReaderItem, "role" | "name">
): boolean {
  return NAME_REQUIRED_ROLES.has(item.role) && !item.name;
}

/**
 * ARIA roles a screen reader passes over when it reads item by item: containers with no meaning of
 * their own, the header and footer of a section (ARIA 1.3 roles, not landmarks), words inside a
 * sentence, and the inside of a table, which is read as one table.
 */
const SILENT_ROLES = new Set([
  "generic",
  "none",
  "presentation",
  "sectionheader",
  "sectionfooter",
  "strong",
  "emphasis",
  "code",
  "mark",
  "time",
  "subscript",
  "superscript",
  "insertion",
  "deletion",
  "row",
  "rowgroup",
  "cell",
  "columnheader",
  "rowheader",
  "caption"
]);

/** Chromium's own role names that platforms expose as an ARIA role; HTML-AAM maps summary to a button. */
const SPOKEN_INTERNAL_ROLES = new Map([["DisclosureTriangle", "button"]]);

/**
 * Roles announced only when they have an accessible name. Core-AAM and HTML-AAM expose a form or a
 * region as a landmark only when it is named, and recent Chromium leaves that rule to the platform
 * (its tree calls every <form> a form), so the reader applies it. An unnamed group, such as a
 * details element, is not announced either.
 */
const NAMED_ONLY_ROLES = new Set(["form", "region", "group"]);

/** Roles the accessible-name rules give no name, so their content is what is read. */
const CONTENT_ROLES = new Set(["paragraph", "listitem", "status", "alert"]);

/**
 * Creates a deterministic semantic navigator. It reads the page but never focuses, clicks, types,
 * or dispatches events. It is useful portable evidence, not a substitute for VoiceOver or NVDA.
 */
export function createPortableVirtualScreenReader(
  page: VirtualScreenReaderPage
): PortableVirtualScreenReader {
  const entries: VirtualScreenReaderEntry[] = [];
  let currentKey: string | undefined;
  let currentItem: VirtualScreenReaderItem | undefined;

  return {
    async command(command) {
      const before = await captureSemanticState(page);
      const item = selectItem(command, before.items, currentKey);
      const announcement = item
        ? describeItem(item)
        : describeBoundary(command, currentKey === undefined);

      if (item) {
        currentKey = item.key;
        currentItem = item;
      }

      const after = await captureSemanticState(page);
      const entry: VirtualScreenReaderEntry = {
        sequence: entries.length + 1,
        timestamp: new Date().toISOString(),
        command,
        announcement,
        ...(item ? { item } : {}),
        ...(before.focusKey ? { domFocusBefore: before.focusKey } : {}),
        ...(after.focusKey ? { domFocusAfter: after.focusKey } : {}),
        focusMoved: before.focusKey !== after.focusKey
      };

      entries.push(entry);
      return cloneEntry(entry);
    },
    async snapshot() {
      return {
        schemaVersion: "0.1.0",
        engine: "aee-portable-virtual-screen-reader",
        engineVersion: "0.1.0",
        mode: "guide",
        fidelity: "semantic-simulation",
        physicalAssistiveTechnology: false,
        pageUrl: page.url(),
        generatedAt: new Date().toISOString(),
        ...(currentItem ? { currentItem: cloneItem(currentItem) } : {}),
        entries: entries.map(cloneEntry)
      };
    }
  };
}

function selectItem(
  command: VirtualScreenReaderCommand,
  items: VirtualScreenReaderItem[],
  currentKey: string | undefined
): VirtualScreenReaderItem | undefined {
  const currentIndex = currentKey ? items.findIndex(({ key }) => key === currentKey) : -1;

  if (command === "read-current") {
    return currentIndex >= 0 ? items[currentIndex] : items[0];
  }

  if (command === "start") {
    return items[0];
  }

  const backwards = command === "previous-item" || command === "previous-heading";
  const predicate = getCommandPredicate(command);

  if (backwards) {
    for (let index = currentIndex < 0 ? items.length - 1 : currentIndex - 1; index >= 0; index--) {
      if (predicate(items[index]!)) {
        return items[index];
      }
    }

    return undefined;
  }

  for (let index = currentIndex + 1; index < items.length; index++) {
    if (predicate(items[index]!)) {
      return items[index];
    }
  }

  return undefined;
}

function getCommandPredicate(
  command: VirtualScreenReaderCommand
): (item: VirtualScreenReaderItem) => boolean {
  if (command === "next-heading" || command === "previous-heading") {
    return ({ role }) => role === "heading";
  }

  if (command === "next-landmark") {
    return ({ role }) => LANDMARK_ROLES.has(role);
  }

  if (command === "next-control") {
    return ({ role }) => CONTROL_ROLES.has(role);
  }

  return () => true;
}

function describeBoundary(command: VirtualScreenReaderCommand, hasNoCursor: boolean): string {
  if (hasNoCursor) {
    return "No readable item.";
  }

  return command.startsWith("previous") ? "Start of document." : "End of document.";
}

function describeItem(item: VirtualScreenReaderItem): string {
  const parts = [item.name ?? item.text, SPOKEN_INTERNAL_ROLES.get(item.role) ?? item.role];

  if (item.role === "heading" && item.level) {
    parts.push(`level ${item.level}`);
  }

  parts.push(...item.states);
  return parts.filter((part): part is string => Boolean(part)).join(", ");
}

function cloneItem(item: VirtualScreenReaderItem): VirtualScreenReaderItem {
  return {
    ...item,
    states: [...item.states],
    ...(item.visualBounds ? { visualBounds: { ...item.visualBounds } } : {})
  };
}

function cloneEntry(entry: VirtualScreenReaderEntry): VirtualScreenReaderEntry {
  return {
    sequence: entry.sequence,
    timestamp: entry.timestamp,
    command: entry.command,
    announcement: entry.announcement,
    ...(entry.item ? { item: cloneItem(entry.item) } : {}),
    ...(entry.domFocusBefore ? { domFocusBefore: entry.domFocusBefore } : {}),
    ...(entry.domFocusAfter ? { domFocusAfter: entry.domFocusAfter } : {}),
    focusMoved: entry.focusMoved
  };
}

/** Roles, names and states come from the browser's accessibility tree; the DOM supplies where. */
async function captureSemanticState(page: VirtualScreenReaderPage): Promise<PageSemanticState> {
  return withCdpSession(page.context(), page, async (session) => {
    const [tree, dom, focused] = await Promise.all([
      fetchAccessibilityTree(session),
      captureDom(session),
      activeElementNode(session)
    ]);
    const focusKey = focused === undefined ? undefined : dom.element(focused)?.nodePath;
    return { items: readableItems(tree.nodes, dom), ...(focusKey ? { focusKey } : {}) };
  });
}

function readableItems(nodes: AccessibilityNode[], dom: CapturedDom): VirtualScreenReaderItem[] {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const items: VirtualScreenReaderItem[] = [];
  const visit = (node: AccessibilityNode | undefined): void => {
    if (!node) return;
    const item = node.ignored ? undefined : readableItem(node, byId, dom);
    if (item) items.push(item);
    node.childIds?.forEach((id) => visit(byId.get(id)));
  };
  visit(nodes[0]);
  return items;
}

function readableItem(
  node: AccessibilityNode,
  byId: Map<string, AccessibilityNode>,
  dom: CapturedDom
): VirtualScreenReaderItem | undefined {
  const role = textValue(node.role);
  const name = textValue(node.name);
  const spoken =
    node.role?.type === "role"
      ? !SILENT_ROLES.has(role ?? "") && !(NAMED_ONLY_ROLES.has(role ?? "") && !name)
      : SPOKEN_INTERNAL_ROLES.has(role ?? "");
  const element =
    spoken && node.backendDOMNodeId !== undefined ? dom.element(node.backendDOMNodeId) : undefined;
  if (!role || !element) return undefined;
  const text = !name && CONTENT_ROLES.has(role) ? spokenText(node, byId) : undefined;
  const level = role === "heading" ? propertyValue(node, "level") : undefined;

  return {
    key: element.nodePath,
    nodePath: element.nodePath,
    tagName: element.tagName,
    role,
    ...(name ? { name } : {}),
    ...(text ? { text } : {}),
    ...(typeof level === "number" ? { level } : {}),
    states: itemStates(node, element),
    ...(element.visualBounds ? { visualBounds: element.visualBounds } : {})
  };
}

function spokenText(
  node: AccessibilityNode,
  byId: Map<string, AccessibilityNode>
): string | undefined {
  const parts: string[] = [];
  const visit = (current: AccessibilityNode | undefined): void => {
    if (!current) return;
    if (current.role?.value === "StaticText") {
      if (!current.ignored && typeof current.name?.value === "string")
        parts.push(current.name.value);
      return;
    }
    current.childIds?.forEach((id) => visit(byId.get(id)));
  };
  node.childIds?.forEach((id) => visit(byId.get(id)));
  const text = parts.join("").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 240) : undefined;
}

function itemStates(node: AccessibilityNode, element: CapturedElement): string[] {
  const states: string[] = [];
  const expanded = propertyValue(node, "expanded");
  if (expanded === true) states.push("expanded");
  if (expanded === false) states.push("collapsed");
  const checked = propertyValue(node, "checked");
  if (checked === "true") states.push("checked");
  if (checked === "mixed") states.push("partially checked");
  if (propertyValue(node, "selected") === true) states.push("selected");
  const pressed = propertyValue(node, "pressed");
  if (pressed === "true") states.push("pressed");
  if (pressed === "mixed") states.push("partially pressed");
  if (propertyValue(node, "disabled") === true) states.push("disabled");
  if (propertyValue(node, "required") === true) states.push("required");
  // The tree has no aria-current property, so it is read from the element.
  const current = element.attribute("aria-current");
  if (current && current !== "false") {
    states.push(current === "true" ? "current" : `current ${current}`);
  }
  return states;
}

function propertyValue(node: AccessibilityNode, name: string): unknown {
  return node.properties?.find((property) => property.name === name)?.value.value;
}

function textValue(value: AccessibilityValue | undefined): string | undefined {
  const text = typeof value?.value === "string" ? value.value.trim() : "";
  return text || undefined;
}

interface CapturedElement {
  tagName: string;
  nodePath: string;
  attribute(name: string): string | undefined;
  visualBounds?: VirtualScreenReaderItem["visualBounds"];
}

interface CapturedDom {
  element(backendNodeId: number): CapturedElement | undefined;
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
    layout: { nodeIndex: number[]; bounds: number[][] };
  }>;
}

/** One CDP snapshot of the DOM: every element's tag, attributes, place in the tree and layout box. */
async function captureDom(session: CdpSession): Promise<CapturedDom> {
  const { strings, documents } = (await session.send("DOMSnapshot.captureSnapshot", {
    computedStyles: []
  })) as DomSnapshot;
  const { nodes, layout } = documents[0]!;
  const indexByBackendId = new Map(nodes.backendNodeId.map((id, index) => [id, index]));
  const boxes = new Map(layout.nodeIndex.map((node, index) => [node, layout.bounds[index]!]));
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
  // An element's id, or up to eight tag steps with their position among same-tag siblings.
  const nodePath = (index: number) => {
    const id = attribute(index, "id");
    if (id) return `#${id}`;
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

  return {
    element(backendNodeId) {
      const index = indexByBackendId.get(backendNodeId);
      if (index === undefined || !isElement(index)) return undefined;
      const [x = 0, y = 0, width = 0, height = 0] = boxes.get(index) ?? [];
      return {
        tagName: tagName(index),
        nodePath: nodePath(index),
        attribute: (name) => attribute(index, name),
        ...(width > 0 && height > 0 ? { visualBounds: { x, y, width, height } } : {})
      };
    }
  };
}

/** The DOM node that has focus, found the way the page sees it: document.activeElement. */
async function activeElementNode(session: CdpSession): Promise<number | undefined> {
  const { result } = (await session.send("Runtime.evaluate", {
    expression: "document.activeElement"
  })) as { result: { objectId?: string } };
  if (!result.objectId) return undefined;
  const { node } = (await session.send("DOM.describeNode", { objectId: result.objectId })) as {
    node: { backendNodeId: number };
  };
  return node.backendNodeId;
}
