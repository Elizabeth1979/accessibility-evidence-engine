import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  executeRun,
  type ArtifactRef,
  type Checkpoint,
  type Interaction,
  type ReporterInput,
  type ReporterArtifact,
  type TargetDescriptor
} from "@aee/core";
import { createDefaultJudgePlugins } from "@aee/judges";
import { createDefaultObserverPlugins, type RuntimeObserverContext } from "@aee/observers";
import { createJsonReporter, createMarkdownReporter } from "@aee/reporter";

export interface PlaywrightPageLike {
  url(): string;
  content(): Promise<string>;
  title?(): Promise<string>;
  screenshot?(options?: unknown): Promise<unknown>;
  snapshotAccessibilityTree?(options?: unknown): Promise<unknown>;
  snapshotFocusTarget?(options?: unknown): Promise<unknown>;
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
}

export interface PlaywrightInteractionContext<TPage extends PlaywrightPageLike = PlaywrightPageLike> {
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
  timestamp: string;
  actor?: Interaction["actor"];
  target?: TargetDescriptor;
  input?: string;
  meta?: Record<string, unknown>;
}

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
    }
  };
}

export function buildCheckpoint(options: AeePlaywrightOptions, request: CheckpointRequest): Checkpoint {
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

export function buildInteraction(options: AeePlaywrightOptions, request: InteractionRequest): Interaction {
  const prefix = options.interactionPrefix ?? "interaction";

  return {
    id: `${prefix}:${request.kind}:${Date.now()}`,
    runId: options.runId,
    timestamp: request.timestamp,
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

export async function runAeeOnPage<TPage extends PlaywrightPageLike>(
  options: RunAeeOnPageOptions<TPage>
): Promise<RunAeeOnPageResult> {
  const runId = options.runId ?? `run-${Date.now()}`;
  const outputDir = options.outputDir
    ? path.resolve(options.projectRoot, options.outputDir, runId)
    : undefined;
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
    observerPlugins: createDefaultObserverPlugins(options.observers),
    judgePlugins: createDefaultJudgePlugins(options.judges),
    executeInteraction: options.performInteraction
      ? async () =>
          options.performInteraction?.({
            page: options.page,
            runId,
            checkpoint,
            interaction
          })
      : undefined,
    environment: {
      mode: "playwright-page"
    },
    config: {
      writeReports: options.writeReports ?? true
    }
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
      ? await writeReporterArtifacts(outputDir, reportArtifacts, execution.bundles[0], execution.run)
      : [];

  return {
    runId,
    outputDir,
    reporterFiles,
    artifactFiles: execution.artifacts.map((artifact) => artifact.path),
    reportArtifacts
  };
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

async function createObserverPage(page: PlaywrightPageLike): Promise<RuntimeObserverContext["page"]> {
  const cdpPage = page as CdpEnabledPageLike;
  const evaluatablePage = page as EvaluatablePageLike;
  const snapshotAccessibilityTree =
    page.snapshotAccessibilityTree
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
  const snapshotFocusTarget =
    page.snapshotFocusTarget
      ? async () => page.snapshotFocusTarget?.()
      : evaluatablePage.evaluate
        ? async () =>
            evaluatablePage.evaluate?.(() => {
              const documentRef = (globalThis as unknown as { document?: { activeElement?: unknown } }).document;
              const activeElement = documentRef?.activeElement as
                | {
                    tagName?: unknown;
                    id?: unknown;
                    textContent?: unknown;
                    type?: unknown;
                    getAttribute?: (name: string) => string | null;
                  }
                | undefined;

              if (!activeElement) {
                return null;
              }

              const role = activeElement.getAttribute?.("role");
              const tagName =
                typeof activeElement.tagName === "string" ? activeElement.tagName.toLowerCase() : undefined;
              const id =
                typeof activeElement.id === "string" && activeElement.id.length > 0 ? activeElement.id : undefined;
              const name =
                activeElement.getAttribute?.("aria-label") ??
                activeElement.getAttribute?.("name") ??
                (typeof activeElement.textContent === "string" && activeElement.textContent.trim().length > 0
                  ? activeElement.textContent.trim().slice(0, 120)
                  : undefined);
              const type =
                typeof activeElement.type === "string" && activeElement.type.length > 0
                  ? activeElement.type
                  : undefined;

              return {
                tagName,
                id,
                role: role ?? undefined,
                name,
                type
              };
            })
        : undefined;

  return {
    async content() {
      return page.content();
    },
    snapshotAccessibilityTree,
    snapshotFocusTarget
  };
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
