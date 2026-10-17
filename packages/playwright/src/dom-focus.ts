import {
  mainFrameOf,
  type CdpSession,
  type DomNodeRef,
  type PageFrame,
  type PageSessions
} from "./accessibility-tree";
import { describeFocusElement, type FocusAccessibility } from "./focus-accessibility";
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

/** What the page itself shows of an element with focus, or on the way to it. */
interface ElementDescription {
  tagName: string;
  id?: string;
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
  /** Its place among the top document's tab stops. Absent inside a frame. */
  focusOrderIndex?: number;
  /** How many tab stops the top document has. Absent inside a frame. */
  focusableCount?: number;
}

/**
 * How an element with focus, or on the way to it, looks and where it sits; its role, name, states,
 * dialog and composite widget are the accessibility tree's, which is what NVDA and JAWS receive
 * from Chrome. They are absent when the tree does not have the element.
 */
export interface FocusedElement extends ElementDescription, Partial<FocusAccessibility> {
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

/**
 * One document's part of the chain to focus, run on the element that has focus there (the one
 * `ACTIVE_ELEMENT` finds): the document's active element and each shadow root's down to it, which
 * are the shadow hosts it is inside, read back up through each `getRootNode().host`; then the
 * element its `aria-activedescendant` names, looked up in the tree that holds it (the ARIA
 * ID-reference scope), or null. Returned as objects, for the page and the tree to describe.
 */
const FOCUS_ELEMENTS = `function () {
  const chain = [this];
  for (let root = this.getRootNode(); root instanceof ShadowRoot; root = root.host.getRootNode()) {
    chain.unshift(root.host);
  }
  const id = this.getAttribute("aria-activedescendant");
  return [...chain, id ? this.getRootNode().getElementById(id) : null];
}`;

const ACTIVE_DESCENDANT_ID = `function () {
  return this.getAttribute("aria-activedescendant") || undefined;
}`;

/** One document's part of DOM focus. */
interface DocumentFocus {
  /** The document's active element, then each shadow root's down to the one with focus. */
  chain: Array<Omit<FocusedElement, "frameId" | "framePath" | "backendDOMNodeId">>;
  activeDescendantId?: string;
  activeDescendant?: Omit<FocusedElement, "frameId" | "framePath" | "backendDOMNodeId">;
}

/** The protocol objects of an array the page returned, in order; null entries stay undefined. */
async function objectsOf(
  session: CdpSession,
  objectId: string
): Promise<Array<string | undefined>> {
  const { result } = (await session.send("Runtime.getProperties", {
    objectId,
    ownProperties: true
  })) as { result: Array<{ name: string; value?: { objectId?: string; subtype?: string } }> };
  return result
    .filter(({ name }) => /^\d+$/.test(name))
    .sort((first, second) => Number(first.name) - Number(second.name))
    .map(({ value }) => (value?.subtype === "node" ? value.objectId : undefined));
}

/**
 * Reads one document's part of DOM focus on its focused element: what the page shows of each
 * element (`describeElement`, in the page) and what the accessibility tree gives it.
 */
async function readDocumentFocus(
  session: CdpSession,
  focusedObjectId: string,
  countTabOrder: boolean
): Promise<DocumentFocus> {
  const describe = async (objectId: string) => ({
    ...(await callOn<ElementDescription>(session, objectId, `${describeElement}`, [
      { countTabOrder }
    ])),
    ...(await describeFocusElement(session, objectId))
  });
  const { result } = (await session.send("Runtime.callFunctionOn", {
    objectId: focusedObjectId,
    functionDeclaration: FOCUS_ELEMENTS
  })) as { result: { objectId: string } };
  const objects = await objectsOf(session, result.objectId);
  const activeDescendantObject = objects.pop();
  const chain = [];
  for (const objectId of objects) chain.push(await describe(objectId!));
  const activeDescendantId = await callOn<string | undefined>(
    session,
    focusedObjectId,
    ACTIVE_DESCENDANT_ID
  );
  return {
    chain,
    ...(activeDescendantId ? { activeDescendantId } : {}),
    ...(activeDescendantObject ? { activeDescendant: await describe(activeDescendantObject) } : {})
  };
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
    const focus = await readDocumentFocus(session, object.objectId, index === 0);
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
 * What the page itself shows of one element, run in the page on it: its tag, type and tab index,
 * whether its focus is visible, and its place in the top document's tab order. Its role and name
 * are the accessibility tree's, read outside the page. It is sent to the page as source, as
 * Playwright's own `evaluate` sends a function, so it uses nothing from outside itself.
 */
function describeElement(
  this: Element,
  { countTabOrder }: { countTabOrder: boolean }
): ElementDescription {
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
  const tagOf = (element: Element) => element.tagName.toLowerCase();
  const nodePathOf = (element: Element) => {
    const segments: string[] = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const id = current.id ? `#${current.id}` : "";
      segments.unshift(`${tagOf(current)}${id}`);
      if (id) break;
    }
    return segments.join(" > ");
  };
  const type = (this as HTMLInputElement).type;
  const tabIndex = (this as HTMLElement).tabIndex;
  const disabled = (this as HTMLButtonElement).disabled;
  const style = getComputedStyle(this);
  let focusVisible: boolean;
  try {
    focusVisible = this.matches(":focus-visible");
  } catch {
    focusVisible = false;
  }
  const outlineVisible = style.outlineStyle !== "none" && style.outlineWidth !== "0px";
  const shadowVisible = style.boxShadow !== "none";
  const focusOrderIndex = tabStops?.indexOf(this as HTMLElement) ?? -1;
  return {
    tagName: tagOf(this),
    id: this.id || undefined,
    type: typeof type === "string" && type ? type : undefined,
    tabIndex: typeof tabIndex === "number" ? tabIndex : undefined,
    disabled: typeof disabled === "boolean" ? disabled : undefined,
    nodePath: nodePathOf(this),
    focusVisible,
    focusIndicator: {
      visible: focusVisible && (outlineVisible || shadowVisible),
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow
    },
    focusOrderIndex: focusOrderIndex >= 0 ? focusOrderIndex : undefined,
    focusableCount: tabStops?.length
  };
}
