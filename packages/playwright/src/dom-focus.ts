import {
  mainFrameOf,
  type DomNodeRef,
  type PageFrame,
  type PageSessions
} from "./accessibility-tree";
import { callOn, documentOf, nodeOf } from "./frame-documents";

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
  /** Its place among the top document's tab stops. Absent inside a frame. */
  focusOrderIndex?: number;
  /** How many tab stops the top document has. Absent inside a frame. */
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

type ElementDescription = Omit<FocusedElement, "frameId" | "framePath" | "backendDOMNodeId">;

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
  const chain: Array<{ context: FocusContext; element: FocusedElement }> = [];
  const framePath: string[] = [];
  let last:
    { focus: DocumentFocus; place: Pick<FocusedElement, "frameId" | "framePath"> } | undefined;
  for (const [index, { frameId, backendNodeId }] of path.entries()) {
    const session = page.frames.find((frame) => frame.frameId === frameId)!.session;
    const { object } = (await session.send("DOM.resolveNode", { backendNodeId })) as {
      object: { objectId: string };
    };
    // Tab order is counted in the top document only: an index in a frame's own document is not a
    // place in the page's tab order, so comparing one with the other would mislead.
    const focus = await callOn<DocumentFocus>(
      session,
      object.objectId,
      `${describeDocumentFocus}`,
      [{ countTabOrder: index === 0 }]
    );
    const place = { frameId, ...(framePath.length ? { framePath: [...framePath] } : {}) };
    focus.chain.forEach((element, at) => {
      const deepest = at === focus.chain.length - 1;
      chain.push({
        context: at > 0 ? "shadow-root" : index > 0 ? "iframe-document" : "document",
        element: { ...element, ...place, ...(deepest ? { backendDOMNodeId: backendNodeId } : {}) }
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
    ...(activeDescendant ? { activeDescendant: { ...activeDescendant, ...last.place } } : {})
  };
}

/**
 * Describes DOM focus in one document, run in the page on the element that has focus there (the
 * one `ACTIVE_ELEMENT` finds). The document's active element and each shadow root's on the way
 * down to it are the shadow hosts it is inside, so the chain is read back up through each
 * `getRootNode().host`. It is sent to the page as source, as Playwright's own `evaluate` sends a
 * function, so it uses nothing from outside itself.
 */
function describeDocumentFocus(
  this: Element,
  { countTabOrder }: { countTabOrder: boolean }
): DocumentFocus {
  const COMPOSITE_ITEMS: Record<string, string> = {
    tablist: '[role="tab"]',
    radiogroup: '[role="radio"]',
    listbox: '[role="option"]',
    menu: '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
    menubar: '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
    tree: '[role="treeitem"]',
    grid: '[role="gridcell"], [role="rowheader"], [role="columnheader"]'
  };
  const tabStops = countTabOrder
    ? Array.from(
        this.ownerDocument.querySelectorAll<HTMLElement>(
          'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
        )
      ).filter((element) => {
        if (element.tabIndex < 0) return false;
        if ((element as HTMLButtonElement).disabled) return false;
        const style = getComputedStyle(element);
        if (style.display === "none" || style.visibility === "hidden") return false;
        return element.getClientRects().length > 0;
      })
    : undefined;

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
    const focusOrderIndex = tabStops?.indexOf(element as HTMLElement) ?? -1;
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
      focusOrderIndex: focusOrderIndex >= 0 ? focusOrderIndex : undefined,
      focusableCount: tabStops?.length
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
