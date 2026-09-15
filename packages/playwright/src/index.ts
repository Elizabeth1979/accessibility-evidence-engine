import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import AxeBuilder from "@axe-core/playwright";
import {
  executeRun,
  resolvePolicyConfig,
  type AeePolicyOverrides,
  type ArtifactRef,
  type CapturePolicy,
  type Checkpoint,
  type Interaction,
  type JudgmentVerdict,
  type ReporterInput,
  type ReporterArtifact,
  type RunSummary,
  type TargetDescriptor
} from "@aee/core";
import { createDefaultJudgePlugins } from "@aee/judges";
import { createDefaultObserverPlugins, type RuntimeObserverContext } from "@aee/observers";
import { createJsonReporter, createMarkdownReporter } from "@aee/reporter";
import { assertValidSchema } from "@aee/schemas";

import {
  createPortableVirtualScreenReader,
  renderPortableVirtualScreenReaderTranscript,
  type PortableVirtualScreenReader,
  type VirtualScreenReaderCommand,
  type VirtualScreenReaderEntry,
  type VirtualScreenReaderPage,
  type VirtualScreenReaderTranscript
} from "./virtual-screen-reader";
import {
  writeEvidenceManifest,
  type EvidenceManifestSupplementalFile,
  type EvidenceManifestActionSource,
  type EvidenceManifestLaneSource
} from "./evidence-manifest";
import {
  persistInteractionVideo,
  type InteractionVideoActionInput,
  type InteractionVideoEvidence,
  type PlaywrightVideoLike
} from "./interaction-video";
export * from "./evidence-manifest";
export * from "./interaction-video";
export * from "./virtual-screen-reader";

export interface PlaywrightPageLike {
  url(): string;
  content(): Promise<string>;
  title?(): Promise<string>;
  screenshot?(options?: unknown): Promise<unknown>;
  snapshotAccessibilityTree?(options?: unknown): Promise<unknown>;
  snapshotFocusTarget?(options?: unknown): Promise<unknown>;
  snapshotScreenshot?(options?: { fullPage?: boolean }): Promise<Uint8Array>;
  runAxeAnalysis?(options: { tags: string[] }): Promise<unknown>;
  setupNetworkTracking?(options?: unknown): Promise<void>;
  snapshotNetworkLog?(options?: unknown): Promise<unknown>;
  teardownNetworkTracking?(options?: unknown): Promise<void>;
  snapshotVirtualScreenReaderTranscript?(): Promise<unknown>;
  video?(): PlaywrightVideoLike | null;
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
  virtualScreenReader?: PortableVirtualScreenReader;
  performInteraction?: (context: PlaywrightInteractionContext<TPage>) => Promise<void>;
}

export interface RunAeeOnPageResult {
  runId: string;
  outputDir?: string;
  reporterFiles: string[];
  artifactFiles: string[];
  reportArtifacts: ReporterArtifact[];
}

export interface VirtualScreenReaderLanePage extends PlaywrightPageLike, VirtualScreenReaderPage {
  goto(url: string, options?: { waitUntil?: "domcontentloaded" }): Promise<unknown>;
}

export interface VirtualScreenReaderLaneContext<TPage extends VirtualScreenReaderLanePage> {
  newPage(): Promise<TPage>;
  close(): Promise<void>;
}

export interface VirtualScreenReaderLaneBrowser<TPage extends VirtualScreenReaderLanePage> {
  newContext(options?: LaneBrowserContextOptions): Promise<VirtualScreenReaderLaneContext<TPage>>;
}

export interface LaneBrowserContextOptions {
  storageState?: unknown;
  recordVideo?: {
    dir: string;
    size: { width: number; height: number };
  };
}

export interface RunVirtualScreenReaderLaneOptions<TPage extends VirtualScreenReaderLanePage> {
  browser: VirtualScreenReaderLaneBrowser<TPage>;
  projectRoot: string;
  targetUrl: string;
  allowedOrigins: string[];
  commands: VirtualScreenReaderCommand[];
  outputDir?: string;
  laneId?: string;
  policy?: AeePolicyOverrides;
  additionalObservers?: string[];
  additionalJudges?: string[];
}

export interface VirtualScreenReaderLaneStep {
  sequence: number;
  command: VirtualScreenReaderCommand;
  runId: string;
  pageUrl: string;
  entry: VirtualScreenReaderEntry;
  results: RunSummary;
  releaseVerdict: JudgmentVerdict;
  reporterFiles: string[];
  artifactFiles: string[];
}

export interface VirtualScreenReaderLaneResult {
  schemaVersion: "0.1.0";
  laneId: string;
  driver: "portable-virtual-screen-reader";
  isolation: "dedicated-browser-context";
  status: "completed";
  targetUrl: string;
  allowedOrigins: string[];
  startedAt: string;
  finishedAt: string;
  steps: VirtualScreenReaderLaneStep[];
  transcript: VirtualScreenReaderTranscript;
  laneFile?: string;
  transcriptJsonFile?: string;
  transcriptTextFile?: string;
  manifestFile?: string;
  video?: InteractionVideoEvidence;
}

export interface InputComparisonTarget {
  selector?: string;
  role?: string;
  name?: string;
  exact?: boolean;
}

export interface InputComparisonAction {
  id: string;
  kind: "hover" | "click" | "focus" | "press";
  target?: InputComparisonTarget;
  key?:
    | "Tab"
    | "Shift+Tab"
    | "Enter"
    | "Space"
    | "Escape"
    | "ArrowUp"
    | "ArrowDown"
    | "ArrowLeft"
    | "ArrowRight"
    | "Home"
    | "End";
}

export interface InputComparisonObservationRequest {
  target?: InputComparisonTarget;
  url?: boolean;
  visible?: boolean;
  text?: boolean;
  focused?: boolean;
  attributes?: string[];
}

export interface InputComparisonExpectation {
  url?: string;
  visible?: boolean;
  text?: string | null;
  focused?: boolean;
  attributes?: Record<string, string | null>;
}

export type InputComparisonObservation = InputComparisonExpectation;

export interface InteractionLaneLocator {
  hover(): Promise<void>;
  click(): Promise<void>;
  focus(): Promise<void>;
  isVisible(): Promise<boolean>;
  textContent(): Promise<string | null>;
  getAttribute(name: string): Promise<string | null>;
  evaluate<T>(callback: (element: { ownerDocument: { activeElement: unknown } }) => T): Promise<T>;
}

export interface InteractionComparisonPage extends PlaywrightPageLike {
  goto(url: string, options?: { waitUntil?: "domcontentloaded" }): Promise<unknown>;
  locator(selector: string): InteractionLaneLocator;
  keyboard: { press(key: string): Promise<void> };
}

export interface InteractionComparisonContext<TPage extends InteractionComparisonPage> {
  newPage(): Promise<TPage>;
  close(): Promise<void>;
}

export interface InteractionComparisonBrowser<TPage extends InteractionComparisonPage> {
  newContext(options?: LaneBrowserContextOptions): Promise<InteractionComparisonContext<TPage>>;
}

export interface RunInputComparisonOptions<TPage extends InteractionComparisonPage> {
  browser: InteractionComparisonBrowser<TPage>;
  projectRoot: string;
  targetUrl: string;
  allowedOrigins: string[];
  comparisonId?: string;
  name: string;
  pointerActions: InputComparisonAction[];
  keyboardActions: InputComparisonAction[];
  observe: InputComparisonObservationRequest;
  expected?: InputComparisonExpectation;
  outputDir?: string;
  policy?: AeePolicyOverrides;
  additionalObservers?: string[];
  additionalJudges?: string[];
}

export interface InputComparisonStep {
  sequence: number;
  action: InputComparisonAction;
  runId: string;
  pageUrl: string;
  results: RunSummary;
  releaseVerdict: JudgmentVerdict;
  reporterFiles: string[];
  artifactFiles: string[];
}

export interface InputComparisonLane {
  driver: "pointer" | "keyboard";
  steps: InputComparisonStep[];
  observation: InputComparisonObservation;
  video: InteractionVideoEvidence;
}

export interface InputComparisonResult {
  schemaVersion: "0.1.0";
  comparisonId: string;
  name: string;
  isolation: "separate-dedicated-browser-contexts";
  status: "completed";
  targetUrl: string;
  allowedOrigins: string[];
  startedAt: string;
  finishedAt: string;
  initialState: {
    strategy: "shared-playwright-storage-state";
    resolvedUrl: string;
    contentHash: string;
  };
  lanes: { pointer: InputComparisonLane; keyboard: InputComparisonLane };
  equivalence: { verdict: "pass" | "fail"; summary: string };
  expectation?: {
    verdict: "pass" | "fail";
    expected: InputComparisonExpectation;
    summary: string;
  };
  traceFile: string;
  manifestFile: string;
}

export interface InteractionOutcomeComparison<T> {
  verdict: "pass" | "fail";
  pointerOutcome: T;
  keyboardOutcome: T;
  summary: string;
}

export interface ComparePointerAndKeyboardOptions<T> {
  reset(): Promise<void>;
  performPointerInteraction(): Promise<void>;
  performKeyboardInteraction(): Promise<void>;
  captureOutcome(): Promise<T>;
  equals?: (pointerOutcome: T, keyboardOutcome: T) => boolean;
}

/** Runs equivalent pointer and keyboard paths from the same reset state and compares outcomes. */
export async function comparePointerAndKeyboardOutcomes<T>(
  options: ComparePointerAndKeyboardOptions<T>
): Promise<InteractionOutcomeComparison<T>> {
  await options.reset();
  await options.performPointerInteraction();
  const pointerOutcome = await options.captureOutcome();
  await options.reset();
  await options.performKeyboardInteraction();
  const keyboardOutcome = await options.captureOutcome();
  const equivalent = (options.equals ?? isDeepStrictEqual)(pointerOutcome, keyboardOutcome);

  return {
    verdict: equivalent ? "pass" : "fail",
    pointerOutcome,
    keyboardOutcome,
    summary: equivalent
      ? "Pointer and keyboard interactions produced equivalent observable outcomes."
      : "Pointer and keyboard interactions produced different observable outcomes."
  };
}

export interface MotionSample {
  activeAnimations: number;
  signature: string;
}

export interface MotionControlVerification {
  verdict: "pass" | "fail";
  before: MotionSample;
  after: MotionSample;
  settled: MotionSample;
  summary: string;
}

export interface VerifyMotionControlOptions {
  sample(): Promise<MotionSample>;
  requestStop(): Promise<void>;
  settleMs?: number;
}

/** Verifies that a stop action removes active motion and leaves a stable observable state. */
export async function verifyMotionControl(
  options: VerifyMotionControlOptions
): Promise<MotionControlVerification> {
  const before = await options.sample();
  await options.requestStop();
  await waitFor(options.settleMs ?? 100);
  const after = await options.sample();
  await waitFor(options.settleMs ?? 100);
  const settled = await options.sample();
  const stopped =
    after.activeAnimations === 0 &&
    settled.activeAnimations === 0 &&
    after.signature === settled.signature;

  return {
    verdict: stopped ? "pass" : "fail",
    before,
    after,
    settled,
    summary: stopped
      ? "The requested control stopped the observed motion and the visual state remained stable."
      : "Motion continued, remained active, or changed again after the stop request."
  };
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
    page: await createObserverPage(options.page, options.virtualScreenReader),
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

const VIRTUAL_READER_LANE_OBSERVERS = [
  "focus",
  "dom",
  "accessibility-tree",
  "visual",
  "axe",
  "virtual-screen-reader"
];

const VIRTUAL_READER_LANE_JUDGES = ["screen-reader", "axe", "release"];

const INPUT_COMPARISON_OBSERVERS = ["focus", "dom", "accessibility-tree", "visual", "axe"];
const INPUT_COMPARISON_JUDGES = ["axe", "release"];

const INPUT_LANE_REQUIRED_ARTIFACTS = [
  "focus-before.json",
  "focus-after.json",
  "dom-before.html",
  "dom-after.html",
  "accessibility-tree-before.json",
  "accessibility-tree-after.json",
  "visual-viewport-before.png",
  "visual-viewport-after.png",
  "visual-full-page-before.png",
  "visual-full-page-after.png",
  "axe-before.json",
  "axe-after.json"
];

const VIRTUAL_READER_REQUIRED_ARTIFACTS = [
  ...INPUT_LANE_REQUIRED_ARTIFACTS,
  "virtual-screen-reader-transcript-json-before.json",
  "virtual-screen-reader-transcript-json-after.json",
  "virtual-screen-reader-transcript-text-before.txt",
  "virtual-screen-reader-transcript-text-after.txt"
];

/** Runs only caller-supplied actions in isolated pointer and keyboard contexts. */
export async function runInputComparison<TPage extends InteractionComparisonPage>(
  options: RunInputComparisonOptions<TPage>
): Promise<InputComparisonResult> {
  validateInputComparisonOptions(options);
  const comparisonId = options.comparisonId ?? `input-comparison-${Date.now()}`;
  assertSafeRunId(comparisonId);
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins, "input comparison");
  assertAllowedOrigin(options.targetUrl, allowedOrigins, "Input comparison");
  const outputBase = options.outputDir ?? "aee-output";
  const comparisonOutputDir = path.resolve(options.projectRoot, outputBase, comparisonId);
  const runOutputDir = path.join(outputBase, comparisonId);
  const traceFile = path.join(comparisonOutputDir, "interaction-trace.json");
  const manifestFile = path.join(comparisonOutputDir, "manifest.json");
  const startedAt = new Date().toISOString();
  const manifestSupplementalFiles: EvidenceManifestSupplementalFile[] = [];
  const manifestLanes: EvidenceManifestLaneSource[] = [
    {
      id: `${comparisonId}-pointer`,
      driver: "pointer",
      status: "blocked",
      actions: []
    },
    {
      id: `${comparisonId}-keyboard`,
      driver: "keyboard",
      status: "blocked",
      actions: []
    }
  ];
  await mkdir(comparisonOutputDir, { recursive: true });

  try {
    const initialState = await captureInitialStorageState(
      options.browser,
      options.targetUrl,
      allowedOrigins
    );
    const createContext = (driver: "pointer" | "keyboard") =>
      options.browser.newContext({
        storageState: initialState.storageState,
        recordVideo: {
          dir: path.join(comparisonOutputDir, driver),
          size: { width: 1280, height: 720 }
        }
      });
    const pointer = await runInputLane(
      options,
      comparisonId,
      "pointer",
      options.pointerActions,
      allowedOrigins,
      runOutputDir,
      () => createContext("pointer"),
      initialState.resolvedUrl,
      manifestLanes[0]!,
      comparisonOutputDir,
      manifestSupplementalFiles
    );
    const keyboard = await runInputLane(
      options,
      comparisonId,
      "keyboard",
      options.keyboardActions,
      allowedOrigins,
      runOutputDir,
      () => createContext("keyboard"),
      initialState.resolvedUrl,
      manifestLanes[1]!,
      comparisonOutputDir,
      manifestSupplementalFiles
    );
    const equivalent = isDeepStrictEqual(pointer.observation, keyboard.observation);
    const expectationMatches = options.expected
      ? matchesInputExpectation(pointer.observation, options.expected) &&
        matchesInputExpectation(keyboard.observation, options.expected)
      : undefined;
    const result: InputComparisonResult = {
      schemaVersion: "0.1.0",
      comparisonId,
      name: options.name,
      isolation: "separate-dedicated-browser-contexts",
      status: "completed",
      targetUrl: options.targetUrl,
      allowedOrigins,
      startedAt,
      finishedAt: new Date().toISOString(),
      initialState: {
        strategy: "shared-playwright-storage-state",
        resolvedUrl: initialState.resolvedUrl,
        contentHash: initialState.contentHash
      },
      lanes: { pointer, keyboard },
      equivalence: {
        verdict: equivalent ? "pass" : "fail",
        summary: equivalent
          ? "Pointer and keyboard lanes produced the same user-declared observable outcome."
          : "Pointer and keyboard lanes produced different user-declared observable outcomes."
      },
      ...(options.expected
        ? {
            expectation: {
              verdict: expectationMatches ? ("pass" as const) : ("fail" as const),
              expected: options.expected,
              summary: expectationMatches
                ? "Both lanes matched the user-declared expected outcome."
                : "One or both lanes did not match the user-declared expected outcome."
            }
          }
        : {}),
      traceFile,
      manifestFile
    };

    assertValidSchema("interactionComparison", result, "pointer and keyboard interaction trace");
    await writeFile(traceFile, JSON.stringify(result, null, 2), "utf8");
    await writeEvidenceManifest({
      assessmentId: comparisonId,
      rootDir: comparisonOutputDir,
      manifestFile,
      lanes: manifestLanes,
      supplementalFiles: [
        { path: traceFile, kind: "interaction-trace", phase: "lane" },
        ...manifestSupplementalFiles
      ]
    });
    return result;
  } catch (error) {
    const failureStatus: "blocked" | "failed" =
      error instanceof InputComparisonOriginError ? "blocked" : "failed";
    manifestLanes.forEach((lane) => {
      if (lane.status !== "completed") lane.status = failureStatus;
    });
    const failure = {
      schemaVersion: "0.1.0",
      comparisonId,
      name: options.name,
      isolation: "separate-dedicated-browser-contexts",
      status: failureStatus,
      targetUrl: options.targetUrl,
      allowedOrigins,
      startedAt,
      finishedAt: new Date().toISOString(),
      traceFile,
      manifestFile,
      diagnostics: [error instanceof Error ? error.message : String(error)]
    };
    assertValidSchema("interactionComparison", failure, "failed pointer and keyboard trace");
    await writeFile(traceFile, JSON.stringify(failure, null, 2), "utf8");
    await writeEvidenceManifest({
      assessmentId: comparisonId,
      rootDir: comparisonOutputDir,
      manifestFile,
      lanes: manifestLanes,
      supplementalFiles: [
        { path: traceFile, kind: "interaction-trace", phase: "lane" },
        ...manifestSupplementalFiles
      ]
    }).catch(() => undefined);
    throw error;
  }
}

async function runInputLane<TPage extends InteractionComparisonPage>(
  options: RunInputComparisonOptions<TPage>,
  comparisonId: string,
  driver: "pointer" | "keyboard",
  actions: InputComparisonAction[],
  allowedOrigins: string[],
  runOutputDir: string,
  createContext: () => Promise<InteractionComparisonContext<TPage>>,
  resolvedStartUrl: string,
  manifestLane: EvidenceManifestLaneSource,
  comparisonOutputDir: string,
  manifestSupplementalFiles: EvidenceManifestSupplementalFile[]
): Promise<InputComparisonLane> {
  const context = await createContext();
  const steps: InputComparisonStep[] = [];
  const videoActions: InteractionVideoActionInput[] = [];
  const videoStartedAt = new Date().toISOString();
  let pageVideo: PlaywrightVideoLike | null | undefined;
  let laneResult: InputComparisonLane | undefined;
  let laneError: unknown;
  manifestLane.status = "failed";

  try {
    const page = await context.newPage();
    pageVideo = page.video?.();
    if (!pageVideo) throw new Error(`Input comparison ${driver} lane did not start video capture.`);
    await page.goto(options.targetUrl, { waitUntil: "domcontentloaded" });
    assertAllowedOrigin(page.url(), allowedOrigins, `Input comparison ${driver} lane`);
    if (page.url() !== resolvedStartUrl) {
      throw new Error(
        `Input comparison ${driver} lane resolved to ${page.url()} instead of the seeded start URL ${resolvedStartUrl}.`
      );
    }
    const observerIds = [
      ...new Set([...INPUT_COMPARISON_OBSERVERS, ...(options.additionalObservers ?? [])])
    ];
    const judgeIds = [
      ...new Set([...INPUT_COMPARISON_JUDGES, ...(options.additionalJudges ?? [])])
    ];

    for (const [index, action] of actions.entries()) {
      const sequence = index + 1;
      const runId = `${comparisonId}-${driver}-${String(sequence).padStart(3, "0")}`;
      const actionStartedAt = new Date().toISOString();
      const manifestAction: EvidenceManifestActionSource = {
        id: action.id,
        sequence,
        runId,
        status: "failed",
        reporterFiles: [],
        artifactFiles: [],
        runDir: path.resolve(options.projectRoot, runOutputDir, runId),
        requiredArtifactBasenames: INPUT_LANE_REQUIRED_ARTIFACTS
      };
      manifestLane.actions.push(manifestAction);
      const result = await runAeeOnPage({
        page,
        projectRoot: options.projectRoot,
        outputDir: runOutputDir,
        runId,
        policy: options.policy,
        observers: observerIds,
        judges: [
          ...new Set([
            ...judgeIds,
            ...(action.kind === "hover" || action.kind === "focus" ? ["focus-management"] : []),
            ...(driver === "keyboard" && action.kind === "press" ? ["keyboard"] : [])
          ])
        ],
        checkpointName: `${driver}:${sequence}:${action.id}`,
        interaction: {
          kind: action.kind === "press" ? interactionKindForKey(action.key!) : action.kind,
          input: action.key,
          actor: "user-script",
          target: action.target,
          meta: {
            source: "user-authored-scenario",
            lane: driver,
            sequence,
            actionId: action.id,
            isolation: "separate-dedicated-browser-contexts",
            ...(action.kind === "hover"
              ? { focusExpectation: "preserve" }
              : action.kind === "focus"
                ? { focusExpectation: "target" }
                : {})
          }
        },
        async performInteraction() {
          await performInputAction(page, action);
          assertAllowedOrigin(page.url(), allowedOrigins, `Input comparison ${driver} lane`);
        }
      });
      const outcome = readLaneStepOutcome(result, "Input comparison");
      videoActions.push({
        id: action.id,
        sequence,
        label: describeInputAction(action),
        startedAt: actionStartedAt,
        finishedAt: new Date().toISOString()
      });
      manifestAction.status = "completed";
      manifestAction.reporterFiles = result.reporterFiles;
      manifestAction.artifactFiles = result.artifactFiles;
      steps.push({
        sequence,
        action,
        runId,
        pageUrl: page.url(),
        results: outcome.results,
        releaseVerdict: outcome.releaseVerdict,
        reporterFiles: result.reporterFiles,
        artifactFiles: result.artifactFiles
      });
    }

    const observation = await captureInputObservation(page, options.observe);
    manifestLane.status = "completed";
    laneResult = { driver, steps, observation, video: undefined as never };
  } catch (error) {
    laneError = error;
  } finally {
    await context.close();
  }

  if (pageVideo) {
    const video = await persistInteractionVideo({
      video: pageVideo,
      rootDir: comparisonOutputDir,
      laneDir: path.join(comparisonOutputDir, driver),
      laneId: manifestLane.id,
      driver,
      status: laneResult
        ? "completed"
        : laneError instanceof InputComparisonOriginError
          ? "blocked"
          : "failed",
      startedAt: videoStartedAt,
      finishedAt: new Date().toISOString(),
      actions: videoActions,
      ...(laneError
        ? { diagnostics: [laneError instanceof Error ? laneError.message : String(laneError)] }
        : {})
    });
    manifestSupplementalFiles.push(
      { path: video.videoFile, laneId: manifestLane.id },
      { path: video.sidecarFile, laneId: manifestLane.id },
      { path: video.captionsFile, laneId: manifestLane.id }
    );
    if (laneResult) laneResult.video = video;
  }
  if (laneError) throw laneError;
  return laneResult!;
}

async function captureInitialStorageState<TPage extends InteractionComparisonPage>(
  browser: InteractionComparisonBrowser<TPage>,
  targetUrl: string,
  allowedOrigins: string[]
): Promise<{ storageState: unknown; resolvedUrl: string; contentHash: string }> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    assertAllowedOrigin(page.url(), allowedOrigins, "Input comparison initial-state seed");
    const storageState = await (
      context as unknown as { storageState(options?: { indexedDB?: boolean }): Promise<unknown> }
    ).storageState({ indexedDB: true });
    return {
      storageState,
      resolvedUrl: page.url(),
      contentHash: `sha256:${createHash("sha256").update(JSON.stringify(storageState)).digest("hex")}`
    };
  } finally {
    await context.close();
  }
}

function matchesInputExpectation(
  observation: InputComparisonObservation,
  expected: InputComparisonExpectation
): boolean {
  return Object.entries(expected).every(([key, expectedValue]) =>
    isDeepStrictEqual(observation[key as keyof InputComparisonObservation], expectedValue)
  );
}

async function performInputAction(
  page: InteractionComparisonPage,
  action: InputComparisonAction
): Promise<void> {
  if (action.kind === "press") {
    await page.keyboard.press(action.key!);
    return;
  }

  const target = resolveInputTarget(page, action.target!);
  if (action.kind === "hover") await target.hover();
  if (action.kind === "click") await target.click();
  if (action.kind === "focus") await target.focus();
}

function describeInputAction(action: InputComparisonAction): string {
  const target = action.target
    ? action.target.selector
      ? ` ${action.target.selector}`
      : ` ${action.target.role} “${action.target.name}”`
    : "";
  return action.kind === "press" ? `Press ${action.key}` : `${action.kind}${target}`;
}

async function captureInputObservation(
  page: InteractionComparisonPage,
  request: InputComparisonObservationRequest
): Promise<InputComparisonObservation> {
  const observation: InputComparisonObservation = {};
  if (request.url) observation.url = page.url();
  const target = request.target ? resolveInputTarget(page, request.target) : undefined;
  if (request.visible) observation.visible = await target!.isVisible();
  if (request.text) observation.text = normalizeObservedText(await target!.textContent());
  if (request.focused) {
    observation.focused = await target!.evaluate(
      (element) => element === element.ownerDocument.activeElement
    );
  }
  if (request.attributes) {
    observation.attributes = Object.fromEntries(
      await Promise.all(
        request.attributes.map(async (name) => [name, await target!.getAttribute(name)] as const)
      )
    );
  }
  return observation;
}

function normalizeObservedText(value: string | null): string | null {
  return value === null ? null : value.replace(/\s+/g, " ").trim();
}

function resolveInputTarget(
  page: InteractionComparisonPage,
  target: InputComparisonTarget
): InteractionLaneLocator {
  if (target.selector) return page.locator(target.selector);
  const rolePage = page as unknown as {
    getByRole(role: string, options: { name: string; exact: boolean }): InteractionLaneLocator;
  };
  return rolePage.getByRole(target.role!, { name: target.name!, exact: target.exact ?? true });
}

function interactionKindForKey(
  key: NonNullable<InputComparisonAction["key"]>
): Interaction["kind"] {
  if (key === "Tab") return "tab";
  if (key === "Shift+Tab") return "shift-tab";
  if (key === "Enter") return "enter";
  if (key === "Space") return "space";
  if (key === "Escape") return "escape";
  return "arrow-key";
}

function validateInputComparisonOptions(
  options: RunInputComparisonOptions<InteractionComparisonPage>
): void {
  if (options.pointerActions.length === 0 || options.keyboardActions.length === 0) {
    throw new Error("An input comparison requires at least one action in each lane.");
  }
  assertValidSchema(
    "interactionComparisonRequest",
    {
      id: options.comparisonId ?? "input-comparison",
      name: options.name,
      pointerActions: options.pointerActions,
      keyboardActions: options.keyboardActions,
      observe: options.observe,
      ...(options.expected ? { expected: options.expected } : {})
    },
    "pointer and keyboard comparison request"
  );
  const invalidPointerKinds = options.pointerActions.filter(
    ({ kind }) => kind !== "hover" && kind !== "click"
  );
  const invalidKeyboardKinds = options.keyboardActions.filter(
    ({ kind }) => kind !== "focus" && kind !== "press"
  );
  if (invalidPointerKinds.length > 0 || invalidKeyboardKinds.length > 0) {
    throw new Error(
      "Pointer lanes accept hover/click; keyboard lanes accept focus/press. Split each physical input into its matching lane."
    );
  }
}

/** Runs user-selected virtual-reader commands in a dedicated browser context. */
export async function runVirtualScreenReaderLane<TPage extends VirtualScreenReaderLanePage>(
  options: RunVirtualScreenReaderLaneOptions<TPage>
): Promise<VirtualScreenReaderLaneResult> {
  if (options.commands.length === 0) {
    throw new Error("A virtual screen-reader lane requires at least one command.");
  }

  const laneId = options.laneId ?? `virtual-reader-${Date.now()}`;
  assertSafeRunId(laneId);
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins);
  assertAllowedOrigin(options.targetUrl, allowedOrigins);
  const outputBase = options.outputDir ?? "aee-output";
  const laneOutputDir = path.resolve(options.projectRoot, outputBase, laneId);
  const runOutputDir = path.join(outputBase, laneId);
  const laneFile = path.join(laneOutputDir, "lane.json");
  const manifestFile = path.join(laneOutputDir, "manifest.json");
  const startedAt = new Date().toISOString();
  const steps: VirtualScreenReaderLaneStep[] = [];
  const observerIds = [
    ...new Set([...VIRTUAL_READER_LANE_OBSERVERS, ...(options.additionalObservers ?? [])])
  ];
  const judgeIds = [
    ...new Set([...VIRTUAL_READER_LANE_JUDGES, ...(options.additionalJudges ?? [])])
  ];
  const manifestLane: EvidenceManifestLaneSource = {
    id: laneId,
    driver: "portable-virtual-screen-reader",
    status: "failed",
    actions: []
  };
  const videoActions: InteractionVideoActionInput[] = [];
  const videoStartedAt = new Date().toISOString();

  await mkdir(laneOutputDir, { recursive: true });
  let browserContext: VirtualScreenReaderLaneContext<TPage> | undefined;
  let pageVideo: PlaywrightVideoLike | null | undefined;
  let transcript: VirtualScreenReaderTranscript | undefined;
  let runError: unknown;

  try {
    browserContext = await options.browser.newContext({
      recordVideo: { dir: laneOutputDir, size: { width: 1280, height: 720 } }
    });
    const page = await browserContext.newPage();
    pageVideo = page.video?.();
    if (!pageVideo) throw new Error("Virtual screen-reader lane did not start video capture.");
    await page.goto(options.targetUrl, { waitUntil: "domcontentloaded" });
    assertAllowedOrigin(page.url(), allowedOrigins);
    const reader = createPortableVirtualScreenReader(page);

    for (const [index, command] of options.commands.entries()) {
      const sequence = index + 1;
      const runId = `${laneId}-${String(sequence).padStart(3, "0")}`;
      const actionStartedAt = new Date().toISOString();
      const manifestAction: EvidenceManifestActionSource = {
        id: `command-${sequence}-${command}`,
        sequence,
        runId,
        status: "failed",
        reporterFiles: [],
        artifactFiles: [],
        runDir: path.resolve(options.projectRoot, runOutputDir, runId),
        requiredArtifactBasenames: VIRTUAL_READER_REQUIRED_ARTIFACTS
      };
      manifestLane.actions.push(manifestAction);
      let entry: VirtualScreenReaderEntry | undefined;
      const result = await runAeeOnPage({
        page,
        projectRoot: options.projectRoot,
        outputDir: runOutputDir,
        runId,
        policy: options.policy,
        virtualScreenReader: reader,
        observers: observerIds,
        judges: judgeIds,
        checkpointName: `${laneId}:${sequence}:${command}`,
        interaction: {
          kind: "screen-reader-command",
          input: command,
          actor: "engine",
          meta: {
            laneId,
            laneSequence: sequence,
            isolation: "dedicated-browser-context"
          }
        },
        async performInteraction() {
          entry = await reader.command(command);
          assertAllowedOrigin(page.url(), allowedOrigins);
        }
      });

      assertAllowedOrigin(page.url(), allowedOrigins);
      if (!entry) {
        throw new Error(`Virtual screen-reader command ${command} produced no transcript entry.`);
      }
      const outcome = readLaneStepOutcome(result);
      videoActions.push({
        id: `command-${sequence}-${command}`,
        sequence,
        label: `Virtual reader: ${command}`,
        startedAt: actionStartedAt,
        finishedAt: new Date().toISOString()
      });
      manifestAction.status = "completed";
      manifestAction.reporterFiles = result.reporterFiles;
      manifestAction.artifactFiles = result.artifactFiles;

      steps.push({
        sequence,
        command,
        runId,
        pageUrl: page.url(),
        entry,
        results: outcome.results,
        releaseVerdict: outcome.releaseVerdict,
        reporterFiles: result.reporterFiles,
        artifactFiles: result.artifactFiles
      });
    }

    transcript = await reader.snapshot();
    assertValidSchema(
      "virtualScreenReaderTranscript",
      transcript,
      "portable virtual screen-reader lane transcript"
    );
    manifestLane.status = "completed";
  } catch (error) {
    runError = error;
  } finally {
    await browserContext?.close();
  }

  const failureStatus: "blocked" | "failed" =
    runError instanceof VirtualScreenReaderOriginError ? "blocked" : "failed";
  const finishedAt = new Date().toISOString();
  let video: InteractionVideoEvidence | undefined;
  if (pageVideo) {
    video = await persistInteractionVideo({
      video: pageVideo,
      rootDir: laneOutputDir,
      laneDir: laneOutputDir,
      laneId,
      driver: "portable-virtual-screen-reader",
      status: runError ? failureStatus : "completed",
      startedAt: videoStartedAt,
      finishedAt,
      actions: videoActions,
      ...(runError
        ? { diagnostics: [runError instanceof Error ? runError.message : String(runError)] }
        : {})
    });
  }

  const videoFiles: EvidenceManifestSupplementalFile[] = video
    ? [
        { path: video.videoFile, laneId },
        { path: video.sidecarFile, laneId },
        { path: video.captionsFile, laneId }
      ]
    : [];
  if (runError) {
    manifestLane.status = failureStatus;
    const laneFailure = {
      schemaVersion: "0.1.0",
      laneId,
      driver: "portable-virtual-screen-reader",
      isolation: "dedicated-browser-context",
      status: failureStatus,
      targetUrl: options.targetUrl,
      allowedOrigins,
      startedAt,
      finishedAt,
      steps,
      laneFile,
      manifestFile,
      ...(video ? { video } : {}),
      diagnostics: [runError instanceof Error ? runError.message : String(runError)]
    };
    assertValidSchema(
      "virtualScreenReaderLane",
      laneFailure,
      "failed virtual screen-reader lane output"
    );
    await writeFile(laneFile, JSON.stringify(laneFailure, null, 2), "utf8");
    await writeEvidenceManifest({
      assessmentId: laneId,
      rootDir: laneOutputDir,
      manifestFile,
      lanes: [manifestLane],
      supplementalFiles: [
        { path: laneFile, kind: "lane-metadata", phase: "lane", laneId },
        ...videoFiles
      ]
    }).catch(() => undefined);
    throw runError;
  }

  if (!transcript || !video) throw new Error("Virtual screen-reader lane evidence is incomplete.");
  const transcriptJsonFile = path.join(laneOutputDir, "transcript.json");
  const transcriptTextFile = path.join(laneOutputDir, "transcript.txt");
  const laneResult: VirtualScreenReaderLaneResult = {
    schemaVersion: "0.1.0",
    laneId,
    driver: "portable-virtual-screen-reader",
    isolation: "dedicated-browser-context",
    status: "completed",
    targetUrl: options.targetUrl,
    allowedOrigins,
    startedAt,
    finishedAt,
    steps,
    transcript,
    laneFile,
    transcriptJsonFile,
    transcriptTextFile,
    manifestFile,
    video
  };
  assertValidSchema("virtualScreenReaderLane", laneResult, "virtual screen-reader lane output");
  await Promise.all([
    writeFile(transcriptJsonFile, JSON.stringify(transcript, null, 2), "utf8"),
    writeFile(transcriptTextFile, renderPortableVirtualScreenReaderTranscript(transcript), "utf8"),
    writeFile(laneFile, JSON.stringify(laneResult, null, 2), "utf8")
  ]);
  await writeEvidenceManifest({
    assessmentId: laneId,
    rootDir: laneOutputDir,
    manifestFile,
    lanes: [manifestLane],
    supplementalFiles: [
      { path: laneFile, kind: "lane-metadata", phase: "lane", laneId },
      { path: transcriptJsonFile, kind: "screen-reader-transcript", phase: "lane", laneId },
      { path: transcriptTextFile, kind: "screen-reader-transcript", phase: "lane", laneId },
      ...videoFiles
    ]
  });
  return laneResult;
}

function normalizeAllowedOrigins(
  origins: string[],
  laneName = "virtual screen-reader lane"
): string[] {
  if (origins.length === 0) {
    throw new Error(`A ${laneName} requires at least one allowed origin.`);
  }

  return [...new Set(origins.map((origin) => new URL(origin).origin))].sort();
}

function assertAllowedOrigin(
  value: string,
  allowedOrigins: string[],
  laneLabel = "Virtual screen-reader lane"
): void {
  const origin = new URL(value).origin;

  if (!allowedOrigins.includes(origin)) {
    const ErrorClass = laneLabel.startsWith("Input comparison")
      ? InputComparisonOriginError
      : VirtualScreenReaderOriginError;
    throw new ErrorClass(
      `${laneLabel} blocked origin ${origin}; allowed origins: ${allowedOrigins.join(", ")}.`
    );
  }
}

class VirtualScreenReaderOriginError extends Error {}
class InputComparisonOriginError extends Error {}

function readLaneStepOutcome(
  result: RunAeeOnPageResult,
  laneLabel = "Virtual screen-reader lane"
): {
  results: RunSummary;
  releaseVerdict: JudgmentVerdict;
} {
  const jsonReport = result.reportArtifacts.find(({ label }) => label === "aee-report.json");

  if (!jsonReport) {
    throw new Error(`${laneLabel} could not find the action JSON report.`);
  }

  const parsed = JSON.parse(jsonReport.content) as {
    run?: { results?: Partial<RunSummary> };
    judgments?: Array<{ judgeId?: unknown; verdict?: unknown }>;
  };
  const results = parsed.run?.results;
  const releaseVerdict = parsed.judgments?.find(({ judgeId }) => judgeId === "release")?.verdict;

  if (
    typeof results?.pass !== "number" ||
    typeof results.fail !== "number" ||
    typeof results.unknown !== "number" ||
    !["pass", "fail", "unknown"].includes(String(releaseVerdict))
  ) {
    throw new Error(`${laneLabel} action report did not contain a valid outcome.`);
  }

  return {
    results: {
      pass: results.pass,
      fail: results.fail,
      unknown: results.unknown
    },
    releaseVerdict: releaseVerdict as JudgmentVerdict
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
  page: PlaywrightPageLike,
  virtualScreenReader?: PortableVirtualScreenReader
): Promise<RuntimeObserverContext["page"]> {
  const cdpPage = page as CdpEnabledPageLike;
  const evaluatablePage = page as EvaluatablePageLike;
  const eventedPage = page as EventedPageLike;
  const customScreenshot = page.snapshotScreenshot?.bind(page);
  const customRunAxeAnalysis = page.runAxeAnalysis?.bind(page);
  const rawSnapshotVirtualScreenReaderTranscript = virtualScreenReader
    ? async () => virtualScreenReader.snapshot()
    : page.snapshotVirtualScreenReaderTranscript?.bind(page);
  const snapshotVirtualScreenReaderTranscript = rawSnapshotVirtualScreenReaderTranscript
    ? async () => {
        const transcript = await rawSnapshotVirtualScreenReaderTranscript();
        assertValidSchema(
          "virtualScreenReaderTranscript",
          transcript,
          "portable virtual screen-reader transcript"
        );
        return transcript;
      }
    : undefined;
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
      ? async () => {
          const domFocus = await evaluatablePage.evaluate?.(() => {
            const globalRef = globalThis as unknown as {
              document?: {
                activeElement?: unknown;
                getElementById?: (id: string) => unknown;
                querySelectorAll?: (selector: string) => Iterable<unknown>;
              };
              getComputedStyle?: (element: unknown) => {
                display?: string;
                visibility?: string;
                outlineColor?: string;
                outlineStyle?: string;
                outlineWidth?: string;
                boxShadow?: string;
              };
            };
            const documentRef = globalRef.document;
            const documentActiveElement = documentRef?.activeElement as
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
                  matches?: (selector: string) => boolean;
                  shadowRoot?: { activeElement?: unknown };
                  contentDocument?: { activeElement?: unknown };
                }
              | undefined;

            if (!documentActiveElement) {
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
              matches?: (selector: string) => boolean;
              shadowRoot?: { activeElement?: unknown };
              contentDocument?: { activeElement?: unknown };
            } => typeof value === "object" && value !== null;
            const activeElementSources: Array<{
              context: "document" | "shadow-root" | "iframe-document";
              element: typeof documentActiveElement;
            }> = [{ context: "document", element: documentActiveElement }];
            let activeElement = documentActiveElement;

            while (activeElement) {
              const shadowActive = activeElement.shadowRoot?.activeElement;
              const frameActive = activeElement.contentDocument?.activeElement;
              const nextActive = isElementLike(shadowActive)
                ? { context: "shadow-root" as const, element: shadowActive }
                : isElementLike(frameActive)
                  ? { context: "iframe-document" as const, element: frameActive }
                  : undefined;

              if (!nextActive || nextActive.element === activeElement) break;
              activeElementSources.push(nextActive);
              activeElement = nextActive.element;
            }
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

                current = isElementLike(current.parentElement) ? current.parentElement : undefined;
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
            const getDialogContext = (
              element:
                | {
                    tagName?: unknown;
                    id?: unknown;
                    textContent?: unknown;
                    parentElement?: unknown;
                    getAttribute?: (name: string) => string | null;
                  }
                | undefined
            ) => {
              let current = element;

              while (isElementLike(current)) {
                const currentRole = current.getAttribute?.("role");
                const currentTagName =
                  typeof current.tagName === "string" ? current.tagName.toLowerCase() : undefined;

                if (
                  currentTagName === "dialog" ||
                  currentRole === "dialog" ||
                  currentRole === "alertdialog"
                ) {
                  const labelledById = current.getAttribute?.("aria-labelledby");
                  const labelledBy = labelledById
                    ? documentRef?.getElementById?.(labelledById)
                    : undefined;
                  const labelledByText =
                    isElementLike(labelledBy) && typeof labelledBy.textContent === "string"
                      ? labelledBy.textContent.trim()
                      : undefined;
                  const ownText =
                    typeof current.textContent === "string"
                      ? current.textContent.trim().slice(0, 120)
                      : undefined;

                  return {
                    tagName: currentTagName,
                    id:
                      typeof current.id === "string" && current.id.length > 0
                        ? current.id
                        : undefined,
                    role: currentRole ?? (currentTagName === "dialog" ? "dialog" : undefined),
                    name:
                      current.getAttribute?.("aria-label") ??
                      (labelledByText && labelledByText.length > 0 ? labelledByText : ownText),
                    ariaModal: getBooleanAttribute(current, "aria-modal")
                  };
                }

                current = isElementLike(current.parentElement) ? current.parentElement : undefined;
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
              matches?: (selector: string) => boolean;
              shadowRoot?: { activeElement?: unknown };
              contentDocument?: { activeElement?: unknown };
            }) => {
              const tagName =
                typeof element.tagName === "string" ? element.tagName.toLowerCase() : undefined;
              const role = element.getAttribute?.("role") ?? getImplicitRole(element, tagName);
              const id =
                typeof element.id === "string" && element.id.length > 0 ? element.id : undefined;
              const canUseTextAsName =
                Boolean(role) ||
                ["a", "button", "label", "option", "summary", "td", "th"].includes(tagName ?? "");
              const name =
                element.getAttribute?.("aria-label") ??
                element.getAttribute?.("name") ??
                (canUseTextAsName &&
                typeof element.textContent === "string" &&
                element.textContent.trim().length > 0
                  ? element.textContent.trim().slice(0, 120)
                  : undefined);
              const type =
                typeof element.type === "string" && element.type.length > 0
                  ? element.type
                  : undefined;
              const focusOrderIndex = focusableElements.indexOf(element);
              const tabIndex = typeof element.tabIndex === "number" ? element.tabIndex : undefined;
              const disabled = typeof element.disabled === "boolean" ? element.disabled : undefined;
              const style = globalRef.getComputedStyle?.(element);
              let focusVisible: boolean;
              try {
                focusVisible = element.matches?.(":focus-visible") ?? false;
              } catch {
                focusVisible = false;
              }
              const outlineVisible =
                style?.outlineStyle !== undefined &&
                style.outlineStyle !== "none" &&
                style.outlineWidth !== "0px";
              const shadowVisible = style?.boxShadow !== undefined && style.boxShadow !== "none";
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
                nodePath: getElementNodePath(element),
                focusVisible,
                focusIndicator: {
                  visible: focusVisible && (outlineVisible || shadowVisible),
                  outlineColor: style?.outlineColor,
                  outlineStyle: style?.outlineStyle,
                  outlineWidth: style?.outlineWidth,
                  boxShadow: style?.boxShadow
                },
                ariaSelected: getBooleanAttribute(element, "aria-selected"),
                ariaChecked: getBooleanAttribute(element, "aria-checked"),
                compositeRole: compositeContext.compositeRole,
                compositeOrientation: compositeContext.compositeRole
                  ? (compositeContext.compositeElement?.getAttribute?.("aria-orientation") ??
                    (compositeContext.compositeRole === "tablist" ||
                    compositeContext.compositeRole === "menubar"
                      ? "horizontal"
                      : "vertical"))
                  : undefined,
                compositeItemIndex: compositeItemIndex >= 0 ? compositeItemIndex : undefined,
                compositeItemCount: compositeItems.length > 0 ? compositeItems.length : undefined,
                dialogContext: getDialogContext(element),
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
            const documentActiveElementSummary = getElementSummary(documentActiveElement);

            return {
              schemaVersion: "0.1.0",
              captureType: "deep-focus-state",
              ...activeElementSummary,
              documentActiveElement: documentActiveElementSummary,
              deepActiveElement: activeElementSummary,
              activeElementChain: activeElementSources.map(({ context, element }) => ({
                context,
                ...getElementSummary(element)
              })),
              activeDescendantId,
              activeDescendant
            };

            function getElementNodePath(element: {
              tagName?: unknown;
              id?: unknown;
              parentElement?: unknown;
            }): string | undefined {
              const segments: string[] = [];
              let current: unknown = element;

              while (isElementLike(current)) {
                const tagName =
                  typeof current.tagName === "string" ? current.tagName.toLowerCase() : "element";
                const id = typeof current.id === "string" && current.id ? `#${current.id}` : "";
                segments.unshift(`${tagName}${id}`);
                if (id) break;
                current = current.parentElement;
              }

              return segments.length > 0 ? segments.join(" > ") : undefined;
            }

            function getImplicitRole(
              element: {
                type?: unknown;
                getAttribute?: (name: string) => string | null;
              },
              tagName: string | undefined
            ): string | undefined {
              if (tagName === "a" && element.getAttribute?.("href")) return "link";
              if (tagName === "button" || tagName === "summary") return "button";
              if (tagName === "textarea") return "textbox";
              if (tagName === "select")
                return element.getAttribute?.("multiple") !== null ? "listbox" : "combobox";
              if (tagName !== "input") return undefined;
              const type = typeof element.type === "string" ? element.type.toLowerCase() : "text";
              if (type === "checkbox") return "checkbox";
              if (type === "radio") return "radio";
              if (["button", "image", "reset", "submit"].includes(type)) return "button";
              if (type === "range") return "slider";
              if (type === "number") return "spinbutton";
              if (["email", "search", "tel", "text", "url"].includes(type)) return "textbox";
              return undefined;
            }
          });
          const accessibilityFocus = cdpPage.context
            ? await captureAccessibilityFocus(cdpPage.context(), page)
            : { status: "unsupported" as const };

          const focusState =
            typeof domFocus === "object" && domFocus !== null
              ? { ...domFocus, accessibilityFocus }
              : domFocus;
          if (
            typeof focusState === "object" &&
            focusState !== null &&
            "captureType" in focusState
          ) {
            assertValidSchema("focusState", focusState, "deep focus state");
          }
          return focusState;
        }
      : undefined;
  const snapshotScreenshot = customScreenshot
    ? async (options?: { fullPage?: boolean }) => customScreenshot(options)
    : nativeScreenshot
      ? async (options?: { fullPage?: boolean }) => {
          const value = await nativeScreenshot({
            type: "png",
            fullPage: options?.fullPage ?? false
          });

          if (value instanceof Uint8Array) {
            return value;
          }

          throw new Error("Screenshot API returned a non-binary payload.");
        }
      : undefined;
  const runAxeAnalysis = customRunAxeAnalysis
    ? async (options: { tags: string[] }) => customRunAxeAnalysis(options)
    : evaluatablePage.evaluate
      ? async (options: { tags: string[] }) =>
          new AxeBuilder({
            page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"]
          })
            .withTags(options.tags)
            .analyze()
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
    runAxeAnalysis,
    snapshotVirtualScreenReaderTranscript,
    setupNetworkTracking,
    snapshotNetworkLog,
    teardownNetworkTracking
  };
}

async function captureAccessibilityFocus(
  context: CdpContextLike | undefined,
  page: PlaywrightPageLike
): Promise<Record<string, unknown>> {
  if (!context) return { status: "unsupported" };
  const session = await context.newCDPSession(page);

  try {
    const response = await session.send("Accessibility.getFullAXTree");
    const nodes = getRecordArrayField(response, "nodes");
    const focusedNodes = nodes.filter((node) =>
      getRecordArrayField(node, "properties").some(
        (property) =>
          property.name === "focused" && getNestedRecordValue(property, "value", "value") === true
      )
    );
    const focusedNode =
      focusedNodes.find(
        (node) =>
          !["RootWebArea", "WebArea"].includes(String(getNestedRecordValue(node, "role", "value")))
      ) ?? focusedNodes.at(-1);

    if (!focusedNode) return { status: "not-exposed" };
    return {
      status: "matched",
      nodeId: getStringField(focusedNode, "nodeId"),
      backendDOMNodeId:
        typeof focusedNode.backendDOMNodeId === "number" ? focusedNode.backendDOMNodeId : undefined,
      role: getNestedRecordValue(focusedNode, "role", "value"),
      name: getNestedRecordValue(focusedNode, "name", "value")
    };
  } catch (error) {
    return {
      status: "failed",
      diagnostics: [
        error instanceof Error
          ? `Accessibility focus capture failed: ${error.message}`
          : "Accessibility focus capture failed."
      ]
    };
  } finally {
    await session.detach?.();
  }
}

function getRecordArrayField(value: unknown, field: string): Array<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) return [];
  const candidate = (value as Record<string, unknown>)[field];
  return Array.isArray(candidate)
    ? candidate.filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null
      )
    : [];
}

function getNestedRecordValue(
  value: Record<string, unknown>,
  field: string,
  nestedField: string
): unknown {
  const nested = value[field];
  return typeof nested === "object" && nested !== null
    ? (nested as Record<string, unknown>)[nestedField]
    : undefined;
}

function getStringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === "string" ? value[field] : undefined;
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
