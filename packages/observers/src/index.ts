import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ArtifactKind, EvidenceRecord, ObserverContext, ObserverPlugin } from "@aee/core";

export const defaultObserverManifests = [
  {
    id: "dom",
    displayName: "DOM Observer",
    version: "0.1.0",
    kind: "observer" as const,
    capabilities: ["dom-snapshot", "change-detection"]
  },
  {
    id: "accessibility-tree",
    displayName: "Accessibility Tree Observer",
    version: "0.1.0",
    kind: "observer" as const,
    capabilities: ["accessibility-tree", "change-detection"]
  },
  {
    id: "focus",
    displayName: "Focus Observer",
    version: "0.1.0",
    kind: "observer" as const,
    capabilities: ["focus-state", "target-tracking"]
  },
  {
    id: "visual",
    displayName: "Visual Observer",
    version: "0.1.0",
    kind: "observer" as const,
    capabilities: ["screenshot", "visual-diff"]
  },
  {
    id: "network",
    displayName: "Network Observer",
    version: "0.1.0",
    kind: "observer" as const,
    capabilities: ["network-log"]
  },
  {
    id: "guidepup-screen-reader",
    displayName: "Guidepup Screen Reader Observer",
    version: "0.1.0",
    kind: "observer" as const,
    capabilities: ["screen-reader-log", "announcements"]
  },
  {
    id: "axe",
    displayName: "axe Observer",
    version: "0.1.0",
    kind: "observer" as const,
    capabilities: ["rule-scan", "axe-results"]
  }
];

export interface RuntimeObserverContext extends ObserverContext {
  page?: {
    content(): Promise<string>;
    snapshotAccessibilityTree?(options?: unknown): Promise<unknown>;
    snapshotFocusTarget?(options?: unknown): Promise<unknown>;
    snapshotScreenshot?(options?: unknown): Promise<Uint8Array>;
    setupNetworkTracking?(options?: unknown): Promise<void>;
    snapshotNetworkLog?(options?: unknown): Promise<unknown>;
    teardownNetworkTracking?(options?: unknown): Promise<void>;
    accessibility?: {
      snapshot(options?: unknown): Promise<unknown>;
    };
  };
  artifactDir?: string;
  captureLabel?: string;
  runtimeState?: {
    domBeforeHtml?: string;
    networkBeforeSummary?: NetworkLogSummary;
  };
}

interface NetworkEventRecord {
  kind: "request" | "response";
  url: string;
  method?: string;
  status?: number;
  ok?: boolean;
  resourceType?: string;
  timestamp?: string;
  requestId?: number;
  noise: boolean;
}

interface NetworkLogSummary {
  events: NetworkEventRecord[];
  eventCount: number;
  interestingEventCount: number;
  filteredNoiseCount: number;
  requestCount: number;
  responseCount: number;
  matchedResponseCount: number;
  unmatchedRequestCount: number;
  unmatchedResponseCount: number;
  interestingUrls: string[];
}

export function createDomObserver(): ObserverPlugin {
  return {
    manifest: defaultObserverManifests[0],
    async captureBefore(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [await captureDomRecord(context as RuntimeObserverContext, "before")];
    },
    async captureAfter(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [await captureDomRecord(context as RuntimeObserverContext, "after")];
    }
  };
}

export function createAccessibilityTreeObserver(): ObserverPlugin {
  return {
    manifest: defaultObserverManifests[1],
    async captureBefore(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [await captureAccessibilityRecord(context as RuntimeObserverContext, "before")];
    },
    async captureAfter(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [await captureAccessibilityRecord(context as RuntimeObserverContext, "after")];
    }
  };
}

export function createFocusObserver(): ObserverPlugin {
  return {
    manifest: defaultObserverManifests[2],
    async captureBefore(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [await captureFocusRecord(context as RuntimeObserverContext, "before")];
    },
    async captureAfter(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [await captureFocusRecord(context as RuntimeObserverContext, "after")];
    }
  };
}

export function createVisualObserver(): ObserverPlugin {
  return {
    manifest: defaultObserverManifests[3],
    async captureBefore(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [await captureVisualRecord(context as RuntimeObserverContext, "before")];
    },
    async captureAfter(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [await captureVisualRecord(context as RuntimeObserverContext, "after")];
    }
  };
}

export function createNetworkObserver(): ObserverPlugin {
  return {
    manifest: defaultObserverManifests[4],
    async setup(context: ObserverContext): Promise<void> {
      await setupNetworkTracking(context as RuntimeObserverContext);
    },
    async captureBefore(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [await captureNetworkRecord(context as RuntimeObserverContext, "before")];
    },
    async captureAfter(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [await captureNetworkRecord(context as RuntimeObserverContext, "after")];
    },
    async teardown(context: ObserverContext): Promise<void> {
      await teardownNetworkTracking(context as RuntimeObserverContext);
    }
  };
}

export function createUnsupportedObserver(observerId: string): ObserverPlugin {
  const manifest = defaultObserverManifests.find((candidate) => candidate.id === observerId);

  if (!manifest) {
    throw new Error(`Unknown observer manifest: ${observerId}`);
  }

  return {
    manifest,
    async captureBefore(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [unsupportedRecord(context, observerId, "before")];
    },
    async captureAfter(context: ObserverContext): Promise<EvidenceRecord[]> {
      return [unsupportedRecord(context, observerId, "after")];
    }
  };
}

export function createDefaultObserverPlugins(observerIds: string[] = ["dom", "accessibility-tree"]): ObserverPlugin[] {
  return observerIds.map((observerId) => {
    if (observerId === "dom") {
      return createDomObserver();
    }

    if (observerId === "accessibility-tree") {
      return createAccessibilityTreeObserver();
    }

    if (observerId === "focus") {
      return createFocusObserver();
    }

    if (observerId === "visual") {
      return createVisualObserver();
    }

    if (observerId === "network") {
      return createNetworkObserver();
    }

    return createUnsupportedObserver(observerId);
  });
}

function getTimestamp(): string {
  return new Date().toISOString();
}

async function captureDomRecord(
  context: RuntimeObserverContext,
  phase: "before" | "after"
): Promise<EvidenceRecord> {
  if (!context.page) {
    return {
      id: `dom:${phase}:${Date.now()}`,
      runId: context.runId,
      checkpointId: context.checkpointId,
      interactionId: context.interactionId,
      observerId: "dom",
      observerVersion: "0.1.0",
      phase,
      status: "observer_error",
      timestamp: getTimestamp(),
      diagnostics: ["Missing page in observer context."]
    };
  }

  const html = await context.page.content();
  const byteLength = Buffer.byteLength(html, "utf8");
  const previousHtml = phase === "after" ? context.runtimeState?.domBeforeHtml : undefined;
  const changed = previousHtml !== undefined ? previousHtml !== html : undefined;
  const previousByteLength = previousHtml !== undefined ? Buffer.byteLength(previousHtml, "utf8") : undefined;
  const artifact = await maybeWriteArtifact(
    context,
    "dom",
    phase,
    "dom-snapshot",
    "html",
    "text/html",
    html
  );

  if (phase === "before") {
    context.runtimeState = {
      ...(context.runtimeState ?? {}),
      domBeforeHtml: html
    };
  }

  return {
    id: `dom:${phase}:${Date.now()}`,
    runId: context.runId,
    checkpointId: context.checkpointId,
    interactionId: context.interactionId,
    observerId: "dom",
    observerVersion: "0.1.0",
    phase,
    status: "ok",
    timestamp: getTimestamp(),
    summary:
      phase === "after" && changed !== undefined
        ? changed
          ? "Captured DOM after state with observable markup changes."
          : "Captured DOM after state with no observable markup changes."
        : `Captured DOM ${phase} state.`,
    ...(phase === "before" ? { beforeStateRef: artifact } : { afterStateRef: artifact }),
    artifacts: artifact ? [artifact] : [],
    changes:
      phase === "after" && changed !== undefined
        ? [
            {
              path: "dom.html",
              summary: changed
                ? "DOM markup changed after the interaction."
                : "DOM markup did not change after the interaction.",
              before: {
                byteLength: previousByteLength
              },
              after: {
                byteLength
              },
              impact: changed ? "major" : "none"
            }
          ]
        : undefined,
    meta: {
      byteLength,
      ...(phase === "after" && changed !== undefined
        ? {
            changed,
            previousByteLength
          }
        : {})
    }
  };
}

async function captureAccessibilityRecord(
  context: RuntimeObserverContext,
  phase: "before" | "after"
): Promise<EvidenceRecord> {
  const snapshotAccessibilityTree =
    context.page?.snapshotAccessibilityTree?.bind(context.page) ??
    context.page?.accessibility?.snapshot?.bind(context.page.accessibility);

  if (!snapshotAccessibilityTree) {
    return {
      id: `accessibility-tree:${phase}:${Date.now()}`,
      runId: context.runId,
      checkpointId: context.checkpointId,
      interactionId: context.interactionId,
      observerId: "accessibility-tree",
      observerVersion: "0.1.0",
      phase,
      status: "unsupported",
      timestamp: getTimestamp(),
      diagnostics: ["Page accessibility snapshot API is unavailable."]
    };
  }

  let snapshot: unknown;

  try {
    snapshot = await snapshotAccessibilityTree();
  } catch (error) {
    return {
      id: `accessibility-tree:${phase}:${Date.now()}`,
      runId: context.runId,
      checkpointId: context.checkpointId,
      interactionId: context.interactionId,
      observerId: "accessibility-tree",
      observerVersion: "0.1.0",
      phase,
      status: "observer_error",
      timestamp: getTimestamp(),
      diagnostics: [
        error instanceof Error
          ? `Accessibility tree capture failed: ${error.message}`
          : "Accessibility tree capture failed."
      ]
    };
  }

  const content = JSON.stringify(snapshot ?? null, null, 2);
  const artifact = await maybeWriteArtifact(
    context,
    "accessibility-tree",
    phase,
    "accessibility-tree",
    "json",
    "application/json",
    content
  );

  return {
    id: `accessibility-tree:${phase}:${Date.now()}`,
    runId: context.runId,
    checkpointId: context.checkpointId,
    interactionId: context.interactionId,
    observerId: "accessibility-tree",
    observerVersion: "0.1.0",
    phase,
    status: "ok",
    timestamp: getTimestamp(),
    summary: `Captured accessibility tree ${phase} state.`,
    ...(phase === "before" ? { beforeStateRef: artifact } : { afterStateRef: artifact }),
    artifacts: artifact ? [artifact] : []
  };
}

async function captureFocusRecord(
  context: RuntimeObserverContext,
  phase: "before" | "after"
): Promise<EvidenceRecord> {
  const snapshotFocusTarget = context.page?.snapshotFocusTarget?.bind(context.page);

  if (!snapshotFocusTarget) {
    return {
      id: `focus:${phase}:${Date.now()}`,
      runId: context.runId,
      checkpointId: context.checkpointId,
      interactionId: context.interactionId,
      observerId: "focus",
      observerVersion: "0.1.0",
      phase,
      status: "unsupported",
      timestamp: getTimestamp(),
      diagnostics: ["Page focus snapshot API is unavailable."]
    };
  }

  let focusTarget: unknown;

  try {
    focusTarget = await snapshotFocusTarget();
  } catch (error) {
    return {
      id: `focus:${phase}:${Date.now()}`,
      runId: context.runId,
      checkpointId: context.checkpointId,
      interactionId: context.interactionId,
      observerId: "focus",
      observerVersion: "0.1.0",
      phase,
      status: "observer_error",
      timestamp: getTimestamp(),
      diagnostics: [
        error instanceof Error
          ? `Focus target capture failed: ${error.message}`
          : "Focus target capture failed."
      ]
    };
  }

  const content = JSON.stringify(focusTarget ?? null, null, 2);
  const artifact = await maybeWriteArtifact(
    context,
    "focus",
    phase,
    "custom",
    "json",
    "application/json",
    content
  );
  const focusDescription = describeFocusTarget(focusTarget);

  return {
    id: `focus:${phase}:${Date.now()}`,
    runId: context.runId,
    checkpointId: context.checkpointId,
    interactionId: context.interactionId,
    observerId: "focus",
    observerVersion: "0.1.0",
    phase,
    status: "ok",
    timestamp: getTimestamp(),
    summary: `Captured focus ${phase} state (${focusDescription}).`,
    artifacts: artifact ? [artifact] : [],
    meta: {
      focusTarget
    }
  };
}

async function captureVisualRecord(
  context: RuntimeObserverContext,
  phase: "before" | "after"
): Promise<EvidenceRecord> {
  const snapshotScreenshot = context.page?.snapshotScreenshot?.bind(context.page);

  if (!snapshotScreenshot) {
    return {
      id: `visual:${phase}:${Date.now()}`,
      runId: context.runId,
      checkpointId: context.checkpointId,
      interactionId: context.interactionId,
      observerId: "visual",
      observerVersion: "0.1.0",
      phase,
      status: "unsupported",
      timestamp: getTimestamp(),
      diagnostics: ["Page screenshot API is unavailable."]
    };
  }

  let screenshot: Uint8Array;

  try {
    screenshot = await snapshotScreenshot();
  } catch (error) {
    return {
      id: `visual:${phase}:${Date.now()}`,
      runId: context.runId,
      checkpointId: context.checkpointId,
      interactionId: context.interactionId,
      observerId: "visual",
      observerVersion: "0.1.0",
      phase,
      status: "observer_error",
      timestamp: getTimestamp(),
      diagnostics: [
        error instanceof Error
          ? `Screenshot capture failed: ${error.message}`
          : "Screenshot capture failed."
      ]
    };
  }

  const artifact = await maybeWriteArtifact(
    context,
    "visual",
    phase,
    "screenshot",
    "png",
    "image/png",
    screenshot
  );

  return {
    id: `visual:${phase}:${Date.now()}`,
    runId: context.runId,
    checkpointId: context.checkpointId,
    interactionId: context.interactionId,
    observerId: "visual",
    observerVersion: "0.1.0",
    phase,
    status: "ok",
    timestamp: getTimestamp(),
    summary: `Captured screenshot ${phase} state.`,
    ...(phase === "before" ? { beforeStateRef: artifact } : { afterStateRef: artifact }),
    artifacts: artifact ? [artifact] : [],
    meta: {
      byteLength: screenshot.byteLength
    }
  };
}

async function captureNetworkRecord(
  context: RuntimeObserverContext,
  phase: "before" | "after"
): Promise<EvidenceRecord> {
  const snapshotNetworkLog = context.page?.snapshotNetworkLog?.bind(context.page);

  if (!snapshotNetworkLog) {
    return {
      id: `network:${phase}:${Date.now()}`,
      runId: context.runId,
      checkpointId: context.checkpointId,
      interactionId: context.interactionId,
      observerId: "network",
      observerVersion: "0.1.0",
      phase,
      status: "unsupported",
      timestamp: getTimestamp(),
      diagnostics: ["Page network log API is unavailable."]
    };
  }

  let networkLog: unknown;

  try {
    networkLog = await snapshotNetworkLog();
  } catch (error) {
    return {
      id: `network:${phase}:${Date.now()}`,
      runId: context.runId,
      checkpointId: context.checkpointId,
      interactionId: context.interactionId,
      observerId: "network",
      observerVersion: "0.1.0",
      phase,
      status: "observer_error",
      timestamp: getTimestamp(),
      diagnostics: [
        error instanceof Error
          ? `Network log capture failed: ${error.message}`
          : "Network log capture failed."
      ]
    };
  }

  const sanitizedNetworkLog = sanitizeNetworkLog(networkLog);
  const content = JSON.stringify(sanitizedNetworkLog, null, 2);
  const artifact = await maybeWriteArtifact(
    context,
    "network",
    phase,
    "network-log",
    "json",
    "application/json",
    content
  );
  const summary = summarizeNetworkLog(sanitizedNetworkLog);
  const previousSummary = phase === "after" ? context.runtimeState?.networkBeforeSummary : undefined;
  const deltaSummary = phase === "after" ? summarizeNetworkDelta(previousSummary, summary) : undefined;

  if (phase === "before") {
    context.runtimeState = {
      ...(context.runtimeState ?? {}),
      networkBeforeSummary: summary
    };
  }

  return {
    id: `network:${phase}:${Date.now()}`,
    runId: context.runId,
    checkpointId: context.checkpointId,
    interactionId: context.interactionId,
    observerId: "network",
    observerVersion: "0.1.0",
    phase,
    status: "ok",
    timestamp: getTimestamp(),
    summary:
      phase === "after"
        ? formatAfterNetworkSummary(summary, deltaSummary)
        : formatBeforeNetworkSummary(summary),
    ...(phase === "before" ? { beforeStateRef: artifact } : { afterStateRef: artifact }),
    artifacts: artifact ? [artifact] : [],
    changes: deltaSummary
      ? [
          {
            path: "network.events",
            summary: formatNetworkChangeSummary(deltaSummary),
            before: {
              eventCount: previousSummary?.eventCount ?? 0,
              interestingEventCount: previousSummary?.interestingEventCount ?? 0
            },
            after: {
              eventCount: summary.eventCount,
              interestingEventCount: summary.interestingEventCount
            },
            impact: deltaSummary.interestingEventCount > 0 ? "major" : "none"
          }
        ]
      : undefined,
    meta: {
      eventCount: summary.eventCount,
      interestingEventCount: summary.interestingEventCount,
      filteredNoiseCount: summary.filteredNoiseCount,
      requestCount: summary.requestCount,
      responseCount: summary.responseCount,
      matchedResponseCount: summary.matchedResponseCount,
      unmatchedRequestCount: summary.unmatchedRequestCount,
      unmatchedResponseCount: summary.unmatchedResponseCount,
      interestingUrls: summary.interestingUrls,
      ...(deltaSummary
        ? {
            newEventCount: deltaSummary.eventCount,
            newInterestingEventCount: deltaSummary.interestingEventCount,
            newFilteredNoiseCount: deltaSummary.filteredNoiseCount,
            newRequestCount: deltaSummary.requestCount,
            newResponseCount: deltaSummary.responseCount,
            newMatchedResponseCount: deltaSummary.matchedResponseCount,
            newUnmatchedRequestCount: deltaSummary.unmatchedRequestCount,
            newUnmatchedResponseCount: deltaSummary.unmatchedResponseCount,
            newInterestingUrls: deltaSummary.interestingUrls
          }
        : {})
    }
  };
}

function sanitizeNetworkLog(networkLog: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(networkLog)) {
    return [];
  }

  return networkLog
    .map((event) => sanitizeNetworkEvent(event))
    .filter((event): event is Record<string, unknown> => Boolean(event));
}

function sanitizeNetworkEvent(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  const sanitized: Record<string, unknown> = {};
  const copiedFields = [
    "kind",
    "requestId",
    "method",
    "resourceType",
    "timestamp",
    "status",
    "statusText",
    "ok",
    "fromServiceWorker"
  ];

  for (const field of copiedFields) {
    if (event[field] !== undefined) {
      sanitized[field] = event[field];
    }
  }

  if (typeof event.url === "string") {
    sanitized.url = redactNetworkUrl(event.url);
  }

  if (isRecord(event.headers)) {
    sanitized.headers = Object.fromEntries(
      Object.keys(event.headers).map((name) => [name, "[REDACTED]"])
    );
  }

  if (event.postData !== undefined) {
    sanitized.postData = event.postData === null ? null : "[REDACTED]";
  }

  return sanitized;
}

function redactNetworkUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.hash = "";

    for (const name of new Set(url.searchParams.keys())) {
      url.searchParams.set(name, "[REDACTED]");
    }

    return url.toString();
  } catch {
    return value.split(/[?#]/, 1)[0] ?? "[REDACTED]";
  }
}

async function setupNetworkTracking(context: RuntimeObserverContext): Promise<void> {
  const setupTracking = context.page?.setupNetworkTracking?.bind(context.page);

  if (!setupTracking) {
    return;
  }

  await setupTracking();
}

async function teardownNetworkTracking(context: RuntimeObserverContext): Promise<void> {
  const teardownTracking = context.page?.teardownNetworkTracking?.bind(context.page);

  if (!teardownTracking) {
    return;
  }

  await teardownTracking();
}

async function maybeWriteArtifact(
  context: RuntimeObserverContext,
  observerId: string,
  phase: "before" | "after",
  kind: ArtifactKind,
  extension: string,
  mediaType: string,
  content: string | Uint8Array
) {
  if (!context.artifactDir) {
    return undefined;
  }

  await mkdir(context.artifactDir, { recursive: true });
  const filename = `${observerId}-${phase}.${extension}`;
  const targetPath = path.join(context.artifactDir, filename);
  await writeFile(targetPath, content);

  return {
    id: `${observerId}:${phase}:artifact`,
    kind,
    path: targetPath,
    mediaType
  };
}

function summarizeNetworkLog(networkLog: unknown): NetworkLogSummary {
  const events = Array.isArray(networkLog)
    ? networkLog.map((event) => normalizeNetworkEvent(event)).filter((event): event is NetworkEventRecord => Boolean(event))
    : [];

  return summarizeNormalizedNetworkEvents(events);
}

function summarizeNetworkDelta(
  previousSummary: NetworkLogSummary | undefined,
  currentSummary: NetworkLogSummary
): NetworkLogSummary {
  const previousCount = previousSummary?.events.length ?? 0;
  const deltaEvents =
    currentSummary.events.length >= previousCount
      ? currentSummary.events.slice(previousCount)
      : currentSummary.events;

  return summarizeNormalizedNetworkEvents(deltaEvents);
}

function summarizeNormalizedNetworkEvents(events: NetworkEventRecord[]): NetworkLogSummary {
  let interestingEventCount = 0;
  let filteredNoiseCount = 0;
  let requestCount = 0;
  let responseCount = 0;
  let matchedResponseCount = 0;
  let unmatchedResponseCount = 0;
  const interestingUrls = new Set<string>();
  const pendingRequests = new Map<string, number>();

  for (const event of events) {
    if (event.noise) {
      filteredNoiseCount += 1;
      continue;
    }

    interestingEventCount += 1;
    interestingUrls.add(event.url);

    const correlationKey = getNetworkCorrelationKey(event);

    if (event.kind === "request") {
      requestCount += 1;
      pendingRequests.set(correlationKey, (pendingRequests.get(correlationKey) ?? 0) + 1);
      continue;
    }

    responseCount += 1;
    const outstanding = pendingRequests.get(correlationKey) ?? 0;

    if (outstanding > 0) {
      matchedResponseCount += 1;
      pendingRequests.set(correlationKey, outstanding - 1);
    } else {
      unmatchedResponseCount += 1;
    }
  }

  const unmatchedRequestCount = [...pendingRequests.values()].reduce((total, count) => total + count, 0);

  return {
    events,
    eventCount: events.length,
    interestingEventCount,
    filteredNoiseCount,
    requestCount,
    responseCount,
    matchedResponseCount,
    unmatchedRequestCount,
    unmatchedResponseCount,
    interestingUrls: [...interestingUrls].slice(0, 5)
  };
}

function normalizeNetworkEvent(event: unknown): NetworkEventRecord | undefined {
  if (!isRecord(event)) {
    return undefined;
  }

  const kind = event.kind;
  const url = event.url;

  if ((kind !== "request" && kind !== "response") || typeof url !== "string") {
    return undefined;
  }

  return {
    kind,
    url,
    method: typeof event.method === "string" ? event.method : undefined,
    status: typeof event.status === "number" ? event.status : undefined,
    ok: typeof event.ok === "boolean" ? event.ok : undefined,
    resourceType: typeof event.resourceType === "string" ? event.resourceType : undefined,
    timestamp: typeof event.timestamp === "string" ? event.timestamp : undefined,
    requestId: typeof event.requestId === "number" ? event.requestId : undefined,
    noise: isNetworkNoiseUrl(url)
  };
}

function isNetworkNoiseUrl(url: string): boolean {
  return (
    url.startsWith("data:") ||
    url.startsWith("about:") ||
    url.startsWith("blob:") ||
    url.startsWith("javascript:") ||
    url.startsWith("chrome:") ||
    url.startsWith("chrome-extension:") ||
    url.startsWith("devtools:")
  );
}

function getNetworkCorrelationKey(event: NetworkEventRecord): string {
  if (typeof event.requestId === "number") {
    return `request-id:${event.requestId}`;
  }

  return `${event.method ?? "UNKNOWN"} ${event.url}`;
}

function formatBeforeNetworkSummary(summary: NetworkLogSummary): string {
  return `Captured ${summary.eventCount} network events before state (${summary.interestingEventCount} interesting, ${summary.filteredNoiseCount} filtered as noise).`;
}

function formatAfterNetworkSummary(summary: NetworkLogSummary, deltaSummary: NetworkLogSummary | undefined): string {
  if (!deltaSummary) {
    return `Captured ${summary.eventCount} network events after state (${summary.interestingEventCount} interesting, ${summary.filteredNoiseCount} filtered as noise).`;
  }

  return `Captured ${summary.eventCount} network events after state; ${formatNetworkDeltaSummary(deltaSummary)}.`;
}

function formatNetworkChangeSummary(deltaSummary: NetworkLogSummary): string {
  if (deltaSummary.interestingEventCount === 0) {
    if (deltaSummary.filteredNoiseCount > 0) {
      return `Observed ${deltaSummary.filteredNoiseCount} new network events, but all were filtered as noise.`;
    }

    return "No new network activity was observed around the interaction.";
  }

  return formatNetworkDeltaSummary(deltaSummary);
}

function formatNetworkDeltaSummary(deltaSummary: NetworkLogSummary): string {
  const urlSuffix =
    deltaSummary.interestingUrls.length > 0 ? ` URLs: ${deltaSummary.interestingUrls.join(", ")}.` : "";

  return `Observed ${deltaSummary.interestingEventCount} new interesting network events (${deltaSummary.requestCount} request${deltaSummary.requestCount === 1 ? "" : "s"}, ${deltaSummary.responseCount} response${deltaSummary.responseCount === 1 ? "" : "s"}, ${deltaSummary.matchedResponseCount} matched pair${deltaSummary.matchedResponseCount === 1 ? "" : "s"}, ${deltaSummary.filteredNoiseCount} filtered).${urlSuffix}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeFocusTarget(focusTarget: unknown): string {
  if (!isRecord(focusTarget)) {
    return "no focused element";
  }

  const tagName = typeof focusTarget.tagName === "string" ? focusTarget.tagName : "unknown";
  const id = typeof focusTarget.id === "string" && focusTarget.id.length > 0 ? `#${focusTarget.id}` : undefined;
  const role =
    typeof focusTarget.role === "string" && focusTarget.role.length > 0
      ? `role=${focusTarget.role}`
      : undefined;
  const name =
    typeof focusTarget.name === "string" && focusTarget.name.length > 0
      ? `"${focusTarget.name}"`
      : undefined;

  return [tagName, id, role, name].filter(Boolean).join(" ");
}

function unsupportedRecord(
  context: ObserverContext,
  observerId: string,
  phase: "before" | "after"
): EvidenceRecord {
  return {
    id: `${observerId}:${phase}:${Date.now()}`,
    runId: context.runId,
    checkpointId: context.checkpointId,
    interactionId: context.interactionId,
    observerId,
    observerVersion: "0.1.0",
    phase,
    status: "unsupported",
    timestamp: new Date().toISOString(),
    diagnostics: ["Observer scaffold only. Real capture not implemented yet."]
  };
}
