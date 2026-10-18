import { redactUrl } from "@aee/core";

/** A Chrome DevTools Protocol session, as Playwright's `CDPSession` provides it. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach?(): Promise<void>;
}

export interface CdpContext {
  /**
   * A session on a page, or on a frame Chrome renders in a process of its own (Playwright's
   * `newCDPSession`, which takes a `Page` or a `Frame`).
   */
  newCDPSession(target: unknown): Promise<CdpSession>;
}

/** A frame as Playwright's `Frame` gives it. */
export interface PlaywrightFrameLike {
  url(): string;
}

/** A page whose frames can be listed, as Playwright's `Page` does. */
export interface FramedPage {
  mainFrame(): PlaywrightFrameLike;
  frames(): PlaywrightFrameLike[];
}

/** A value in the browser's accessibility tree (CDP `Accessibility.AXValue`). */
export interface AccessibilityValue {
  type: string;
  value?: unknown;
  /** The elements a relation such as `labelledby` or `controls` points to, with their text. */
  relatedNodes?: Array<{ backendDOMNodeId: number; idref?: string; text?: string }>;
}

/**
 * One state or property of a node (CDP `Accessibility.AXProperty`), such as `expanded`,
 * `invalid`, `hasPopup` or `describedby`.
 */
export interface AccessibilityProperty {
  name: string;
  value: AccessibilityValue;
}

/** One node of the browser's accessibility tree (CDP `Accessibility.AXNode`). */
export interface AccessibilityNode {
  nodeId: string;
  ignored: boolean;
  /** Why an ignored node is left out, such as `notRendered` or `emptyAlt`. */
  ignoredReasons?: AccessibilityProperty[];
  /** `type` is `role` for an ARIA role and `internalRole` for Chromium's own names. */
  role?: AccessibilityValue;
  name?: AccessibilityValue;
  /** The accessible description, such as from `aria-describedby` or `title`. */
  description?: AccessibilityValue;
  /** The value, such as a text field's text or a slider's position. */
  value?: AccessibilityValue;
  properties?: AccessibilityProperty[];
  childIds?: string[];
  /** Set on the nodes a partial tree returns, so its ancestors can be walked. */
  parentId?: string;
  backendDOMNodeId?: number;
  /**
   * The frame whose document holds the node. Chrome sets it on a frame's root node only; AEE sets
   * it on every node, because node ids repeat across frames rendered in different processes.
   */
  frameId?: string;
}

/** A DOM node, named by the frame whose document holds it and the id its process gives it. */
export interface DomNodeRef {
  frameId: string;
  backendNodeId: number;
}

/** One frame of the page: a document of its own (CDP `Page.Frame`). */
export interface FrameRecord {
  frameId: string;
  /** The frame that holds it; absent for the top document. */
  parentFrameId?: string;
  /** Its address. In evidence, with no credentials, query values or fragment. */
  url: string;
  /** The `<iframe>` or `<frame>` element that holds it, as its parent frame's process numbers it. */
  ownerBackendNodeId?: number;
}

/** The address Chrome gives the error page it shows in place of a page that did not load. */
export const CHROME_ERROR_PAGE = "chrome-error://chromewebdata/";

/** A frame that was not read, and why: no session could read it, or it was left out. */
export interface UnreadFrame {
  url: string;
  reason: string;
}

export interface AccessibilityTree {
  /** Every frame's nodes, frame by frame in `frames` order, each in Chrome's own order. */
  nodes: AccessibilityNode[];
  /** Every frame read, the top document first and each frame after the frame that holds it. */
  frames?: FrameRecord[];
  framesNotRead?: UnreadFrame[];
}

/** One frame and the session of the process that renders it. */
export interface PageFrame extends FrameRecord {
  session: CdpSession;
}

/** Every frame of a page, each with a session that reads it. */
export interface PageSessions {
  /** The top document first, and each frame after the frame that holds it. */
  frames: PageFrame[];
  framesNotRead: UnreadFrame[];
}

/** The page's top document. */
export function mainFrameOf(page: PageSessions): PageFrame {
  return page.frames[0]!;
}

/** The DOM node an accessibility node belongs to, when it belongs to one. */
export function domNodeOf(node: AccessibilityNode): DomNodeRef | undefined {
  return node.backendDOMNodeId === undefined || node.frameId === undefined
    ? undefined
    : { frameId: node.frameId, backendNodeId: node.backendDOMNodeId };
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

interface CdpFrameTree {
  frame: { id: string; parentId?: string; url: string; urlFragment?: string };
  childFrames?: CdpFrameTree[];
}

/**
 * Opens a session on the page and one on each frame Chrome renders in a process of its own (an
 * out-of-process iframe, as site isolation makes a cross-site frame), lists every frame each
 * session renders (`Page.getFrameTree`) and finds the element that holds each frame
 * (`DOM.getFrameOwner`, asked of the parent frame's session, as Puppeteer's `frameElement` does).
 * Runs `use` with them and always detaches every session.
 */
export async function withPageSessions<Result>(
  context: CdpContext,
  page: FramedPage,
  use: (page: PageSessions) => Promise<Result>
): Promise<Result> {
  const opened: CdpSession[] = [];
  try {
    opened.push(await context.newCDPSession(page));
    // Playwright gives a frame its own session only when Chrome renders it in another process;
    // for any other frame it refuses, and the frame is read through the session that renders it.
    const refused: UnreadFrame[] = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        opened.push(await context.newCDPSession(frame));
      } catch (error) {
        refused.push({ url: frame.url(), reason: errorMessage(error) });
      }
    }
    const trees = await Promise.all(
      opened.map(async (session) => ({
        session,
        tree: ((await session.send("Page.getFrameTree")) as { frameTree: CdpFrameTree }).frameTree
      }))
    );
    const frames: PageFrame[] = [];
    const addTree = (session: CdpSession, tree: CdpFrameTree) => {
      const { id, parentId, url, urlFragment } = tree.frame;
      frames.push({
        frameId: id,
        ...(parentId ? { parentFrameId: parentId } : {}),
        url: url + (urlFragment ?? ""),
        session
      });
      for (const child of tree.childFrames ?? []) addTree(session, child);
    };
    // The page's own frames first, then each other process's frames once the frame holding them
    // is in, so a frame's parent always comes before it.
    const [main, ...others] = trees;
    addTree(main!.session, main!.tree);
    while (others.length) {
      const ready = others.findIndex(({ tree }) =>
        frames.some(({ frameId }) => frameId === tree.frame.parentId)
      );
      const [{ session, tree }] = others.splice(Math.max(ready, 0), 1) as [(typeof trees)[number]];
      addTree(session, tree);
    }
    const byId = new Map(frames.map((frame) => [frame.frameId, frame]));
    await Promise.all(
      frames.map(async (frame) => {
        const parent = frame.parentFrameId ? byId.get(frame.parentFrameId) : undefined;
        if (!parent) return;
        const { backendNodeId } = (await parent.session.send("DOM.getFrameOwner", {
          frameId: frame.frameId
        })) as { backendNodeId: number };
        frame.ownerBackendNodeId = backendNodeId;
      })
    );
    // Each refused frame should be one its parent's process renders; any that none does could not
    // be read at all, and is listed with Playwright's reason.
    const sessionRoots = new Set(trees.map(({ tree }) => tree.frame.id));
    const renderedWithParent = frames
      .filter(({ frameId, parentFrameId }) => parentFrameId && !sessionRoots.has(frameId))
      .map(({ url }) => url);
    const framesNotRead = refused.filter(({ url }) => {
      const at = renderedWithParent.indexOf(url);
      if (at !== -1) renderedWithParent.splice(at, 1);
      return at === -1;
    });
    return await use({ frames, framesNotRead });
  } finally {
    await Promise.all(opened.map((session) => session.detach?.()));
  }
}

/**
 * The page's frames that show a document from one of `allowedOrigins`, so a lane reads nothing
 * from another site. A frame a redirect took to another site, or one showing Chrome's error page
 * for a load that failed or was stopped, is left out, with every frame inside it, and listed in
 * `framesNotRead` with why, so the evidence says its content was not checked. A frame showing a
 * document its parent wrote (`about:blank`, `about:srcdoc`, a `data:` address) has no origin of
 * its own address, so it goes with its parent. The top document is kept: its lane checks it.
 */
export function framesInsideOrigins(page: PageSessions, allowedOrigins: string[]): PageSessions {
  const kept = new Set<string>();
  const framesNotRead = [...page.framesNotRead];
  const frames = page.frames.filter(({ frameId, parentFrameId, url }) => {
    const reason = !parentFrameId
      ? undefined
      : !kept.has(parentFrameId)
        ? "It is inside a frame that was not read."
        : url === CHROME_ERROR_PAGE
          ? "It shows Chrome's error page: its page did not load, or was stopped."
          : /^(about|data):/.test(url) || allowedOrigins.includes(new URL(url).origin)
            ? undefined
            : `It shows a page from ${new URL(url).origin}, which is not an allowed origin; add it to them to check this frame.`;
    if (reason) {
      framesNotRead.push({ url, reason });
      return false;
    }
    kept.add(frameId);
    return true;
  });
  return { frames, framesNotRead };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A frame as evidence: its address keeps no credentials, query values or fragment. */
function frameRecord({ frameId, parentFrameId, url, ownerBackendNodeId }: PageFrame): FrameRecord {
  return {
    frameId,
    ...(parentFrameId ? { parentFrameId } : {}),
    url: redactUrl(url),
    ...(ownerBackendNodeId === undefined ? {} : { ownerBackendNodeId })
  };
}

/**
 * The full accessibility tree of every frame as the browser computes it
 * (`Accessibility.getFullAXTree` for each frame id): roles, names and states follow the W3C
 * mappings (HTML-AAM, accname) the browser implements. Every part of the engine that needs them
 * reads this tree rather than inferring them from the DOM.
 */
export async function fetchAccessibilityTree(page: PageSessions): Promise<AccessibilityTree> {
  const trees = await Promise.all(
    page.frames.map(async ({ frameId, session }) => {
      const { nodes } = (await session.send("Accessibility.getFullAXTree", {
        frameId
      })) as AccessibilityTree;
      return nodes.map((node) => ({ ...node, frameId }));
    })
  );
  return {
    nodes: trees.flat(),
    frames: page.frames.map(frameRecord),
    ...(page.framesNotRead.length
      ? {
          framesNotRead: page.framesNotRead.map(({ url, reason }) => ({
            url: redactUrl(url),
            reason
          }))
        }
      : {})
  };
}

/** What the accessibility tree gives a screen reader for one element. */
export interface AccessibleElement {
  role: string;
  name: string;
  /** Why the tree leaves it out, such as `emptyAlt` or `ariaHiddenSubtree`; empty when it is exposed. */
  ignoredReasons: string[];
  /** Its states and other properties by name, such as `checked`, `selected` or `modal`. */
  properties: Record<string, unknown>;
  /** Joins it to its node in the full tree and in a DOM snapshot. */
  backendNodeId?: number;
}

/** An accessibility node as the role, name, ignored reasons and properties it gives a screen reader. */
export function accessibleElementOf(node: AccessibilityNode): AccessibleElement {
  return {
    role: String(node.role?.value ?? ""),
    name: typeof node.name?.value === "string" ? node.name.value : "",
    ignoredReasons: node.ignored ? (node.ignoredReasons ?? []).map(({ name }) => name) : [],
    properties: Object.fromEntries(
      (node.properties ?? []).map(({ name, value }) => [name, value.value])
    ),
    ...(node.backendDOMNodeId === undefined ? {} : { backendNodeId: node.backendDOMNodeId })
  };
}

/**
 * The browser's accessibility node for one DOM node. Unlike the full tree, which leaves out some
 * ignored nodes (an `alt=""` image in a paragraph), this always answers, with Chrome's reasons
 * when the node is ignored.
 */
export async function fetchAccessibilityNode(
  page: PageSessions,
  { frameId, backendNodeId }: DomNodeRef
): Promise<AccessibilityNode | undefined> {
  const frame = page.frames.find((candidate) => candidate.frameId === frameId);
  if (!frame) return undefined;
  const { nodes } = (await frame.session.send("Accessibility.getPartialAXTree", {
    backendNodeId,
    fetchRelatives: false
  })) as AccessibilityTree;
  const node = nodes.find((candidate) => candidate.backendDOMNodeId === backendNodeId) ?? nodes[0];
  return node && { ...node, frameId };
}

/**
 * The focused element as the accessibility tree has it, which is what a screen reader announces
 * when focus arrives. Nothing when focus is on no element.
 */
export function describeFocusedElement(
  session: CdpSession
): Promise<AccessibleElement | undefined> {
  return describeEvaluatedElement(session, "document.activeElement");
}

/**
 * The first element a CSS selector matches, as the accessibility tree has it. Nothing when no
 * element matches.
 */
export function describeSelectedElement(
  session: CdpSession,
  selector: string
): Promise<AccessibleElement | undefined> {
  return describeEvaluatedElement(session, `document.querySelector(${JSON.stringify(selector)})`);
}

async function describeEvaluatedElement(
  session: CdpSession,
  expression: string
): Promise<AccessibleElement | undefined> {
  const { result } = (await session.send("Runtime.evaluate", { expression })) as {
    result: { objectId?: string };
  };
  if (!result.objectId) return undefined;
  try {
    const { nodes } = (await session.send("Accessibility.getPartialAXTree", {
      objectId: result.objectId,
      fetchRelatives: false
    })) as AccessibilityTree;
    return nodes[0] && accessibleElementOf(nodes[0]);
  } finally {
    await session.send("Runtime.releaseObject", { objectId: result.objectId });
  }
}

/** An element as one CDP DOM snapshot records it. */
export interface CapturedElement {
  tagName: string;
  /** Its id, or up to eight tag steps with their position among same-tag siblings, in its document. */
  nodePath: string;
  /** The frame whose document holds it. */
  frameId: string;
  /**
   * The `<iframe>` elements it is inside, outermost first, each as a path in the document that
   * holds it, the way axe-core's `target` lists a node inside frames. Empty in the top document.
   */
  framePath: string[];
  backendNodeId: number;
  attribute(name: string): string | undefined;
  /** The computed styles the snapshot was asked for, by property name. */
  style: Record<string, string>;
  /** Its box on the page, when it has an area: what a sighted user can see. */
  visualBounds?: { x: number; y: number; width: number; height: number };
  /** Its box on the page whenever it is laid out, even with no area, as an empty heading has. */
  layoutBounds?: { x: number; y: number; width: number; height: number };
  /** Its place in the page's document order, with each frame's document where its element is. */
  order: number;
}

export interface CapturedDom {
  element(node: DomNodeRef): CapturedElement | undefined;
  /** The node itself when it is an element, else its parent element (for a text node). */
  closestElement(node: DomNodeRef): CapturedElement | undefined;
  /** The closest element and each element above it in its document, nearest first. */
  ancestorElements(node: DomNodeRef): CapturedElement[];
  /** The elements with this tag in every frame, in the page's document order. */
  elements(tagName: string): DomNodeRef[];
}

interface DomSnapshotDocument {
  frameId: number;
  scrollOffsetX?: number;
  scrollOffsetY?: number;
  nodes: {
    parentIndex: number[];
    nodeType: number[];
    nodeName: number[];
    backendNodeId: number[];
    attributes: number[][];
    /** Each frame-owner element's node index, and the index of the document it holds. */
    contentDocumentIndex?: { index: number[]; value: number[] };
  };
  layout: {
    nodeIndex: number[];
    bounds: number[][];
    styles?: number[][];
    /** Each box's client rect: its border widths as the offset, and its inner size. */
    clientRects?: number[][];
  };
}

interface DomSnapshot {
  strings: string[];
  documents: DomSnapshotDocument[];
}

type Box = { x: number; y: number; width: number; height: number };

/** One frame's document as its process's snapshot records it. */
interface FrameDocument {
  frameId: string;
  nodeCount: number;
  indexOf(backendNodeId: number): number | undefined;
  parentOf(index: number): number;
  isElement(index: number): boolean;
  tagName(index: number): string;
  nodePath(index: number): string;
  backendNodeId(index: number): number;
  attribute(index: number, name: string): string | undefined;
  style(index: number, name: string): string;
  /** Its box in the coordinates of its own document. */
  box(index: number): Box | undefined;
  /** Where the content box starts inside the border box: the border and the padding. */
  contentOffset(index: number): { x: number; y: number } | undefined;
  scrollOffset: { x: number; y: number };
}

/** The padding of each frame's element, which places the frame's document on the page. */
const FRAME_OFFSET_STYLES = ["padding-left", "padding-top"];

/**
 * One CDP snapshot of every frame's DOM (`DOMSnapshot.captureSnapshot` in each process that
 * renders a frame): every element's tag, attributes, place in the tree, layout box and the
 * computed styles asked for. A frame in the same process is joined to its `<iframe>` element by
 * the snapshot's own `contentDocumentIndex`; one in another process, by the element
 * `DOM.getFrameOwner` names. Boxes are in the top document's coordinates, the full-page
 * screenshot's. Joined to the accessibility tree by frame and backend node id.
 */
export async function capturePageDom(
  page: PageSessions,
  computedStyles: string[] = []
): Promise<CapturedDom> {
  const requested = [...new Set([...computedStyles, ...FRAME_OFFSET_STYLES])];
  const sessions = [...new Set(page.frames.map(({ session }) => session))];
  const snapshots = await Promise.all(
    sessions.map(
      async (session) =>
        (await session.send("DOMSnapshot.captureSnapshot", {
          computedStyles: requested,
          includeDOMRects: true
        })) as DomSnapshot
    )
  );
  const documents = new Map<string, FrameDocument>();
  /** Each frame's element: the frame holding it and the element's node index there. */
  const owners = new Map<string, { frameId: string; index: number }>();
  for (const { strings, documents: snapshotDocuments } of snapshots) {
    for (const document of snapshotDocuments) {
      const frameId = strings[document.frameId]!;
      documents.set(frameId, frameDocument(frameId, strings, document, requested));
      const { index = [], value = [] } = document.nodes.contentDocumentIndex ?? {};
      index.forEach((owner, at) => {
        const held = snapshotDocuments[value[at]!];
        if (held) owners.set(strings[held.frameId]!, { frameId, index: owner });
      });
    }
  }
  for (const { frameId, parentFrameId, ownerBackendNodeId } of page.frames) {
    if (owners.has(frameId) || !parentFrameId || ownerBackendNodeId === undefined) continue;
    const index = documents.get(parentFrameId)?.indexOf(ownerBackendNodeId);
    if (index !== undefined) owners.set(frameId, { frameId: parentFrameId, index });
  }

  // Where each frame's document starts on the page, and the elements it is inside. A frame whose
  // element is not laid out is not drawn, so its elements get no box.
  const placement = new Map<string, { origin?: { x: number; y: number }; framePath: string[] }>();
  for (const { frameId } of page.frames) {
    const owner = owners.get(frameId);
    const parent = owner && placement.get(owner.frameId);
    const holder = owner && documents.get(owner.frameId);
    if (!owner || !parent || !holder) {
      placement.set(frameId, { origin: { x: 0, y: 0 }, framePath: [] });
      continue;
    }
    const box = holder.box(owner.index);
    const inset = holder.contentOffset(owner.index);
    const scroll = documents.get(frameId)?.scrollOffset ?? { x: 0, y: 0 };
    placement.set(frameId, {
      ...(parent.origin && box && inset
        ? {
            origin: {
              x: parent.origin.x + box.x + inset.x - scroll.x,
              y: parent.origin.y + box.y + inset.y - scroll.y
            }
          }
        : {}),
      framePath: [...parent.framePath, holder.nodePath(owner.index)]
    });
  }

  // The page's document order: each frame's document is read where its element is.
  const order = new Map<string, number[]>();
  const heldAt = new Map<string, string[]>();
  for (const [frameId, owner] of owners) {
    const key = `${owner.frameId}\u0000${owner.index}`;
    heldAt.set(key, [...(heldAt.get(key) ?? []), frameId]);
  }
  let position = 0;
  const visit = (frameId: string) => {
    const document = documents.get(frameId);
    if (!document || order.has(frameId)) return;
    const places: number[] = [];
    order.set(frameId, places);
    for (let index = 0; index < document.nodeCount; index++) {
      places[index] = position++;
      for (const held of heldAt.get(`${frameId}\u0000${index}`) ?? []) visit(held);
    }
  };
  for (const { frameId } of page.frames) visit(frameId);

  const captured = new Map<string, CapturedElement>();
  const capture = (document: FrameDocument, index: number): CapturedElement => {
    const key = `${document.frameId}\u0000${index}`;
    const known = captured.get(key);
    if (known) return known;
    const { origin, framePath } = placement.get(document.frameId) ?? { framePath: [] };
    const box = document.box(index);
    const onPage = box && origin && { ...box, x: origin.x + box.x, y: origin.y + box.y };
    const element: CapturedElement = {
      tagName: document.tagName(index),
      nodePath: document.nodePath(index),
      frameId: document.frameId,
      framePath,
      backendNodeId: document.backendNodeId(index),
      order: order.get(document.frameId)?.[index] ?? -1,
      attribute: (name) => document.attribute(index, name),
      style: Object.fromEntries(computedStyles.map((name) => [name, document.style(index, name)])),
      ...(onPage ? { layoutBounds: onPage } : {}),
      ...(onPage && onPage.width > 0 && onPage.height > 0 ? { visualBounds: onPage } : {})
    };
    captured.set(key, element);
    return element;
  };
  const ancestorElements = ({ frameId, backendNodeId }: DomNodeRef) => {
    const document = documents.get(frameId);
    const found: CapturedElement[] = [];
    if (!document) return found;
    for (
      let index = document.indexOf(backendNodeId);
      index !== undefined && index >= 0;
      index = document.parentOf(index)
    ) {
      if (document.isElement(index)) found.push(capture(document, index));
    }
    return found;
  };

  return {
    element({ frameId, backendNodeId }) {
      const document = documents.get(frameId);
      const index = document?.indexOf(backendNodeId);
      return document && index !== undefined && document.isElement(index)
        ? capture(document, index)
        : undefined;
    },
    closestElement: (node) => ancestorElements(node)[0],
    ancestorElements,
    elements: (wanted) =>
      [...documents.values()]
        .flatMap((document) =>
          Array.from({ length: document.nodeCount }, (_, index) => index)
            .filter((index) => document.isElement(index) && document.tagName(index) === wanted)
            .map((index) => ({
              ref: { frameId: document.frameId, backendNodeId: document.backendNodeId(index) },
              at: order.get(document.frameId)?.[index] ?? -1
            }))
        )
        .sort((left, right) => left.at - right.at)
        .map(({ ref }) => ref)
  };
}

function frameDocument(
  frameId: string,
  strings: string[],
  { nodes, layout, scrollOffsetX = 0, scrollOffsetY = 0 }: DomSnapshotDocument,
  requested: string[]
): FrameDocument {
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
  const style = (index: number, name: string) => {
    const box = layoutIndex.get(index);
    const styles = box === undefined ? [] : (layout.styles?.[box] ?? []);
    return strings[styles[requested.indexOf(name)] ?? -1] ?? "";
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
  return {
    frameId,
    nodeCount: nodes.backendNodeId.length,
    indexOf: (backendNodeId) => indexByBackendId.get(backendNodeId),
    parentOf: (index) => nodes.parentIndex[index]!,
    isElement,
    tagName,
    nodePath,
    backendNodeId: (index) => nodes.backendNodeId[index]!,
    attribute,
    style,
    box(index) {
      const box = layoutIndex.get(index);
      if (box === undefined) return undefined;
      const [x = 0, y = 0, width = 0, height = 0] = layout.bounds[box]!;
      return { x, y, width, height };
    },
    contentOffset(index) {
      const box = layoutIndex.get(index);
      const [borderLeft = 0, borderTop = 0] =
        box === undefined ? [] : (layout.clientRects?.[box] ?? []);
      if (box === undefined) return undefined;
      return {
        x: borderLeft + (Number.parseFloat(style(index, "padding-left")) || 0),
        y: borderTop + (Number.parseFloat(style(index, "padding-top")) || 0)
      };
    },
    scrollOffset: { x: scrollOffsetX, y: scrollOffsetY }
  };
}
