/** A Chrome DevTools Protocol session, as Playwright's `CDPSession` provides it. */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach?(): Promise<void>;
}

export interface CdpContext {
  newCDPSession(page: unknown): Promise<CdpSession>;
}

export interface AccessibilityValue {
  type: string;
  value?: unknown;
}

/** One node of the browser's accessibility tree (CDP `Accessibility.AXNode`). */
export interface AccessibilityNode {
  nodeId: string;
  ignored: boolean;
  /** `type` is `role` for an ARIA role and `internalRole` for Chromium's own names. */
  role?: AccessibilityValue;
  name?: AccessibilityValue;
  properties?: Array<{ name: string; value: AccessibilityValue }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface AccessibilityTree {
  nodes: AccessibilityNode[];
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

/**
 * The page's full accessibility tree as the browser computes it: roles, names and states follow
 * the W3C mappings (HTML-AAM, accname) the browser implements. Every part of the engine that needs
 * them reads this tree rather than inferring them from the DOM.
 */
export async function fetchAccessibilityTree(session: CdpSession): Promise<AccessibilityTree> {
  return (await session.send("Accessibility.getFullAXTree")) as AccessibilityTree;
}
