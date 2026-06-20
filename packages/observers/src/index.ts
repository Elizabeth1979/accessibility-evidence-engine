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
    accessibility?: {
      snapshot(options?: unknown): Promise<unknown>;
    };
  };
  artifactDir?: string;
  captureLabel?: string;
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
  const artifact = await maybeWriteArtifact(
    context,
    "dom",
    phase,
    "dom-snapshot",
    "html",
    "text/html",
    html
  );

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
    summary: `Captured DOM ${phase} state.`,
    ...(phase === "before" ? { beforeStateRef: artifact } : { afterStateRef: artifact }),
    artifacts: artifact ? [artifact] : []
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

async function maybeWriteArtifact(
  context: RuntimeObserverContext,
  observerId: string,
  phase: "before" | "after",
  kind: ArtifactKind,
  extension: string,
  mediaType: string,
  content: string
) {
  if (!context.artifactDir) {
    return undefined;
  }

  await mkdir(context.artifactDir, { recursive: true });
  const filename = `${observerId}-${phase}.${extension}`;
  const targetPath = path.join(context.artifactDir, filename);
  await writeFile(targetPath, content, "utf8");

  return {
    id: `${observerId}:${phase}:artifact`,
    kind,
    path: targetPath,
    mediaType
  };
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
