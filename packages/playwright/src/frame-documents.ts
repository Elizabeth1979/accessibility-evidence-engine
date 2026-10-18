import { readFileSync } from "node:fs";
import path from "node:path";

import type { CdpSession, PageFrame, PageSessions } from "./accessibility-tree";

/**
 * The frame's `document` as a protocol object, to run code on in the frame's own page. A frame at
 * the top of its process is its session's own page; a frame its parent's process renders is its
 * element's content document. Undefined when the frame has no document to read.
 */
export async function documentOf(
  page: PageSessions,
  frame: PageFrame
): Promise<string | undefined> {
  const parent = page.frames.find(({ frameId }) => frameId === frame.parentFrameId);
  if (!parent || parent.session !== frame.session) {
    const { result } = (await frame.session.send("Runtime.evaluate", {
      expression: "document"
    })) as { result: { objectId?: string } };
    return result.objectId;
  }
  if (frame.ownerBackendNodeId === undefined) return undefined;
  const { node } = (await frame.session.send("DOM.describeNode", {
    backendNodeId: frame.ownerBackendNodeId
  })) as { node: { contentDocument?: { backendNodeId: number } } };
  if (!node.contentDocument) return undefined;
  const { object } = (await frame.session.send("DOM.resolveNode", {
    backendNodeId: node.contentDocument.backendNodeId
  })) as { object: { objectId?: string } };
  return object.objectId;
}

/** An object in the page, such as an element, passed to a function `callOn` runs as itself. */
export class PageObject {
  constructor(readonly objectId: string) {}
}

/** Each argument as the protocol takes it: its value, or the page's own object for a `PageObject`. */
function callArguments(args: unknown[]) {
  return args.map((value) =>
    value instanceof PageObject ? { objectId: value.objectId } : { value }
  );
}

/**
 * Calls a function on a frame's `document` over the DevTools protocol, so it runs in that frame's
 * own page: the protocol call Playwright's own `evaluate` makes (`Runtime.callFunctionOn`). It runs
 * as the protocol's own code, so the page's Content-Security-Policy does not apply to it. Each
 * argument is sent as its value, or as the page's own object when it is a `PageObject`.
 */
export async function callOn<Value>(
  cdp: CdpSession,
  objectId: string,
  functionDeclaration: string,
  args: unknown[] = []
): Promise<Value> {
  const { result, exceptionDetails } = (await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: callArguments(args),
    awaitPromise: true,
    returnByValue: true
  })) as {
    result: { value?: Value };
    exceptionDetails?: { exception?: { description?: string }; text?: string };
  };
  if (exceptionDetails) {
    throw new Error(
      `Failed in the page: ${exceptionDetails.exception?.description ?? exceptionDetails.text}`
    );
  }
  return result.value as Value;
}

/** The object a function on the frame's `document` returns, kept in the page. */
async function objectOn(
  cdp: CdpSession,
  objectId: string,
  functionDeclaration: string,
  args: unknown[] = []
): Promise<PageObject | undefined> {
  const { result } = (await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration,
    arguments: callArguments(args)
  })) as { result: { objectId?: string } };
  return result.objectId === undefined ? undefined : new PageObject(result.objectId);
}

/** The DOM node a function on the frame's `document` returns, as the DOM snapshot numbers it. */
export async function nodeOf(
  cdp: CdpSession,
  objectId: string,
  functionDeclaration: string,
  args: unknown[] = []
): Promise<number | undefined> {
  const object = await objectOn(cdp, objectId, functionDeclaration, args);
  if (!object) return undefined;
  const { node } = (await cdp.send("DOM.describeNode", { objectId: object.objectId })) as {
    node: { backendNodeId: number };
  };
  return node.backendNodeId;
}

/**
 * An element's shadow root in the frame's own page, open or closed. It is tabbable's
 * `getShadowRoot` option as tabbable's README documents it for closed roots, a function that
 * returns the node's ShadowRoot, so this object is passed to tabbable as its options. A page
 * cannot reach a closed root itself, so the closed roots are read over the DevTools protocol and
 * handed to the page (`frameDocuments`).
 */
export interface ShadowRootsInPage {
  getShadowRoot(node: Element): ShadowRoot | undefined;
}

/** Made in the frame's page from its closed shadow roots. Sent as source, so it is self-contained. */
function shadowRootsInPage(this: Document, ...closedRoots: ShadowRoot[]): ShadowRootsInPage {
  const closed = new Map<Element, ShadowRoot>(closedRoots.map((root) => [root.host, root]));
  return { getShadowRoot: (node) => node.shadowRoot ?? closed.get(node) };
}

/** The protocol's DOM node, as `DOM.describeNode` gives it. */
interface ProtocolNode {
  backendNodeId: number;
  nodeType: number;
  /** The frame an `<iframe>` element holds. */
  frameId?: string;
  children?: ProtocolNode[];
  shadowRoots?: ProtocolNode[];
  shadowRootType?: string;
  contentDocument?: ProtocolNode;
}

/**
 * How many levels of the DOM one `DOM.describeNode` call reads. The protocol refuses a reply
 * nested deeper than its message format allows (measured: a reply 150 levels deep fails with
 * "CBOR: stack limit exceeded", 145 is read), so a deeper DOM is read on from where each call
 * stopped.
 */
const DESCRIBE_DEPTH = 100;

/**
 * The closed shadow roots in each document one process renders, by frame, as backend node ids:
 * the process's DOM walked from its top document through every shadow root and every frame it
 * renders itself (`DOM.describeNode` with `pierce`, the protocol's way into closed roots). Every
 * document it walked has an entry, an empty one when it has no closed root.
 */
async function closedShadowRootsByFrame(
  cdp: CdpSession,
  documentObjectId: string,
  frameId: string
): Promise<Map<string, number[]>> {
  const found = new Map<string, Set<number>>([[frameId, new Set()]]);
  const pending: Array<{ target: object; frameId: string }> = [
    { target: { objectId: documentObjectId }, frameId }
  ];
  while (pending.length) {
    const { target, frameId: frameOfTarget } = pending.pop()!;
    const { node } = (await cdp.send("DOM.describeNode", {
      ...target,
      depth: DESCRIBE_DEPTH,
      pierce: true
    })) as { node: ProtocolNode };
    const visit = (node: ProtocolNode, frameId: string, cutOff: boolean) => {
      if (node.shadowRootType === "closed") found.get(frameId)!.add(node.backendNodeId);
      // An element, document or shadow root the call stopped at comes without its children.
      if (cutOff && node.children === undefined && [1, 9, 11].includes(node.nodeType)) {
        pending.push({ target: { backendNodeId: node.backendNodeId }, frameId });
        return;
      }
      for (const child of [...(node.shadowRoots ?? []), ...(node.children ?? [])]) {
        visit(child, frameId, true);
      }
      if (node.contentDocument && node.frameId) {
        if (!found.has(node.frameId)) found.set(node.frameId, new Set());
        visit(node.contentDocument, node.frameId, true);
      }
    };
    visit(node, frameOfTarget, false);
  }
  return new Map([...found].map(([frameId, roots]) => [frameId, [...roots]]));
}

/** Each frame's document and its shadow roots, read once and kept for one look at the page. */
export interface FrameDocuments {
  document(frame: PageFrame): Promise<string | undefined>;
  /**
   * The frame's `ShadowRootsInPage`, as an object in its own page. Undefined when its document, or
   * a closed root in it, could not be read.
   */
  shadowRoots(frame: PageFrame): Promise<PageObject | undefined>;
}

/**
 * Reads each frame's document (`documentOf`) and its shadow roots when first asked, each process's
 * DOM walked once for the closed roots of every frame it renders.
 */
export function frameDocuments(page: PageSessions): FrameDocuments {
  const once = <Key, Value>(
    cache: Map<Key, Promise<Value>>,
    key: Key,
    read: () => Promise<Value>
  ) => {
    let value = cache.get(key);
    if (!value) {
      value = read();
      cache.set(key, value);
    }
    return value;
  };
  const documents = new Map<string, Promise<string | undefined>>();
  const walks = new Map<CdpSession, Promise<Map<string, number[]> | undefined>>();
  const roots = new Map<string, Promise<PageObject | undefined>>();
  const document = (frame: PageFrame) =>
    once(documents, frame.frameId, () => documentOf(page, frame));
  // The frame at the top of the session's process: its own page.
  const topOf = (session: CdpSession) =>
    page.frames.find(
      (frame) =>
        frame.session === session &&
        page.frames.find(({ frameId }) => frameId === frame.parentFrameId)?.session !== session
    )!;
  const walk = (session: CdpSession) =>
    once(walks, session, async () => {
      const top = topOf(session);
      const topDocument = await document(top);
      return topDocument === undefined
        ? undefined
        : closedShadowRootsByFrame(session, topDocument, top.frameId);
    });
  return {
    document,
    shadowRoots: (frame) =>
      once(roots, frame.frameId, async () => {
        const frameDocument = await document(frame);
        const closedIds = (await walk(frame.session))?.get(frame.frameId);
        if (!frameDocument || !closedIds) return undefined;
        const resolved = await Promise.all(
          closedIds.map(
            async (backendNodeId) =>
              (
                (await frame.session.send("DOM.resolveNode", { backendNodeId })) as {
                  object: { objectId?: string };
                }
              ).object.objectId
          )
        );
        if (resolved.some((objectId) => objectId === undefined)) return undefined;
        const closedRoots = resolved.map((objectId) => new PageObject(objectId!));
        return objectOn(frame.session, frameDocument, `${shadowRootsInPage}`, closedRoots);
      })
  };
}

/** A library built as a plain script (`scripts/build-page-scripts.mjs`), and the global it sets. */
export interface PageScript {
  /** Its file next to this module in `dist`. */
  file: string;
  global: string;
}

export const GUIDEPUP_SCRIPT: PageScript = {
  file: "guidepup-virtual-screen-reader.js",
  global: "__aeeGuidepupVirtualScreenReader"
};

export const TABBABLE_SCRIPT: PageScript = { file: "tabbable.js", global: "__aeeTabbable" };

const scriptSources = new Map<string, string>();

/**
 * Loads a page script into a frame's own page through its `document`, once: a page it is already
 * in keeps it. It is evaluated over the DevTools protocol, as `@axe-core/playwright` loads axe, so
 * the page's Content-Security-Policy does not refuse it.
 */
export async function loadPageScript(
  cdp: CdpSession,
  documentObjectId: string,
  { file, global }: PageScript
): Promise<void> {
  const loaded = await callOn<boolean>(
    cdp,
    documentObjectId,
    `function () { return typeof globalThis.${global} === "object"; }`
  );
  if (loaded) return;
  let source = scriptSources.get(file);
  if (source === undefined) {
    source = readFileSync(path.join(__dirname, file), "utf8");
    scriptSources.set(file, source);
  }
  // The script declares its global with `var`, which a function body keeps to itself.
  await callOn(
    cdp,
    documentObjectId,
    `function () {\n${source}\nglobalThis.${global} = ${global};\n}`
  );
}
