import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  executeRun,
  resolvePolicyConfig,
  type AeePolicyOverrides,
  type ArtifactRef,
  type CapturePolicy,
  type Checkpoint,
  type Interaction,
  type ReporterInput,
  type ReporterArtifact,
  type TargetDescriptor
} from "@aee/core";
import { createDefaultJudgePlugins } from "@aee/judges";
import { createDefaultObserverPlugins, type RuntimeObserverContext } from "@aee/observers";
import { createJsonReporter, createMarkdownReporter } from "@aee/reporter";
import { assertValidSchema } from "@aee/schemas";

export interface PlaywrightPageLike {
  url(): string;
  content(): Promise<string>;
  title?(): Promise<string>;
  screenshot?(options?: unknown): Promise<unknown>;
  snapshotAccessibilityTree?(options?: unknown): Promise<unknown>;
  snapshotFocusTarget?(options?: unknown): Promise<unknown>;
  snapshotScreenshot?(options?: unknown): Promise<Uint8Array>;
  setupNetworkTracking?(options?: unknown): Promise<void>;
  snapshotNetworkLog?(options?: unknown): Promise<unknown>;
  teardownNetworkTracking?(options?: unknown): Promise<void>;
  accessibility?: {
    snapshot(options?: unknown): Promise<unknown>;
  };
}

export interface VirtualPageFixture {
  url: string;
  html: string;
  title?: string;
  accessibilityTree?: unknown;
  focusTarget?: unknown;
  screenshotPngBase64?: string;
  networkEvents?: unknown[];
}

export interface PlaywrightInteractionContext<
  TPage extends PlaywrightPageLike = PlaywrightPageLike
> {
  page: TPage;
  runId: string;
  checkpoint: Checkpoint;
  interaction: Interaction;
}

export interface RunAeeOnPageOptions<TPage extends PlaywrightPageLike = PlaywrightPageLike> {
  page: TPage;
  projectRoot: string;
  outputDir?: string;
  runId?: string;
  version?: string;
  observers?: string[];
  judges?: string[];
  policy?: AeePolicyOverrides;
  checkpointName?: string;
  interaction?: InteractionRequest;
  writeReports?: boolean;
  performInteraction?: (context: PlaywrightInteractionContext<TPage>) => Promise<void>;
}

export interface RunAeeOnPageResult {
  runId: string;
  outputDir?: string;
  reporterFiles: string[];
  artifactFiles: string[];
  reportArtifacts: ReporterArtifact[];
}

export interface AeePlaywrightOptions {
  runId: string;
  checkpointPrefix?: string;
  interactionPrefix?: string;
}

export interface CheckpointRequest {
  page: PlaywrightPageLike;
  trigger: Checkpoint["trigger"];
  name?: string;
  artifactIds?: string[];
}

export interface InteractionRequest {
  kind: Interaction["kind"];
  timestamp?: string;
  actor?: Interaction["actor"];
  target?: TargetDescriptor;
  input?: string;
  meta?: Record<string, unknown>;
}

const defaultPlaywrightObserverIds = ["dom", "accessibility-tree"];

export function createVirtualPage(fixture: VirtualPageFixture): PlaywrightPageLike {
  return {
    url() {
      return fixture.url;
    },
    async content() {
      return fixture.html;
    },
    async title() {
      return fixture.title ?? "";
    },
    async snapshotAccessibilityTree() {
      return fixture.accessibilityTree ?? null;
    },
    async snapshotFocusTarget() {
      return fixture.focusTarget ?? null;
    },
    async snapshotNetworkLog() {
      return fixture.networkEvents ?? [];
    },
    ...(fixture.screenshotPngBase64
      ? {
          async snapshotScreenshot() {
            return Uint8Array.from(Buffer.from(fixture.screenshotPngBase64!, "base64"));
          }
        }
      : {})
  };
}

export function buildCheckpoint(
  options: AeePlaywrightOptions,
  request: CheckpointRequest
): Checkpoint {
  const prefix = options.checkpointPrefix ?? "checkpoint";

  return {
    id: `${prefix}:${request.trigger}:${Date.now()}`,
    runId: options.runId,
    name: request.name,
    url: request.page.url(),
    timestamp: new Date().toISOString(),
    trigger: request.trigger,
    artifactIds: request.artifactIds
  };
}

export function buildInteraction(
  options: AeePlaywrightOptions,
  request: InteractionRequest
): Interaction {
  const prefix = options.interactionPrefix ?? "interaction";

  return {
    id: `${prefix}:${request.kind}:${Date.now()}`,
    runId: options.runId,
    timestamp: request.timestamp ?? new Date().toISOString(),
    actor: request.actor ?? "test",
    kind: request.kind,
    target: request.target,
    input: request.input,
    meta: request.meta
  };
}

export function artifactFromPath(id: string, kind: ArtifactRef["kind"], path: string): ArtifactRef {
  return {
    id,
    kind,
    path
  };
}

export function resolveObserverIdsForCapturePolicy(
  observerIds: string[] | undefined,
  capturePolicy: CapturePolicy
): string[] {
  const selectedObserverIds = [...new Set(observerIds ?? defaultPlaywrightObserverIds)];

  return selectedObserverIds.filter((observerId) => {
    if (observerId === "dom") {
      return capturePolicy.includeDomSnapshot;
    }

    if (observerId === "accessibility-tree") {
      return capturePolicy.includeAccessibilityTree;
    }

    if (observerId === "visual") {
      return capturePolicy.includeScreenshots;
    }

    return true;
  });
}

export async function runAeeOnPage<TPage extends PlaywrightPageLike>(
  options: RunAeeOnPageOptions<TPage>
): Promise<RunAeeOnPageResult> {
  const runId = options.runId ?? `run-${Date.now()}`;
  assertSafeRunId(runId);
  const resolvedPolicy = resolvePolicyConfig(options.policy);
  const selectedObservers = resolveObserverIdsForCapturePolicy(
    options.observers,
    resolvedPolicy.capture
  );
  const performInteraction = options.performInteraction;
  const outputRoot = options.outputDir
    ? path.resolve(options.projectRoot, options.outputDir)
    : undefined;
  const outputDir = outputRoot ? path.resolve(outputRoot, runId) : undefined;
  const artifactDir = outputDir ? path.join(outputDir, "artifacts") : undefined;

  if (artifactDir) {
    await mkdir(artifactDir, { recursive: true });
  }

  const checkpoint = buildCheckpoint(
    { runId },
    {
      page: options.page,
      trigger: "manual",
      name: options.checkpointName ?? "playwright-page"
    }
  );

  const interaction = buildInteraction(
    { runId },
    {
      timestamp: new Date().toISOString(),
      actor: options.interaction?.actor ?? "test",
      kind: options.interaction?.kind ?? "custom",
      target: options.interaction?.target,
      input: options.interaction?.input,
      meta: options.interaction?.meta
    }
  );

  const observerContext: RuntimeObserverContext = {
    runId,
    checkpointId: checkpoint.id,
    interactionId: interaction.id,
    url: options.page.url(),
    page: await createObserverPage(options.page),
    artifactDir
  };

  const execution = await executeRun({
    runId,
    version: options.version ?? "0.1.0",
    checkpoint,
    interaction,
    observerContext,
    observerPlugins: createDefaultObserverPlugins(selectedObservers),
    judgePlugins: createDefaultJudgePlugins(options.judges),
    executeInteraction: performInteraction
      ? async () =>
          runInteractionWithStabilization(
            resolvedPolicy.capture.stabilizeAfterInteractionMs,
            performInteraction,
            {
              page: options.page,
              runId,
              checkpoint,
              interaction
            }
          )
      : undefined,
    environment: {
      mode: "playwright-page"
    },
    config: {
      writeReports: options.writeReports ?? true,
      policyName: resolvedPolicy.name,
      capturePolicy: resolvedPolicy.capture,
      selectedObservers
    },
    policyName: resolvedPolicy.name,
    releasePolicy: resolvedPolicy.release
  });

  const reportArtifacts = await renderReports({
    run: execution.run,
    bundles: execution.bundles,
    records: execution.records,
    judgments: execution.judgments,
    findings: execution.findings,
    artifacts: execution.artifacts
  });

  const reporterFiles =
    outputDir && (options.writeReports ?? true)
      ? await writeReporterArtifacts(
          outputDir,
          reportArtifacts,
          execution.bundles[0],
          execution.run
        )
      : [];

  return {
    runId,
    outputDir,
    reporterFiles,
    artifactFiles: execution.artifacts.map((artifact) => artifact.path),
    reportArtifacts
  };
}

function assertSafeRunId(runId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(runId) || runId === "." || runId === "..") {
    throw new Error(
      "Invalid runId. Use 1-128 letters, numbers, dots, underscores, or hyphens, beginning with a letter or number."
    );
  }
}

async function runInteractionWithStabilization<TPage extends PlaywrightPageLike>(
  stabilizeAfterInteractionMs: number,
  performInteraction: (context: PlaywrightInteractionContext<TPage>) => Promise<void>,
  context: PlaywrightInteractionContext<TPage>
): Promise<void> {
  await performInteraction(context);

  if (stabilizeAfterInteractionMs > 0) {
    await waitFor(stabilizeAfterInteractionMs);
  }
}

function waitFor(durationMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  detach?(): Promise<void>;
}

interface CdpContextLike {
  newCDPSession(page: unknown): Promise<CdpSessionLike>;
}

interface CdpEnabledPageLike extends PlaywrightPageLike {
  context?(): CdpContextLike;
}

interface EvaluatablePageLike extends PlaywrightPageLike {
  evaluate?(pageFunction: () => unknown): Promise<unknown>;
}

interface RequestLike {
  url(): string;
  method(): string;
  headers(): Record<string, string>;
  postData(): string | null;
  resourceType(): string;
}

interface ResponseLike {
  url(): string;
  status(): number;
  statusText(): string;
  ok(): boolean;
  headers(): Record<string, string>;
  fromServiceWorker(): boolean;
  request(): RequestLike;
}

interface EventedPageLike extends PlaywrightPageLike {
  on?(event: "request", listener: (request: RequestLike) => void): unknown;
  on?(event: "response", listener: (response: ResponseLike) => void): unknown;
  off?(event: "request", listener: (request: RequestLike) => void): unknown;
  off?(event: "response", listener: (response: ResponseLike) => void): unknown;
  removeListener?(event: "request", listener: (request: RequestLike) => void): unknown;
  removeListener?(event: "response", listener: (response: ResponseLike) => void): unknown;
}

async function createObserverPage(
  page: PlaywrightPageLike
): Promise<RuntimeObserverContext["page"]> {
  const cdpPage = page as CdpEnabledPageLike;
  const evaluatablePage = page as EvaluatablePageLike;
  const eventedPage = page as EventedPageLike;
  const customScreenshot = page.snapshotScreenshot?.bind(page);
  const customSetupNetworkTracking = page.setupNetworkTracking?.bind(page);
  const customSnapshotNetworkLog = page.snapshotNetworkLog?.bind(page);
  const customTeardownNetworkTracking = page.teardownNetworkTracking?.bind(page);
  const nativeScreenshot = page.screenshot?.bind(page);
  const networkTracker = createNetworkTracker(eventedPage);
  const snapshotAccessibilityTree = page.snapshotAccessibilityTree
    ? async () => page.snapshotAccessibilityTree?.()
    : page.accessibility?.snapshot
      ? async () => page.accessibility?.snapshot?.()
      : cdpPage.context
        ? async () => {
            const session = await cdpPage.context!().newCDPSession(page);

            try {
              return await session.send("Accessibility.getFullAXTree");
            } finally {
              await session.detach?.();
            }
          }
        : undefined;
  const snapshotFocusTarget = page.snapshotFocusTarget
    ? async () => page.snapshotFocusTarget?.()
    : evaluatablePage.evaluate
      ? async () =>
          evaluatablePage.evaluate?.(() => {
            const globalRef = globalThis as unknown as {
              document?: {
                activeElement?: unknown;
                getElementById?: (id: string) => unknown;
                querySelectorAll?: (selector: string) => Iterable<unknown>;
              };
              getComputedStyle?: (element: unknown) => {
                display?: string;
                visibility?: string;
              };
            };
            const documentRef = globalRef.document;
            const activeElement = documentRef?.activeElement as
              | {
                  tagName?: unknown;
                  id?: unknown;
                  textContent?: unknown;
                  type?: unknown;
                  tabIndex?: unknown;
                  disabled?: unknown;
                  parentElement?: unknown;
                  getAttribute?: (name: string) => string | null;
                  getClientRects?: () => { length?: number };
                  querySelectorAll?: (selector: string) => Iterable<unknown>;
                }
              | undefined;

            if (!activeElement) {
              return null;
            }

            const isElementLike = (
              value: unknown
            ): value is {
              tagName?: unknown;
              id?: unknown;
              textContent?: unknown;
              type?: unknown;
              tabIndex?: unknown;
              disabled?: unknown;
              parentElement?: unknown;
              getAttribute?: (name: string) => string | null;
              getClientRects?: () => { length?: number };
              querySelectorAll?: (selector: string) => Iterable<unknown>;
            } => typeof value === "object" && value !== null;
            const compositeRoles = [
              "tablist",
              "radiogroup",
              "listbox",
              "menu",
              "menubar",
              "tree",
              "grid"
            ];
            const itemRoleSelectors: Record<string, string> = {
              tablist: '[role="tab"]',
              radiogroup: '[role="radio"]',
              listbox: '[role="option"]',
              menu: '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
              menubar: '[role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"]',
              tree: '[role="treeitem"]',
              grid: '[role="gridcell"], [role="rowheader"], [role="columnheader"]'
            };
            const getCompositeRole = (
              element:
                | {
                    parentElement?: unknown;
                    getAttribute?: (name: string) => string | null;
                  }
                | undefined
            ) => {
              let current = element?.parentElement;

              while (isElementLike(current)) {
                const currentRole = current.getAttribute?.("role");

                if (typeof currentRole === "string" && compositeRoles.includes(currentRole)) {
                  return {
                    compositeRole: currentRole,
                    compositeElement: current
                  };
                }

                current = current.parentElement;
              }

              return {
                compositeRole: undefined,
                compositeElement: undefined
              };
            };
            const getBooleanAttribute = (
              element: {
                getAttribute?: (name: string) => string | null;
              },
              name: string
            ) => {
              const value = element.getAttribute?.(name);

              if (value === "true") {
                return true;
              }

              if (value === "false") {
                return false;
              }

              return undefined;
            };
            const getElementSummary = (element: {
              tagName?: unknown;
              id?: unknown;
              textContent?: unknown;
              type?: unknown;
              tabIndex?: unknown;
              disabled?: unknown;
              parentElement?: unknown;
              getAttribute?: (name: string) => string | null;
              getClientRects?: () => { length?: number };
              querySelectorAll?: (selector: string) => Iterable<unknown>;
            }) => {
              const role = element.getAttribute?.("role");
              const tagName =
                typeof element.tagName === "string" ? element.tagName.toLowerCase() : undefined;
              const id =
                typeof element.id === "string" && element.id.length > 0 ? element.id : undefined;
              const name =
                element.getAttribute?.("aria-label") ??
                element.getAttribute?.("name") ??
                (typeof element.textContent === "string" && element.textContent.trim().length > 0
                  ? element.textContent.trim().slice(0, 120)
                  : undefined);
              const type =
                typeof element.type === "string" && element.type.length > 0
                  ? element.type
                  : undefined;
              const focusOrderIndex = focusableElements.indexOf(element);
              const tabIndex = typeof element.tabIndex === "number" ? element.tabIndex : undefined;
              const disabled = typeof element.disabled === "boolean" ? element.disabled : undefined;
              const compositeContext = getCompositeRole(element);
              const compositeSelector = compositeContext.compositeRole
                ? itemRoleSelectors[compositeContext.compositeRole]
                : undefined;
              const compositeItems = compositeSelector
                ? Array.from(
                    compositeContext.compositeElement?.querySelectorAll?.(compositeSelector) ?? []
                  ).filter(isElementLike)
                : [];
              const compositeItemIndex = compositeItems.indexOf(element);

              return {
                tagName,
                id,
                role: role ?? undefined,
                name,
                type,
                tabIndex,
                disabled,
                ariaSelected: getBooleanAttribute(element, "aria-selected"),
                ariaChecked: getBooleanAttribute(element, "aria-checked"),
                compositeRole: compositeContext.compositeRole,
                compositeItemIndex: compositeItemIndex >= 0 ? compositeItemIndex : undefined,
                compositeItemCount: compositeItems.length > 0 ? compositeItems.length : undefined,
                focusOrderIndex: focusOrderIndex >= 0 ? focusOrderIndex : undefined,
                focusableCount: focusableElements.length
              };
            };

            const focusableElements = Array.from(
              documentRef?.querySelectorAll?.(
                'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]'
              ) ?? []
            )
              .filter(
                (
                  element
                ): element is {
                  tagName?: unknown;
                  id?: unknown;
                  textContent?: unknown;
                  type?: unknown;
                  tabIndex?: unknown;
                  disabled?: unknown;
                  getAttribute?: (name: string) => string | null;
                  getClientRects?: () => { length?: number };
                } => typeof element === "object" && element !== null
              )
              .filter((element) => {
                if (typeof element.tabIndex === "number" && element.tabIndex < 0) {
                  return false;
                }

                if (element.disabled) {
                  return false;
                }

                const style = globalRef.getComputedStyle?.(element);

                if (style?.display === "none" || style?.visibility === "hidden") {
                  return false;
                }

                const rects = element.getClientRects?.();
                return typeof rects?.length === "number" ? rects.length > 0 : true;
              });
            const activeDescendantId =
              activeElement.getAttribute?.("aria-activedescendant") ?? undefined;
            const activeDescendantCandidate = activeDescendantId
              ? documentRef?.getElementById?.(activeDescendantId)
              : undefined;
            const activeDescendant =
              activeDescendantCandidate && isElementLike(activeDescendantCandidate)
                ? getElementSummary(activeDescendantCandidate)
                : undefined;
            const activeElementSummary = getElementSummary(activeElement);

            return {
              ...activeElementSummary,
              activeDescendantId,
              activeDescendant
            };
          })
      : undefined;
  const snapshotScreenshot = customScreenshot
    ? async () => customScreenshot()
    : nativeScreenshot
      ? async () => {
          const value = await nativeScreenshot({ type: "png" });

          if (value instanceof Uint8Array) {
            return value;
          }

          throw new Error("Screenshot API returned a non-binary payload.");
        }
      : undefined;
  const setupNetworkTracking =
    customSetupNetworkTracking ??
    (networkTracker
      ? async () => {
          networkTracker.setup();
        }
      : undefined);
  const snapshotNetworkLog =
    customSnapshotNetworkLog ??
    (networkTracker ? async () => networkTracker.snapshot() : undefined);
  const teardownNetworkTracking =
    customTeardownNetworkTracking ??
    (networkTracker
      ? async () => {
          networkTracker.teardown();
        }
      : undefined);

  return {
    async content() {
      return page.content();
    },
    snapshotAccessibilityTree,
    snapshotFocusTarget,
    snapshotScreenshot,
    setupNetworkTracking,
    snapshotNetworkLog,
    teardownNetworkTracking
  };
}

function createNetworkTracker(page: EventedPageLike) {
  if (!page.on) {
    return undefined;
  }

  const events: Array<Record<string, unknown>> = [];
  const requestIds = new WeakMap<object, number>();
  let nextRequestId = 1;
  let tracking = false;
  const requestListener = (request: RequestLike) => {
    const requestObject = request as object;
    const requestId = nextRequestId++;
    requestIds.set(requestObject, requestId);

    events.push({
      kind: "request",
      requestId,
      url: redactNetworkUrl(request.url()),
      method: request.method(),
      resourceType: request.resourceType(),
      headers: redactHeaderValues(request.headers()),
      postData: request.postData() === null ? null : "[REDACTED]",
      timestamp: new Date().toISOString()
    });
  };
  const responseListener = (response: ResponseLike) => {
    const request = response.request();
    const requestId = requestIds.get(request as object);

    events.push({
      kind: "response",
      requestId,
      url: redactNetworkUrl(response.url()),
      status: response.status(),
      statusText: response.statusText(),
      ok: response.ok(),
      fromServiceWorker: response.fromServiceWorker(),
      headers: redactHeaderValues(response.headers()),
      method: request.method(),
      timestamp: new Date().toISOString()
    });
  };

  return {
    setup() {
      if (tracking) {
        return;
      }

      page.on?.("request", requestListener);
      page.on?.("response", responseListener);
      tracking = true;
    },
    snapshot() {
      return events.map((event) => ({ ...event }));
    },
    teardown() {
      if (!tracking) {
        return;
      }

      if (page.off) {
        page.off("request", requestListener);
        page.off("response", responseListener);
      } else if (page.removeListener) {
        page.removeListener("request", requestListener);
        page.removeListener("response", responseListener);
      }

      tracking = false;
    }
  };
}

function redactHeaderValues(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.keys(headers).map((name) => [name, "[REDACTED]"]));
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

async function renderReports(input: ReporterInput): Promise<ReporterArtifact[]> {
  const reporters = [createJsonReporter(), createMarkdownReporter()];
  const batches = await Promise.all(reporters.map((reporter) => reporter.render(input)));
  return batches.flat();
}

async function writeReporterArtifacts(
  outputDir: string,
  artifacts: ReporterArtifact[],
  bundle: import("@aee/core").EvidenceBundle,
  run: import("@aee/core").AeeRun
): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });
  assertValidSchema("run", run, "AEE run output");
  assertValidSchema("evidenceBundle", bundle, "AEE evidence bundle output");

  const writes = artifacts.map(async (artifact) => {
    const targetPath = path.join(outputDir, artifact.label);
    await writeFile(targetPath, artifact.content, "utf8");
    return targetPath;
  });

  const files = await Promise.all(writes);
  await writeFile(path.join(outputDir, "bundle.json"), JSON.stringify(bundle, null, 2), "utf8");
  await writeFile(path.join(outputDir, "run.json"), JSON.stringify(run, null, 2), "utf8");
  return files;
}
