import type * as Tabbable from "tabbable";

import {
  mainFrameOf,
  type DomNodeRef,
  type PageFrame,
  type PageSessions
} from "./accessibility-tree";
import {
  callOn,
  documentOf,
  loadPageScript,
  nodeOf,
  PageObject,
  TABBABLE_SCRIPT
} from "./frame-documents";

/**
 * The element focus is on in the frame's document, found the way the page sees it: its
 * `activeElement`, and on into each open shadow root's.
 */
const ACTIVE_ELEMENT = `function () {
  let element = document.activeElement;
  while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
  return element;
}`;

/** The frame whose `<iframe>` element this is, when it is one. */
export function frameHeldAt(
  page: PageSessions,
  node: { frameId: string; backendNodeId?: number } | undefined
): PageFrame | undefined {
  return node?.backendNodeId === undefined
    ? undefined
    : page.frames.find(
        (frame) =>
          frame.parentFrameId === node.frameId && frame.ownerBackendNodeId === node.backendNodeId
      );
}

/**
 * The element that has focus in each document on the way to DOM focus, top document first; the
 * last is the element that has focus. A document whose focus is in one of its frames names the
 * frame's element as its active element (HTML's `activeElement`), so focus is followed into that
 * frame's own document, through the frame's own session, so a cross-site frame in another process
 * is followed too. A frame that loses focus loses its own active element, so only the frames that
 * hold focus are followed. Empty when no element has focus.
 */
export async function focusPath(
  page: PageSessions,
  documentOfFrame: (frame: PageFrame) => Promise<string | undefined>
): Promise<DomNodeRef[]> {
  const path: DomNodeRef[] = [];
  for (let frame: PageFrame | undefined = mainFrameOf(page); frame;) {
    const document = await documentOfFrame(frame);
    const backendNodeId = document
      ? await nodeOf(frame.session, document, ACTIVE_ELEMENT)
      : undefined;
    if (backendNodeId === undefined) break;
    const focused = { frameId: frame.frameId, backendNodeId };
    path.push(focused);
    frame = frameHeldAt(page, focused);
  }
  return path;
}

/** How an element with focus, or on the way to it, looks and where it sits. */
export interface FocusedElement {
  tagName: string;
  id?: string;
  role?: string;
  name?: string;
  type?: string;
  tabIndex?: number;
  disabled?: boolean;
  /** Its id, or its tag path up to the nearest ancestor with one, in the tree that holds it. */
  nodePath: string;
  focusVisible: boolean;
  focusIndicator: {
    visible: boolean;
    outlineColor: string;
    outlineStyle: string;
    outlineWidth: string;
    boxShadow: string;
  };
  ariaSelected?: boolean;
  ariaChecked?: boolean;
  compositeRole?: string;
  compositeOrientation?: string;
  compositeItemIndex?: number;
  compositeItemCount?: number;
  dialogContext?: {
    tagName: string;
    id?: string;
    role?: string;
    name?: string;
    ariaModal?: boolean;
  };
  /**
   * Its place in the page's tab order, counted from 0 across the top document and every frame,
   * each frame's tab stops at its `<iframe>` element's place. Absent when it is not a tab stop, or
   * when a frame's place or tab stops could not be read, since then no place is certain.
   */
  focusOrderIndex?: number;
  /** How many tab stops the page has, in every frame; with `focusOrderIndex` only. */
  focusableCount?: number;
  /** The frame whose document holds it. */
  frameId: string;
  /** The `<iframe>` elements it is inside, outermost first, as their `nodePath`s. */
  framePath?: string[];
  /** The DOM node, as this browser session numbers it in its frame's process. */
  backendDOMNodeId?: number;
}

/** Where one element of the chain to focus is: its document, or a shadow root inside it. */
export type FocusContext = "document" | "shadow-root" | "iframe-document";

/** Where DOM focus is, followed through shadow roots and frames, as the focus observer records it. */
export interface DomFocusState extends FocusedElement {
  schemaVersion: "0.1.0";
  captureType: "deep-focus-state";
  /** The top document's `activeElement`. */
  documentActiveElement: FocusedElement;
  /** The element that has focus, in whichever shadow root or frame holds it. */
  deepActiveElement: FocusedElement;
  /** Each active element from the top document's down to the one with focus. */
  activeElementChain: Array<FocusedElement & { context: FocusContext }>;
  activeDescendantId?: string;
  activeDescendant?: FocusedElement;
}

type ElementDescription = Omit<
  FocusedElement,
  "frameId" | "framePath" | "backendDOMNodeId" | "focusOrderIndex" | "focusableCount"
> & {
  /** Its place among its own document's tab stops, as tabbable orders them. */
  tabStop?: number;
};

/** One document's part of DOM focus, as `describeDocumentFocus` reads it in the page. */
interface DocumentFocus {
  /** The document's active element, then each shadow root's down to the one with focus. */
  chain: ElementDescription[];
  activeDescendantId?: string;
  activeDescendant?: ElementDescription;
}

/**
 * Where DOM focus is: the element that has it, followed into shadow roots and into each frame's
 * own document (`focusPath`), and every active element on the way, each described in its own
 * document. The deepest element names its frame, so it joins to that frame's accessibility tree by
 * `frameId` and `backendDOMNodeId`. Null when no element has focus.
 */
export async function captureDomFocus(page: PageSessions): Promise<DomFocusState | null> {
  const path = await focusPath(page, (frame) => documentOf(page, frame));
  const order = path.length ? await pageTabOrder(page) : undefined;
  // A frame with nothing to focus is a tab stop itself; focus on it leaves its document's body
  // as that document's active element.
  const placed = ({ tabStop, ...element }: ElementDescription, frameId: string) => {
    const stop = tabStop ?? (element.tagName === "body" ? "frame" : undefined);
    const index = order && stop !== undefined ? order.indexOf(frameId, stop) : -1;
    return index < 0
      ? element
      : { ...element, focusOrderIndex: index, focusableCount: order!.count };
  };
  const chain: Array<{ context: FocusContext; element: FocusedElement }> = [];
  const framePath: string[] = [];
  let last:
    { focus: DocumentFocus; place: Pick<FocusedElement, "frameId" | "framePath"> } | undefined;
  for (const [index, { frameId, backendNodeId }] of path.entries()) {
    const session = page.frames.find((frame) => frame.frameId === frameId)!.session;
    const { object } = (await session.send("DOM.resolveNode", { backendNodeId })) as {
      object: { objectId: string };
    };
    // tabbable is in every frame's page once the page's order is counted, and a place in a
    // document's own tab stops means nothing without it.
    const focus = await callOn<DocumentFocus>(
      session,
      object.objectId,
      `${describeDocumentFocus}`,
      [order ? TABBABLE_IN_PAGE : null]
    );
    const place = { frameId, ...(framePath.length ? { framePath: [...framePath] } : {}) };
    focus.chain.forEach((element, at) => {
      const deepest = at === focus.chain.length - 1;
      chain.push({
        context: at > 0 ? "shadow-root" : index > 0 ? "iframe-document" : "document",
        element: {
          ...placed(element, frameId),
          ...place,
          ...(deepest ? { backendDOMNodeId: backendNodeId } : {})
        }
      });
    });
    framePath.push(chain.at(-1)!.element.nodePath);
    last = { focus, place };
  }
  if (!last) return null;

  const deepActiveElement = chain.at(-1)!.element;
  const { activeDescendantId, activeDescendant } = last.focus;
  return {
    schemaVersion: "0.1.0",
    captureType: "deep-focus-state",
    ...deepActiveElement,
    documentActiveElement: chain[0]!.element,
    deepActiveElement,
    activeElementChain: chain.map(({ context, element }) => ({ context, ...element })),
    ...(activeDescendantId ? { activeDescendantId } : {}),
    ...(activeDescendant
      ? { activeDescendant: { ...placed(activeDescendant, last.place.frameId), ...last.place } }
      : {})
  };
}

/** How the page asks tabbable for a document's tab stops, the same way for every document. */
interface TabbableInPage {
  /** The global the tabbable script sets in each frame's page. */
  global: string;
  /** Shadow roots are entered, as the browser's Tab enters them. */
  options: Tabbable.CheckOptions;
}

const TABBABLE_IN_PAGE: TabbableInPage = {
  global: TABBABLE_SCRIPT.global,
  options: { getShadowRoot: true }
};

/**
 * One tab stop of the page: one of its document's own tab stops, by its place among them, or a
 * frame that has none, which Chrome's Tab stops on itself.
 */
interface PageTabStop {
  frameId: string;
  stop: number | "frame";
}

/** The page's tab order, across the top document and every frame. */
interface PageTabOrder {
  count: number;
  /** A stop's place in the page's order, or -1 when the page's order does not hold it. */
  indexOf(frameId: string, stop: number | "frame"): number;
}

/**
 * The page's tab order: each document's own tab stops in the order tabbable gives them, which
 * follows HTML's sequential focus navigation (positive tabindex first, then document order, into
 * shadow roots), with each frame's tab stops at its `<iframe>` element's place in its parent's
 * order, as Chrome's Tab moves through them. Each frame is read through its own session, so a
 * cross-site frame in another process counts too. Undefined when any frame could not be read or
 * placed: one missing frame would shift every place after it.
 */
async function pageTabOrder(page: PageSessions): Promise<PageTabOrder | undefined> {
  if (page.framesNotRead.length) return undefined;
  const sequences = new Map<string, { sequence: TabToken[]; children: PageFrame[] }>();
  for (const frame of page.frames) {
    const document = await documentOf(page, frame);
    if (!document) return undefined;
    await loadPageScript(frame.session, document, TABBABLE_SCRIPT);
    const children = page.frames.filter(({ parentFrameId }) => parentFrameId === frame.frameId);
    const owners: PageObject[] = [];
    for (const { ownerBackendNodeId } of children) {
      if (ownerBackendNodeId === undefined) return undefined;
      const { object } = (await frame.session.send("DOM.resolveNode", {
        backendNodeId: ownerBackendNodeId
      })) as { object: { objectId?: string } };
      if (!object.objectId) return undefined;
      owners.push(new PageObject(object.objectId));
    }
    const sequence = await callOn<TabToken[] | null>(
      frame.session,
      document,
      `${documentTabSequence}`,
      [TABBABLE_IN_PAGE, ...owners]
    );
    if (!sequence) return undefined;
    sequences.set(frame.frameId, { sequence, children });
  }
  const stopsOf = (frame: PageFrame): PageTabStop[] => {
    const { sequence, children } = sequences.get(frame.frameId)!;
    return sequence.flatMap((token) => {
      if ("stop" in token) return [{ frameId: frame.frameId, stop: token.stop }];
      const child = children[token.frame]!;
      const inside = stopsOf(child);
      return inside.length ? inside : [{ frameId: child.frameId, stop: "frame" as const }];
    });
  };
  const stops = stopsOf(mainFrameOf(page));
  return {
    count: stops.length,
    indexOf: (frameId, stop) =>
      stops.findIndex((entry) => entry.frameId === frameId && entry.stop === stop)
  };
}

/**
 * One place in a document's tab order: one of tabbable's tab stops, by its place in tabbable's
 * list, or the frame whose `<iframe>` element is at that place, by its place in the list of frames.
 */
type TabToken = { stop: number } | { frame: number };

/**
 * One document's tab order, run in the page on its `document` with the `<iframe>` elements of its
 * frames, in tabbable's order. Chrome's Tab goes into a frame rather than stopping on its element,
 * so an `<iframe>` tabbable lists (one with a tabindex) stands for its frame. tabbable leaves out
 * any other frame (its README: their tabbability differs between browsers), so each is placed by
 * the rule tabbable sorts by, read from its source (`sortByOrder`): in each scope (the document, an
 * open shadow root, a slot), positive tabindex first in ascending order, then tabindex 0, each in
 * document order, and a scope's content at its host's place. A frame whose element is hidden,
 * inert (itself or through a shadow host) or has a negative tabindex is left out, as Chrome's Tab
 * skips it. Null when a frame's element is not an `<iframe>`, or sits in a closed shadow root,
 * since that rule cannot place either. Sent to the page as source, so it uses nothing from outside
 * itself.
 */
function documentTabSequence(
  this: Document,
  { global, options }: TabbableInPage,
  ...owners: Element[]
): TabToken[] | null {
  const { tabbable, isFocusable, getTabIndex } = (
    globalThis as unknown as Record<string, typeof Tabbable>
  )[global]!;
  // tabbable cannot see into a closed shadow root, so it cannot place a frame inside one.
  const inClosedShadowRoot = (node: Element) => {
    for (
      let root = node.getRootNode();
      root instanceof ShadowRoot;
      root = root.host.getRootNode()
    ) {
      if (root.host.shadowRoot !== root) return true;
    }
    return false;
  };
  if (owners.some((owner) => owner.localName !== "iframe" || inClosedShadowRoot(owner))) {
    return null;
  }
  const stops: Element[] = tabbable(this.documentElement, options);

  // Where tabbable sorts an element: inside each slot and shadow host it is reached through.
  const parentOf = (node: Element): Element | null =>
    node.assignedSlot ??
    node.parentElement ??
    (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
  const scopesOf = (node: Element) => {
    const scopes: Element[] = [];
    for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
      if (parent.localName === "slot" || parent.shadowRoot) scopes.unshift(parent);
    }
    return scopes;
  };
  const hasTabIndex = (element: Element) =>
    !Number.isNaN(parseInt(element.getAttribute("tabindex") ?? "", 10));
  // tabbable's `getSortOrderTabIndex`: a scope with no tabindex of its own sorts as 0.
  const sortKey = (element: Element, isScope: boolean) => {
    const tabIndex = getTabIndex(element);
    return tabIndex < 0 && isScope && !hasTabIndex(element) ? 0 : tabIndex;
  };
  const comesBefore = (first: Element, second: Element) => {
    const firstScopes = scopesOf(first);
    const secondScopes = scopesOf(second);
    let level = 0;
    while (level < firstScopes.length && firstScopes[level] === secondScopes[level]) level += 1;
    const a = firstScopes[level] ?? first;
    const b = secondScopes[level] ?? second;
    // A shadow host that is a tab stop itself comes before what its shadow root holds.
    if (a === b) return a === first;
    const keyA = sortKey(a, a !== first);
    const keyB = sortKey(b, b !== second);
    if (keyA !== keyB && (keyA > 0 || keyB > 0)) return keyB === 0 || (keyA > 0 && keyA < keyB);
    return Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  };
  // tabbable leaves out a shadow root's content when its host has a negative tabindex, and
  // inert covers a shadow root's content too, which tabbable's own check stops short of.
  const inert = (node: Element) => {
    for (let element: Element | null = node; element; element = parentOf(element)) {
      if ((element as HTMLElement).inert) return true;
    }
    return false;
  };
  const reached = (owner: Element) =>
    isFocusable(owner, options) &&
    getTabIndex(owner) >= 0 &&
    !inert(owner) &&
    scopesOf(owner).every(
      (scope) => !scope.shadowRoot || !hasTabIndex(scope) || getTabIndex(scope) >= 0
    );

  const unlisted = owners
    .map((owner, frame) => ({ owner, frame }))
    .filter(({ owner }) => !stops.includes(owner) && reached(owner))
    .sort((x, y) => (comesBefore(x.owner, y.owner) ? -1 : 1))
    .map(({ owner, frame }) => ({
      frame,
      at: stops.filter((stop) => comesBefore(stop, owner)).length
    }));
  const framesAt = (at: number) =>
    unlisted.filter((placed) => placed.at === at).map(({ frame }) => ({ frame }));
  return [
    ...stops.flatMap((stop, at) => {
      const frame = owners.indexOf(stop);
      return [...framesAt(at), frame < 0 ? { stop: at } : { frame }];
    }),
    ...framesAt(stops.length)
  ];
}

/**
 * Describes DOM focus in one document, run in the page on the element that has focus there (the
 * one `ACTIVE_ELEMENT` finds). The document's active element and each shadow root's on the way
 * down to it are the shadow hosts it is inside, so the chain is read back up through each
 * `getRootNode().host`. It is sent to the page as source, as Playwright's own `evaluate` sends a
 * function, so it uses nothing from outside itself.
 */
function describeDocumentFocus(this: Element, tabOrder: TabbableInPage | null): DocumentFocus {
  const COMPOSITE_ITEMS: Record<string, string> = {
    tablist: '[role="tab"]',
    radiogroup: '[role="radio"]',
    listbox: '[role="option"]',
    menu: '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
    menubar: '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
    tree: '[role="treeitem"]',
    grid: '[role="gridcell"], [role="rowheader"], [role="columnheader"]'
  };
  const tabStops: Element[] = tabOrder
    ? (globalThis as unknown as Record<string, typeof Tabbable>)[tabOrder.global]!.tabbable(
        this.ownerDocument.documentElement,
        tabOrder.options
      )
    : [];

  const booleanAttribute = (element: Element, name: string) => {
    const value = element.getAttribute(name);
    return value === "true" ? true : value === "false" ? false : undefined;
  };
  const tagOf = (element: Element) => element.tagName.toLowerCase();
  const implicitRole = (element: Element, tagName: string): string | undefined => {
    if (tagName === "a" && element.getAttribute("href")) return "link";
    if (tagName === "button" || tagName === "summary") return "button";
    if (tagName === "textarea") return "textbox";
    if (tagName === "select")
      return element.getAttribute("multiple") !== null ? "listbox" : "combobox";
    if (tagName !== "input") return undefined;
    const type = (element as HTMLInputElement).type.toLowerCase();
    if (type === "checkbox") return "checkbox";
    if (type === "radio") return "radio";
    if (["button", "image", "reset", "submit"].includes(type)) return "button";
    if (type === "range") return "slider";
    if (type === "number") return "spinbutton";
    if (["email", "search", "tel", "text", "url"].includes(type)) return "textbox";
    return undefined;
  };
  const nodePathOf = (element: Element) => {
    const segments: string[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const id = current.id ? `#${current.id}` : "";
      segments.unshift(`${tagOf(current)}${id}`);
      if (id) break;
    }
    return segments.join(" > ");
  };
  // An id reference is looked up in the tree that holds the element: its document or shadow root.
  const byId = (element: Element, id: string) =>
    (element.getRootNode() as Document | ShadowRoot).getElementById(id);
  const compositeOf = (element: Element) => {
    for (let current = element.parentElement; current; current = current.parentElement) {
      const role = current.getAttribute("role");
      if (role && role in COMPOSITE_ITEMS) return { role, element: current };
    }
    return undefined;
  };
  const dialogOf = (element: Element) => {
    for (let current: Element | null = element; current; current = current.parentElement) {
      const role = current.getAttribute("role");
      const tagName = tagOf(current);
      if (tagName !== "dialog" && role !== "dialog" && role !== "alertdialog") continue;
      const labelledById = current.getAttribute("aria-labelledby");
      const labelledByText = labelledById
        ? byId(current, labelledById)?.textContent?.trim()
        : undefined;
      return {
        tagName,
        id: current.id || undefined,
        role: role ?? (tagName === "dialog" ? "dialog" : undefined),
        name:
          current.getAttribute("aria-label") ??
          (labelledByText || current.textContent?.trim().slice(0, 120)),
        ariaModal: booleanAttribute(current, "aria-modal")
      };
    }
    return undefined;
  };
  const describe = (element: Element): ElementDescription => {
    const tagName = tagOf(element);
    const role = element.getAttribute("role") ?? implicitRole(element, tagName);
    const text = element.textContent?.trim();
    const canUseTextAsName =
      Boolean(role) || ["a", "button", "label", "option", "summary", "td", "th"].includes(tagName);
    const type = (element as HTMLInputElement).type;
    const tabIndex = (element as HTMLElement).tabIndex;
    const disabled = (element as HTMLButtonElement).disabled;
    const style = getComputedStyle(element);
    let focusVisible: boolean;
    try {
      focusVisible = element.matches(":focus-visible");
    } catch {
      focusVisible = false;
    }
    const outlineVisible = style.outlineStyle !== "none" && style.outlineWidth !== "0px";
    const shadowVisible = style.boxShadow !== "none";
    const composite = compositeOf(element);
    const compositeItems = composite
      ? Array.from(composite.element.querySelectorAll(COMPOSITE_ITEMS[composite.role]!))
      : [];
    const compositeItemIndex = compositeItems.indexOf(element);
    const tabStop = tabStops.indexOf(element);
    return {
      tagName,
      id: element.id || undefined,
      role: role ?? undefined,
      name:
        element.getAttribute("aria-label") ??
        element.getAttribute("name") ??
        (canUseTextAsName && text ? text.slice(0, 120) : undefined),
      type: typeof type === "string" && type ? type : undefined,
      tabIndex: typeof tabIndex === "number" ? tabIndex : undefined,
      disabled: typeof disabled === "boolean" ? disabled : undefined,
      nodePath: nodePathOf(element),
      focusVisible,
      focusIndicator: {
        visible: focusVisible && (outlineVisible || shadowVisible),
        outlineColor: style.outlineColor,
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow
      },
      ariaSelected: booleanAttribute(element, "aria-selected"),
      ariaChecked: booleanAttribute(element, "aria-checked"),
      compositeRole: composite?.role,
      compositeOrientation: composite
        ? (composite.element.getAttribute("aria-orientation") ??
          (composite.role === "tablist" || composite.role === "menubar"
            ? "horizontal"
            : "vertical"))
        : undefined,
      compositeItemIndex: compositeItemIndex >= 0 ? compositeItemIndex : undefined,
      compositeItemCount: compositeItems.length > 0 ? compositeItems.length : undefined,
      dialogContext: dialogOf(element),
      tabStop: tabStop >= 0 ? tabStop : undefined
    };
  };

  const chain = [this];
  for (let root = this.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) {
    chain.unshift(root.host);
  }
  const activeDescendantId = this.getAttribute("aria-activedescendant") || undefined;
  const activeDescendant = activeDescendantId ? byId(this, activeDescendantId) : null;
  return {
    chain: chain.map(describe),
    activeDescendantId,
    activeDescendant: activeDescendant ? describe(activeDescendant) : undefined
  };
}
