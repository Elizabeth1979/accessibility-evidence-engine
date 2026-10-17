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

/**
 * Calls a function on a frame's `document` over the DevTools protocol, so it runs in that frame's
 * own page: the protocol call Playwright's own `evaluate` makes (`Runtime.callFunctionOn`). It runs
 * as the protocol's own code, so the page's Content-Security-Policy does not apply to it.
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
    arguments: args.map((value) => ({ value })),
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

/** The DOM node a function on the frame's `document` returns, as the DOM snapshot numbers it. */
export async function nodeOf(
  cdp: CdpSession,
  objectId: string,
  functionDeclaration: string
): Promise<number | undefined> {
  const { result } = (await cdp.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration
  })) as { result: { objectId?: string } };
  if (!result.objectId) return undefined;
  const { node } = (await cdp.send("DOM.describeNode", { objectId: result.objectId })) as {
    node: { backendNodeId: number };
  };
  return node.backendNodeId;
}
