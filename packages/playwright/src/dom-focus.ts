import { describeRequestedTarget, type RequestedTarget } from "@aee/core";
import type * as Tabbable from "tabbable";

import {
  mainFrameOf,
  type CdpSession,
  type DomNodeRef,
  type PageFrame,
  type PageSessions
} from "./accessibility-tree";
import { describeAxeTarget } from "./axe-results";
import { elementSelectors } from "./element-selectors";
import { describeFocusElement, type FocusAccessibility } from "./focus-accessibility";
import {
  callOn,
  frameDocuments,
  loadPageScript,
  nodeOf,
  objectOn,
  PageObject,
  TABBABLE_SCRIPT,
  type FrameDocuments,
  type ShadowRootsInPage
} from "./frame-documents";

/**
 * The element focus is on in the frame's document: its `activeElement`, and on into each shadow
 * root's, closed ones too. A closed root's host stands for whatever has focus inside it, so it is
 * followed through the frame's `ShadowRootsInPage`.
 */
const ACTIVE_ELEMENT = `function (shadowRoots) {
  let element = document.activeElement;
  while (element && shadowRoots.getShadowRoot(element)?.activeElement) {
    element = shadowRoots.getShadowRoot(element).activeElement;
  }
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
 * hold focus are followed. Focus is followed into closed shadow roots too, so a frame inside one
 * is followed. Empty when no element has focus.
 */
export async function focusPath(
  page: PageSessions,
  documents: FrameDocuments
): Promise<DomNodeRef[]> {
  const path: DomNodeRef[] = [];
  for (let frame: PageFrame | undefined = mainFrameOf(page); frame;) {
    const document = await documents.document(frame);
    const shadowRoots = document && (await documents.shadowRoots(frame));
    const backendNodeId = shadowRoots
      ? await nodeOf(frame.session, document, ACTIVE_ELEMENT, [shadowRoots])
      : undefined;
    if (backendNodeId === undefined) break;
    const focused = { frameId: frame.frameId, backendNodeId };
    path.push(focused);
    frame = frameHeldAt(page, focused);
  }
  return path;
}

/**
 * How an element with focus, or on the way to it, looks and where it sits; its role, name, states,
 * dialog and composite widget are the accessibility tree's, which is what NVDA and JAWS receive
 * from Chrome. They are absent when the tree does not have the element.
 */
export interface FocusedElement extends Partial<FocusAccessibility> {
  tagName: string;
  id?: string;
  type?: string;
  tabIndex?: number;
  disabled?: boolean;
  /**
   * Its path in the document that holds it, as axe-core writes it in a result's `target`: the
   * shortest selector that selects it alone, with each step into a shadow root after ">>>".
   */
  nodePath: string;
  focusVisible: boolean;
  focusIndicator: {
    visible: boolean;
    outlineColor: string;
    outlineStyle: string;
    outlineWidth: string;
    boxShadow: string;
  };
  /**
   * Its place in the page's tab order, counted from 0 across the top document and every frame,
   * each frame's tab stops at its `<iframe>` element's place. Absent when it is not a tab stop, or
   * when a frame's place or tab stops could not be read, since then no place is certain.
   */
  focusOrderIndex?: number;
  /**
   * How many tab stops the page has, in every frame: recorded whenever the page's tab order was
   * counted, so an element with a count and no `focusOrderIndex` is known not to be a tab stop.
   */
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
  /**
   * The top document's `hasFocus()`: whether focus is in the page at all. When no element of a
   * document has focus its `<body>` is its active element, both when focus is lost inside the page
   * (true) and when Tab has moved focus out of it, to the browser's own controls (false).
   */
  documentHasFocus: boolean;
  /** The top document's `activeElement`. */
  documentActiveElement: FocusedElement;
  /** The element that has focus, in whichever shadow root or frame holds it. */
  deepActiveElement: FocusedElement;
  /** Each active element from the top document's down to the one with focus. */
  activeElementChain: Array<FocusedElement & { context: FocusContext }>;
  activeDescendantId?: string;
  activeDescendant?: FocusedElement;
}

/** What the page itself shows of an element; the rest of a `FocusedElement` is placed after. */
type PageDescription = Omit<
  FocusedElement,
  | keyof FocusAccessibility
  | "nodePath"
  | "frameId"
  | "framePath"
  | "backendDOMNodeId"
  | "focusOrderIndex"
  | "focusableCount"
> & {
  /** Its place among its own document's tab stops, as tabbable orders them. */
  tabStop?: number;
};

type ElementDescription = PageDescription &
  Pick<FocusedElement, "nodePath"> &
  Partial<FocusAccessibility>;

/**
 * One document's part of the chain to focus, run on the element that has focus there (the one
 * `ACTIVE_ELEMENT` finds): the document's active element and each shadow root's down to it, which
 * are the shadow hosts it is inside, read back up through each `getRootNode().host`, closed roots'
 * hosts too; then the element its `aria-activedescendant` names, looked up in the tree that holds
 * it (the ARIA ID-reference scope), or null. Kept in the page, for the page and the tree to
 * describe.
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

/** The objects of an array kept in the page, in order; a null entry is undefined. */
async function objectsOf(
  session: CdpSession,
  array: PageObject
): Promise<Array<string | undefined>> {
  const { result } = (await session.send("Runtime.getProperties", {
    objectId: array.objectId,
    ownProperties: true
  })) as { result: Array<{ name: string; value?: { objectId?: string; subtype?: string } }> };
  return result
    .filter(({ name }) => /^\d+$/.test(name))
    .sort((first, second) => Number(first.name) - Number(second.name))
    .map(({ value }) => (value?.subtype === "node" ? value.objectId : undefined));
}

/**
 * One document's part of DOM focus, read on its focused element: what the page shows of each
 * element on the way to focus (`describeElement`, in the page), its path in the document (axe-core's,
 * `elementSelectors`), and what the accessibility tree gives it, read on the same element in its
 * frame's own session.
 */
async function readDocumentFocus(
  session: CdpSession,
  focusedObjectId: string,
  pageArguments: [tabbableGlobal: string | null, shadowRoots: PageObject]
): Promise<DocumentFocus> {
  const elements = await objectOn(session, focusedObjectId, FOCUS_ELEMENTS);
  if (!elements) throw new Error("The page returned no elements on the way to focus.");
  const objects = await objectsOf(session, elements);
  const activeDescendantObject = objects.pop();
  const described = [...objects, activeDescendantObject].filter(
    (objectId): objectId is string => objectId !== undefined
  );
  const paths = await elementSelectors(
    session,
    described.map((objectId) => new PageObject(objectId))
  );
  const describe = async (objectId: string): Promise<ElementDescription> => ({
    ...(await callOn<PageDescription>(session, objectId, `${describeElement}`, pageArguments)),
    nodePath: describeAxeTarget([paths[described.indexOf(objectId)]!]),
    ...(await describeFocusElement(session, objectId))
  });
  const chain: ElementDescription[] = [];
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

/** One document's part of DOM focus. */
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
 * `frameId` and `backendDOMNodeId`. When no element of a document has focus, its `<body>` is its
 * active element and is recorded, beside whether the page itself has focus (`documentHasFocus`).
 * Null only when the top document has no active element at all.
 */
export async function captureDomFocus(page: PageSessions): Promise<DomFocusState | null> {
  const documents = frameDocuments(page);
  const path = await focusPath(page, documents);
  if (!path.length) return null;
  const top = mainFrameOf(page);
  const documentHasFocus = await callOn<boolean>(
    top.session,
    (await documents.document(top))!,
    `function () { return this.hasFocus(); }`
  );
  const order = await pageTabOrder(page, documents);
  // A frame with nothing to focus is a tab stop itself; focus on it leaves its document's body
  // as that document's active element. Anything else with no place is not a tab stop.
  const placed = ({ tabStop, ...element }: ElementDescription, frameId: string) => {
    if (!order) return element;
    const stop = tabStop ?? (element.tagName === "body" ? "frame" : undefined);
    const index = stop === undefined ? -1 : order.indexOf(frameId, stop);
    return {
      ...element,
      ...(index < 0 ? {} : { focusOrderIndex: index }),
      focusableCount: order.count
    };
  };
  const chain: Array<{ context: FocusContext; element: FocusedElement }> = [];
  const framePath: string[] = [];
  let last:
    { focus: DocumentFocus; place: Pick<FocusedElement, "frameId" | "framePath"> } | undefined;
  for (const [index, { frameId, backendNodeId }] of path.entries()) {
    const frame = page.frames.find((candidate) => candidate.frameId === frameId)!;
    const { object } = (await frame.session.send("DOM.resolveNode", { backendNodeId })) as {
      object: { objectId: string };
    };
    // tabbable is in every frame's page once the page's order is counted, and a place in a
    // document's own tab stops means nothing without it. focusPath read the frame's shadow roots.
    const focus = await readDocumentFocus(frame.session, object.objectId, [
      order ? TABBABLE_SCRIPT.global : null,
      (await documents.shadowRoots(frame))!
    ]);
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
    documentHasFocus,
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

/**
 * Whether the element an interaction's target names, by its selector or by its role and name, is
 * the element with focus. The focus judge reads this rather than comparing the target's text with
 * the focused element's: two elements can have the same path in their own documents, or the same
 * role and name, and one element can be selected in many ways.
 */
export type RequestedTargetFocus = RequestedTarget & {
  /**
   * - `focused`: the target matches one element, and it is the element with focus;
   * - `not-focused`: it matches one element, and focus is on another, or deeper inside it (in its
   *   shadow root or its frame);
   * - `unresolved`: which element it means, or whether that one has focus, cannot be told
   *   (`reason`).
   */
  status: "focused" | "not-focused" | "unresolved";
  /** How many elements the target matches in the page, when Playwright could look. */
  matchCount?: number;
  reason?: string;
};

/**
 * The elements an interaction's target matches, found by Playwright as the scenario's action
 * found them (`page.locator` for a selector, `page.getByRole` for a role and name).
 */
export interface TargetElements {
  evaluateAll(pageFunction: (elements: Element[]) => ActiveChainPlace): Promise<unknown>;
}

/**
 * Where the elements a target matches stand on the way to focus, run in the page by Playwright
 * on all of them: how many they are, and, for one, how many documents and shadow roots there are
 * from it up to the top page (`roots`) when it is the active element of each (its own document or
 * shadow root's, its host's in the root above, the `<iframe>` element's in the document above),
 * or -1 when it is not. Undefined `roots` when a frame above it is cross-origin, so its
 * `<iframe>` element cannot be read from inside. Sent to the page as source, so it uses nothing
 * from outside itself.
 */
function activeChainPlace(elements: Element[]): ActiveChainPlace {
  if (elements.length !== 1) return { count: elements.length };
  let roots = 0;
  for (let node: Element | null = elements[0]!; node;) {
    const root = node.getRootNode();
    if (!(root instanceof Document || root instanceof ShadowRoot) || root.activeElement !== node) {
      return { count: 1, roots: -1 };
    }
    roots += 1;
    if (root instanceof ShadowRoot) {
      node = root.host;
    } else {
      const view = root.defaultView;
      if (!view || view === view.top) return { count: 1, roots };
      node = view.frameElement;
    }
  }
  // A cross-origin parent hides its `<iframe>` element: `frameElement` is null.
  return { count: 1 };
}

interface ActiveChainPlace {
  count: number;
  roots?: number;
}

/**
 * Whether the element `target` names is the element with focus that `focus` records. `elements`
 * are the ones Playwright finds for it, as the scenario's action found them, so they are the same.
 * That element has focus when it is the active element of its document or shadow root, and of
 * each one above it (`activeChainPlace`, in the page), and focus goes no deeper: the chain of
 * active elements the capture followed, through closed shadow roots and every frame, ends with
 * it, so has exactly as many links as it has roots up to the top page.
 */
export async function focusOnRequestedTarget(
  elements: TargetElements,
  target: RequestedTarget,
  focus: Pick<DomFocusState, "activeElementChain">
): Promise<RequestedTargetFocus> {
  const described = describeRequestedTarget(target);
  const unresolved = (reason: string, matchCount?: number): RequestedTargetFocus => ({
    ...target,
    status: "unresolved",
    ...(matchCount === undefined ? {} : { matchCount }),
    reason
  });
  let place: ActiveChainPlace;
  try {
    place = (await elements.evaluateAll(activeChainPlace)) as ActiveChainPlace;
  } catch (error) {
    return unresolved(
      `The page could not find the ${described}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`
    );
  }
  if (place.count === 0) {
    return unresolved(`The ${described} matches no element in the page.`, 0);
  }
  if (place.count > 1) {
    return unresolved(
      `The ${described} matches ${place.count} elements, so which one was requested cannot be told.`,
      place.count
    );
  }
  if (place.roots === undefined) {
    return unresolved(
      `The ${described} matches an element inside a cross-origin frame, whose place in the page cannot be read from inside it.`,
      1
    );
  }
  const focused = place.roots === focus.activeElementChain.length;
  return { ...target, status: focused ? "focused" : "not-focused", matchCount: 1 };
}

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
 * shadow roots, closed ones too), with each frame's tab stops at its `<iframe>` element's place in
 * its parent's order, as Chrome's Tab moves through them. Each frame is read through its own
 * session, so a cross-site frame in another process counts too. Undefined when any frame, or a
 * closed shadow root in one, could not be read or placed: one missing stop would shift every place
 * after it.
 */
async function pageTabOrder(
  page: PageSessions,
  documents: FrameDocuments
): Promise<PageTabOrder | undefined> {
  if (page.framesNotRead.length) return undefined;
  // Each process's DOM is walked for its closed roots at once, not one after another.
  const frameShadowRoots = await Promise.all(
    page.frames.map((frame) => documents.shadowRoots(frame))
  );
  if (frameShadowRoots.some((shadowRoots) => !shadowRoots)) return undefined;
  const sequences = new Map<string, { sequence: TabToken[]; children: PageFrame[] }>();
  for (const [index, frame] of page.frames.entries()) {
    const document = (await documents.document(frame))!;
    const shadowRoots = frameShadowRoots[index]!;
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
      [TABBABLE_SCRIPT.global, shadowRoots, ...owners]
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
 * frames, in tabbable's order. tabbable is given the document's shadow roots, closed ones included
 * (`ShadowRootsInPage`), so it enters every shadow root Chrome's Tab enters. Chrome's Tab goes into
 * a frame rather than stopping on its element, so an `<iframe>` tabbable lists (one with a
 * tabindex) stands for its frame. tabbable leaves out any other frame (its README: their
 * tabbability differs between browsers), so each is placed by the rule tabbable sorts by, read
 * from its source (`sortByOrder`): in each scope (the document, a shadow root, a slot), positive
 * tabindex first in ascending order, then tabindex 0, each in document order, and a scope's
 * content at its host's place. A frame whose element is hidden, inert (itself or through a shadow
 * host) or has a negative tabindex is left out, as Chrome's Tab skips it. Null when a frame's
 * element is not an `<iframe>`, since that rule cannot place it. Sent to the page as source, so it
 * uses nothing from outside itself.
 */
function documentTabSequence(
  this: Document,
  global: string,
  shadowRoots: ShadowRootsInPage,
  ...owners: Element[]
): TabToken[] | null {
  const { tabbable, isFocusable, getTabIndex } = (
    globalThis as unknown as Record<string, typeof Tabbable>
  )[global]!;
  if (owners.some((owner) => owner.localName !== "iframe")) return null;
  const stops: Element[] = tabbable(this.documentElement, shadowRoots);

  // The slot a host's light-DOM child is assigned to. `assignedSlot` names a slot only in an open
  // shadow root, so a closed root's slots are asked which elements they hold, as tabbable asks.
  const slotOf = (node: Element): Element | null => {
    if (node.assignedSlot) return node.assignedSlot;
    const root = node.parentElement && shadowRoots.getShadowRoot(node.parentElement);
    return root
      ? (Array.from(root.querySelectorAll("slot")).find((slot) =>
          slot.assignedElements().includes(node)
        ) ?? null)
      : null;
  };
  // Where tabbable sorts an element: inside each slot and shadow host it is reached through.
  const parentOf = (node: Element): Element | null =>
    slotOf(node) ??
    node.parentElement ??
    (node.parentNode instanceof ShadowRoot ? node.parentNode.host : null);
  const scopesOf = (node: Element) => {
    const scopes: Element[] = [];
    for (let parent = parentOf(node); parent; parent = parentOf(parent)) {
      if (parent.localName === "slot" || shadowRoots.getShadowRoot(parent)) scopes.unshift(parent);
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
    isFocusable(owner, shadowRoots) &&
    getTabIndex(owner) >= 0 &&
    !inert(owner) &&
    scopesOf(owner).every(
      (scope) => !shadowRoots.getShadowRoot(scope) || !hasTabIndex(scope) || getTabIndex(scope) >= 0
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
 * What the page itself shows of one element, run in the page on it: its tag, type and tab index,
 * whether its focus is visible, and its place among its document's tab stops, which is tabbable's,
 * given the document's shadow roots, when the tabbable script `tabbableGlobal` names is loaded.
 * Its role, name and states are the accessibility tree's, read outside the page. It is sent to the
 * page as source, as Playwright's own `evaluate` sends a function, so it uses nothing from outside
 * itself.
 */
function describeElement(
  this: Element,
  tabbableGlobal: string | null,
  shadowRoots: ShadowRootsInPage
): PageDescription {
  const tabStops: Element[] = tabbableGlobal
    ? (globalThis as unknown as Record<string, typeof Tabbable>)[tabbableGlobal]!.tabbable(
        this.ownerDocument.documentElement,
        shadowRoots
      )
    : [];
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
  const tabStop = tabStops.indexOf(this);
  return {
    tagName: this.tagName.toLowerCase(),
    id: this.id || undefined,
    type: typeof type === "string" && type ? type : undefined,
    tabIndex: typeof tabIndex === "number" ? tabIndex : undefined,
    disabled: typeof disabled === "boolean" ? disabled : undefined,
    focusVisible,
    focusIndicator: {
      visible: focusVisible && (outlineVisible || shadowVisible),
      outlineColor: style.outlineColor,
      outlineStyle: style.outlineStyle,
      outlineWidth: style.outlineWidth,
      boxShadow: style.boxShadow
    },
    tabStop: tabStop >= 0 ? tabStop : undefined
  };
}
