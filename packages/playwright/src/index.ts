import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import AxeBuilder from "@axe-core/playwright";
import axe from "axe-core";
import {
  executeRun,
  redactUrl,
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
import {
  createDefaultObserverPlugins,
  type AxeAnalysisOptions,
  type RuntimeObserverContext
} from "@aee/observers";
import { createJsonReporter, createMarkdownReporter } from "@aee/reporter";
import { assertValidSchema, conceptForAxeRule } from "@aee/schemas";

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
  fetchAccessibilityTree,
  withPageSessions,
  type CdpContext,
  type FramedPage,
  type PageSessions
} from "./accessibility-tree";
import { captureDomFocus } from "./dom-focus";
import { captureElementMap } from "./element-map";
import { settleContrastByPixels, type ContrastMeasuringPage } from "./contrast-measurement";
import { reportsRequests, trackOpenRequests, waitForQuietPage } from "./quiet-page";
import { describeElementContexts } from "./element-context";
import {
  locateElements,
  type ElementLocation,
  type ElementLocationPage
} from "./element-locations";
import {
  sweepKeyboardAndPointer,
  type KeyboardPointerSweepPage,
  type ObservedPresses,
  type SweepFinding,
  type SweepStep,
  type SweepTabStop
} from "./keyboard-pointer-sweep";
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
export * from "./accessibility-tree";
export * from "./contrast-measurement";
export * from "./element-context";
export * from "./element-locations";
export * from "./element-map";
export * from "./evidence-manifest";
export * from "./focus-accessibility";
export * from "./heading-lookalikes";
export * from "./interaction-video";
export * from "./keyboard-pointer-sweep";
export * from "./pointer-keyboard-comparison";
export * from "./virtual-screen-reader";

export interface PlaywrightPageLike {
  url(): string;
  content(): Promise<string>;
  title?(): Promise<string>;
  screenshot?(options?: unknown): Promise<unknown>;
  snapshotAccessibilityTree?(options?: unknown): Promise<unknown>;
  snapshotFocusTarget?(options?: unknown): Promise<unknown>;
  snapshotScreenshot?(options?: { fullPage?: boolean }): Promise<Uint8Array>;
  runAxeAnalysis?(options: AxeAnalysisOptions): Promise<unknown>;
  setupNetworkTracking?(options?: unknown): Promise<void>;
  snapshotNetworkLog?(options?: unknown): Promise<unknown>;
  teardownNetworkTracking?(options?: unknown): Promise<void>;
  snapshotVirtualScreenReaderTranscript?(): Promise<unknown>;
  video?(): PlaywrightVideoLike | null;
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
  /**
   * The interaction only reads the page, as a portable virtual-reader command does: the page is
   * captured once, after it, and not waited on to settle, since nothing on it changed.
   */
  interactionReadsOnly?: boolean;
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

/**
 * Where a lane runs: in browser contexts of its own, recorded and closed when it ends, or on the
 * page a test already drives, which keeps the test's session, routes and storage and records nothing.
 */
export type LaneIsolation = "dedicated-browser-context" | "test-page";

/** A lane's own browser, or the page a test drives; never both. */
export type LaneTarget<TBrowser, TPage> =
  { browser: TBrowser; page?: undefined } | { page: TPage; browser?: undefined };

export type RunVirtualScreenReaderLaneOptions<TPage extends VirtualScreenReaderLanePage> =
  LaneTarget<VirtualScreenReaderLaneBrowser<TPage>, TPage> & {
    projectRoot: string;
    targetUrl: string;
    allowedOrigins: string[];
    commands: VirtualScreenReaderCommand[];
    /**
     * Stop at the end of the page: after the first command, one that would find nothing to move to
     * ends the lane instead of running.
     */
    stopAtEnd?: boolean;
    outputDir?: string;
    laneId?: string;
    policy?: AeePolicyOverrides;
    additionalObservers?: string[];
    additionalJudges?: string[];
  };

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
  isolation: LaneIsolation;
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

export interface KeyboardPointerSweepLaneRoute {
  request(): { url(): string; isNavigationRequest(): boolean };
  fallback(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

export type KeyboardPointerSweepLaneRouteHandler = (
  route: KeyboardPointerSweepLaneRoute
) => Promise<void>;

/** Where the sweep's navigation guard is set: a lane's own context, or a test's page. */
export interface KeyboardPointerSweepLaneRouter {
  route(url: string, handler: KeyboardPointerSweepLaneRouteHandler): Promise<unknown>;
  unroute(url: string, handler: KeyboardPointerSweepLaneRouteHandler): Promise<unknown>;
}

export interface KeyboardPointerSweepLanePage
  extends KeyboardPointerSweepPage, KeyboardPointerSweepLaneRouter {
  video?(): PlaywrightVideoLike | null;
}

export interface KeyboardPointerSweepLaneContext<
  TPage extends KeyboardPointerSweepLanePage
> extends KeyboardPointerSweepLaneRouter {
  newPage(): Promise<TPage>;
  close(): Promise<void>;
}

export interface KeyboardPointerSweepLaneBrowser<TPage extends KeyboardPointerSweepLanePage> {
  newContext(options?: LaneBrowserContextOptions): Promise<KeyboardPointerSweepLaneContext<TPage>>;
}

export type RunKeyboardPointerSweepLaneOptions<TPage extends KeyboardPointerSweepLanePage> =
  LaneTarget<KeyboardPointerSweepLaneBrowser<TPage>, TPage> & {
    projectRoot: string;
    targetUrl: string;
    allowedOrigins: string[];
    /** Passed to the sweep: press on-page controls, never links or form submits. */
    activateControls: boolean;
    outputDir?: string;
    laneId?: string;
  };

export interface KeyboardPointerSweepLaneFinding extends SweepFinding {
  /** Where the element is on the lane's full-page screenshot, or on `screenshot` when it has one. */
  targetBox?: ElementLocation;
  /**
   * The full-page screenshot, beside the record, of the page as a press the test made left it,
   * for a finding of that press; the lane has no screenshot of its own.
   */
  screenshot?: string;
}

export interface KeyboardPointerSweepLaneTabStop extends Omit<SweepTabStop, "focusedCrop"> {
  /** Where the stop is on the lane's full-page screenshot. */
  targetBox?: ElementLocation;
  /** The file, beside this record, showing the stop with keyboard focus. */
  focusCrop?: string;
}

/** The evidence file a sweep lane writes; it carries no local file paths. */
export interface KeyboardPointerSweepLaneDocument {
  schemaVersion: "0.2.0";
  laneId: string;
  driver: "keyboard-pointer-sweep";
  isolation: LaneIsolation;
  status: "completed" | "blocked" | "failed";
  targetUrl: string;
  allowedOrigins: string[];
  activateControls: boolean;
  /**
   * Who pressed the controls in `activated`: the sweep (the default), or the test itself, whose
   * presses AEE only watched (see observePresses); such a record has no Tab stops.
   */
  pressedBy?: "sweep" | "test";
  startedAt: string;
  finishedAt: string;
  /** Navigations outside the allowed origins, stopped before they left the page. */
  blockedNavigations: string[];
  tabStops?: KeyboardPointerSweepLaneTabStop[];
  activated?: string[];
  findings?: KeyboardPointerSweepLaneFinding[];
  diagnostics?: string[];
}

export interface KeyboardPointerSweepLaneResult extends KeyboardPointerSweepLaneDocument {
  status: "completed";
  tabStops: KeyboardPointerSweepLaneTabStop[];
  activated: string[];
  findings: KeyboardPointerSweepLaneFinding[];
  sweepFile: string;
  screenshotFile: string;
  manifestFile: string;
  /** The recording of the sweep, captioned step by step. */
  video?: InteractionVideoEvidence;
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

    // The element map is read from the accessibility tree, so it carries the same names.
    if (observerId === "accessibility-tree" || observerId === "element-map") {
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
            options.interactionReadsOnly ? 0 : resolvedPolicy.capture.stabilizeAfterInteractionMs,
            performInteraction,
            {
              page: options.page,
              runId,
              checkpoint,
              interaction
            }
          )
      : undefined,
    interactionReadsOnly: options.interactionReadsOnly,
    // The watch tells a live region the page updates on its own from one the press updates; with
    // the reader not listening, no announcement is judged and there is nothing to tell apart.
    ...(selectedObservers.includes("virtual-screen-reader")
      ? { watchWithoutInputMs: resolvedPolicy.capture.watchWithoutInputMs }
      : {}),
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

/** Every lane records at this size, so recordings of one run line up. */
const LANE_VIDEO_SIZE = { width: 1280, height: 720 };

const VIRTUAL_READER_LANE_OBSERVERS = [
  "focus",
  "dom",
  "accessibility-tree",
  "visual",
  "element-map",
  "axe",
  "virtual-screen-reader"
];

const VIRTUAL_READER_LANE_JUDGES = ["screen-reader", "axe", "release"];

const INPUT_COMPARISON_OBSERVERS = [
  "focus",
  "dom",
  "accessibility-tree",
  "visual",
  "element-map",
  "axe"
];
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
/** A checkpoint performs no interaction, so it is captured once, as it is. */
const CHECKPOINT_REQUIRED_ARTIFACTS = INPUT_LANE_REQUIRED_ARTIFACTS.filter(
  (basename) => !basename.includes("-before.")
);

/** A reader command only reads the page, so it is captured once, after it, like a checkpoint. */
const VIRTUAL_READER_REQUIRED_ARTIFACTS = [
  ...CHECKPOINT_REQUIRED_ARTIFACTS,
  "virtual-screen-reader-transcript-json-after.json",
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
      id: inputComparisonLaneId(comparisonId, "pointer"),
      driver: "pointer",
      status: "blocked",
      actions: []
    },
    {
      id: inputComparisonLaneId(comparisonId, "keyboard"),
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
          size: LANE_VIDEO_SIZE
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
    // A key press can answer only with a status message (WCAG 4.1.3), which a screen reader hears
    // from a live region. Guidepup's reader listens through each press, so the keyboard judge
    // counts what it announced.
    const readerPage =
      driver === "keyboard" ? framedCdpPage(page as typeof page & CdpEnabledPageLike) : undefined;
    const pressListener = readerPage ? createPortableVirtualScreenReader(readerPage) : undefined;

    for (const [index, action] of actions.entries()) {
      const sequence = index + 1;
      const runId = actionRunId(inputComparisonLaneId(comparisonId, driver), sequence);
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
      const listensToPress = Boolean(pressListener) && action.kind === "press";
      const result = await runAeeOnPage({
        page,
        projectRoot: options.projectRoot,
        outputDir: runOutputDir,
        runId,
        policy: options.policy,
        observers: listensToPress ? [...observerIds, "virtual-screen-reader"] : observerIds,
        ...(listensToPress ? { virtualScreenReader: pressListener } : {}),
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
  const isolation: LaneIsolation = options.page ? "test-page" : "dedicated-browser-context";
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
    // On a test's page the reader keeps the test's session, routes and storage, and records nothing.
    let page: TPage;
    if (options.browser) {
      browserContext = await options.browser.newContext({
        recordVideo: { dir: laneOutputDir, size: LANE_VIDEO_SIZE }
      });
      page = await browserContext.newPage();
      pageVideo = page.video?.();
      if (!pageVideo) throw new Error("Virtual screen-reader lane did not start video capture.");
    } else {
      page = options.page;
    }
    await page.goto(options.targetUrl, { waitUntil: "domcontentloaded" });
    assertAllowedOrigin(page.url(), allowedOrigins);
    const reader = createPortableVirtualScreenReader(page);

    for (const [index, command] of options.commands.entries()) {
      if (options.stopAtEnd && index > 0 && !(await reader.peek(command))) break;
      const sequence = index + 1;
      const runId = actionRunId(laneId, sequence);
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
        // The portable reader never focuses, clicks, types or dispatches events.
        interactionReadsOnly: true,
        interaction: {
          kind: "screen-reader-command",
          input: command,
          actor: "engine",
          meta: {
            laneId,
            laneSequence: sequence,
            isolation
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
      isolation,
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

  if (!transcript || (options.browser && !video)) {
    throw new Error("Virtual screen-reader lane evidence is incomplete.");
  }
  const transcriptJsonFile = path.join(laneOutputDir, "transcript.json");
  const transcriptTextFile = path.join(laneOutputDir, "transcript.txt");
  const laneResult: VirtualScreenReaderLaneResult = {
    schemaVersion: "0.1.0",
    laneId,
    driver: "portable-virtual-screen-reader",
    isolation,
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

/**
 * Words as a lower-case, hyphenated id of at most 60 characters, for file and action names;
 * `fallback` when no words are left. Joining the words, rather than trimming hyphens with an
 * anchored regex, keeps it linear however many hyphens the text has.
 */
export function toSafeId(text: string, fallback = "item"): string {
  const id = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join("-")
    .slice(0, 60);
  return (id.endsWith("-") ? id.slice(0, -1) : id) || fallback;
}

/** Who loads the page a checkpoint lane observes: a Playwright test, or AEE opening a start page. */
export type PageCheckpointDriver = "playwright-test" | "page-load";

export interface PageCheckpointLaneOptions<TPage extends PlaywrightPageLike> {
  /** The page a test is driving; checkpoints observe it and never act on it. */
  page: TPage;
  projectRoot: string;
  outputDir?: string;
  laneId?: string;
  /** Defaults to a Playwright test. */
  driver?: PageCheckpointDriver;
}

export interface PageCheckpointStep {
  sequence: number;
  actionId: string;
  name: string;
  runId: string;
  pageUrl: string;
  results: RunSummary;
  releaseVerdict: JudgmentVerdict;
  reporterFiles: string[];
  artifactFiles: string[];
}

export interface PageCheckpointLaneResult {
  laneId: string;
  driver: PageCheckpointDriver;
  steps: PageCheckpointStep[];
  diagnostics: string[];
  manifestFile: string;
}

export interface PageCheckpointLane {
  laneId: string;
  /** Captures the page as it is now; checkpoints run one at a time, in the order asked. */
  checkpoint(name: string): Promise<void>;
  /** Waits for every checkpoint, then writes the lane's evidence manifest. */
  finish(): Promise<PageCheckpointLaneResult>;
}

/**
 * Checkpoints a page that something else drives, such as a Playwright test: each checkpoint runs
 * the same observers and judges as an input-comparison step, with no interaction of its own. A
 * checkpoint that fails, for example because the test navigated while it ran, is recorded as a
 * diagnostic and a failed action, so the report cannot read as complete.
 */
export function startPageCheckpointLane<TPage extends PlaywrightPageLike>(
  options: PageCheckpointLaneOptions<TPage>
): PageCheckpointLane {
  const laneId = options.laneId ?? `page-checkpoints-${Date.now()}`;
  assertSafeRunId(laneId);
  const outputBase = options.outputDir ?? "aee-output";
  const laneOutputDir = path.resolve(options.projectRoot, outputBase, laneId);
  const runOutputDir = path.join(outputBase, laneId);
  const driver = options.driver ?? "playwright-test";
  const manifestLane: EvidenceManifestLaneSource = {
    id: laneId,
    driver,
    status: "completed",
    actions: []
  };
  const steps: PageCheckpointStep[] = [];
  const diagnostics: string[] = [];
  let queue = Promise.resolve();
  // Counted from before the test loads a page, so a checkpoint waits for the data it loads.
  const openRequests = reportsRequests(options.page) ? trackOpenRequests(options.page) : undefined;

  const capture = async (name: string) => {
    const sequence = manifestLane.actions.length + 1;
    const runId = actionRunId(laneId, sequence);
    const actionId = `checkpoint-${sequence}-${toSafeId(name)}`;
    const manifestAction: EvidenceManifestActionSource = {
      id: actionId,
      sequence,
      runId,
      status: "failed",
      reporterFiles: [],
      artifactFiles: [],
      runDir: path.resolve(options.projectRoot, runOutputDir, runId),
      requiredArtifactBasenames: CHECKPOINT_REQUIRED_ARTIFACTS
    };
    manifestLane.actions.push(manifestAction);
    // The checkpoint captures what a person sees once the app has drawn the page.
    await waitForQuietPage(options.page as EvaluatablePageLike, openRequests);
    const pageUrl = options.page.url();
    try {
      const result = await runAeeOnPage({
        page: options.page,
        projectRoot: options.projectRoot,
        outputDir: runOutputDir,
        runId,
        observers: INPUT_COMPARISON_OBSERVERS,
        judges: INPUT_COMPARISON_JUDGES,
        checkpointName: `${laneId}:${sequence}:${name}`,
        interaction: {
          kind: "custom",
          actor: "test",
          meta: { laneId, laneSequence: sequence, checkpoint: name }
        }
      });
      const outcome = readLaneStepOutcome(result, "Page checkpoint");
      manifestAction.status = "completed";
      manifestAction.reporterFiles = result.reporterFiles;
      manifestAction.artifactFiles = result.artifactFiles;
      steps.push({
        sequence,
        actionId,
        name,
        runId,
        pageUrl,
        results: outcome.results,
        releaseVerdict: outcome.releaseVerdict,
        reporterFiles: result.reporterFiles,
        artifactFiles: result.artifactFiles
      });
    } catch (error) {
      diagnostics.push(
        `${laneId}: checkpoint "${name}" at ${pageUrl} did not finish: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  };

  return {
    laneId,
    checkpoint(name) {
      const run = queue.then(() => capture(name));
      queue = run;
      return run;
    },
    async finish() {
      await queue;
      openRequests?.stop();
      await mkdir(laneOutputDir, { recursive: true });
      const { manifestFile } = await writeEvidenceManifest({
        assessmentId: laneId,
        rootDir: laneOutputDir,
        lanes: [manifestLane]
      });
      return { laneId, driver, steps, diagnostics, manifestFile };
    }
  };
}

export interface StartPageLanePage extends PlaywrightPageLike {
  goto(url: string, options?: { waitUntil?: "domcontentloaded" }): Promise<unknown>;
}

export interface StartPageLaneContext<
  TPage extends StartPageLanePage
> extends KeyboardPointerSweepLaneRouter {
  newPage(): Promise<TPage>;
  close(): Promise<void>;
}

export interface StartPageLaneBrowser<TPage extends StartPageLanePage> {
  newContext(options?: LaneBrowserContextOptions): Promise<StartPageLaneContext<TPage>>;
}

export interface RunStartPageLaneOptions<TPage extends StartPageLanePage> {
  browser: StartPageLaneBrowser<TPage>;
  projectRoot: string;
  targetUrl: string;
  allowedOrigins: string[];
  outputDir?: string;
  laneId?: string;
}

export interface StartPageLaneResult extends PageCheckpointLaneResult {
  /** Navigations the lane stopped because they left the allowed origins. */
  blockedNavigations: string[];
}

/**
 * Opens a start page in a browser context of its own and checkpoints it once, before anything acts
 * on it: the evidence and pinned axe rules a scenario's plan runs on every journey's start page,
 * whatever else the journey declares. Every navigation outside the allowed origins is stopped.
 */
export async function runStartPageLane<TPage extends StartPageLanePage>(
  options: RunStartPageLaneOptions<TPage>
): Promise<StartPageLaneResult> {
  const laneId = options.laneId ?? `start-page-${Date.now()}`;
  assertSafeRunId(laneId);
  const allowedOrigins = normalizeAllowedOrigins(options.allowedOrigins, "start-page lane");
  assertAllowedOrigin(options.targetUrl, allowedOrigins, "Start-page lane");
  const blockedNavigations: string[] = [];
  const context = await options.browser.newContext();
  try {
    await context.route("**/*", navigationGuard(allowedOrigins, blockedNavigations));
    const page = await context.newPage();
    // Started before the load, so the checkpoint waits for the data the page loads.
    const lane = startPageCheckpointLane({
      page,
      projectRoot: options.projectRoot,
      outputDir: options.outputDir,
      laneId,
      driver: "page-load"
    });
    await page.goto(options.targetUrl, { waitUntil: "domcontentloaded" });
    assertAllowedOrigin(page.url(), allowedOrigins, "Start-page lane");
    await lane.checkpoint("start page");
    return { ...(await lane.finish()), blockedNavigations };
  } finally {
    await context.close();
  }
}

/**
 * Stops every navigation that leaves the allowed origins, including one a pressed control starts,
 * and hands every other request on, to a test's own routes when the sweep runs on its page.
 */
function navigationGuard(
  allowedOrigins: string[],
  blockedNavigations: string[]
): KeyboardPointerSweepLaneRouteHandler {
  return async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && !allowedOrigins.includes(new URL(request.url()).origin)) {
      blockedNavigations.push(request.url());
      await route.abort("blockedbyclient");
    } else {
      await route.fallback();
    }
  };
}

/**
 * The pages a sweep lane drives, with its navigation guard set. On its own browser the lane sweeps
 * in a recorded context and takes its stills in a second, unrecorded one: a full-page capture
 * redraws the page at another size, and the recording keeps that frame until the page next
 * changes, which can be the end of the video. On a test's page it does both there, and takes its
 * guard off again when it closes.
 */
async function openSweepPages<TPage extends KeyboardPointerSweepLanePage>(
  target: LaneTarget<KeyboardPointerSweepLaneBrowser<TPage>, TPage>,
  laneOutputDir: string,
  guard: KeyboardPointerSweepLaneRouteHandler
): Promise<{
  page: TPage;
  still: TPage;
  video?: PlaywrightVideoLike | null;
  close(): Promise<void>;
}> {
  if (!target.browser) {
    const { page } = target;
    await page.route("**/*", guard);
    return {
      page,
      still: page,
      close: async () => {
        await page.unroute("**/*", guard);
      }
    };
  }
  const recorded = await target.browser.newContext({
    recordVideo: { dir: laneOutputDir, size: LANE_VIDEO_SIZE }
  });
  const unrecorded = await target.browser.newContext();
  const close = async () => {
    await recorded.close();
    await unrecorded.close();
  };
  try {
    for (const context of [recorded, unrecorded]) await context.route("**/*", guard);
    const page = await recorded.newPage();
    return { page, still: await unrecorded.newPage(), video: page.video?.(), close };
  } catch (error) {
    await close();
    throw error;
  }
}

/**
 * Sweeps one page by keyboard and pointer in its own recorded browser context, then records the
 * result, and, from a fresh load in an unrecorded context, a full-page screenshot and where each
 * finding is on it. Given a test's page instead, it does both on that page, from a fresh load of
 * the target, so the sweep keeps the test's session, routes and storage. Every navigation is
 * stopped unless it stays inside the allowed origins.
 */
/**
 * Records the presses a test made, as observePresses watched them, as a sweep lane of their own:
 * so its findings are reported like the sweep's, whether or not the sweep ran in this test.
 */
export async function writeObservedPressesLane(options: {
  projectRoot: string;
  outputDir?: string;
  laneId: string;
  targetUrl: string;
  startedAt: string;
  observed: ObservedPresses;
}): Promise<KeyboardPointerSweepLaneDocument & { findings: SweepFinding[]; manifestFile: string }> {
  const { laneId, targetUrl, observed } = options;
  assertSafeRunId(laneId);
  const laneOutputDir = path.resolve(
    options.projectRoot,
    options.outputDir ?? "aee-output",
    laneId
  );
  const sweepFile = path.join(laneOutputDir, "keyboard-pointer-sweep.json");
  const manifestFile = path.join(laneOutputDir, "manifest.json");
  const pressScreenshot = (press: number) => `press-${press}.png`;
  const laneRecord = {
    schemaVersion: "0.2.0" as const,
    laneId,
    driver: "keyboard-pointer-sweep" as const,
    isolation: "test-page" as const,
    status: "completed" as const,
    targetUrl,
    allowedOrigins: [targetUrl],
    activateControls: false,
    pressedBy: "test" as const,
    startedAt: options.startedAt,
    finishedAt: new Date().toISOString(),
    blockedNavigations: [],
    tabStops: [],
    activated: observed.pressed,
    findings: observed.findings.map(({ press, ...finding }): KeyboardPointerSweepLaneFinding =>
      observed.screenshots.has(press) ? { ...finding, screenshot: pressScreenshot(press) } : finding
    ),
    ...(observed.diagnostics.length ? { diagnostics: observed.diagnostics } : {})
  };
  assertValidSchema("keyboardPointerSweepLane", laneRecord, "observed presses lane output");
  await mkdir(laneOutputDir, { recursive: true });
  await writeFile(sweepFile, JSON.stringify(laneRecord, null, 2), "utf8");
  for (const [press, screenshot] of observed.screenshots) {
    await writeFile(path.join(laneOutputDir, pressScreenshot(press)), screenshot);
  }
  await writeEvidenceManifest({
    assessmentId: laneId,
    rootDir: laneOutputDir,
    manifestFile,
    lanes: [{ id: laneId, driver: "keyboard-pointer-sweep", status: "completed", actions: [] }],
    supplementalFiles: [
      { path: sweepFile, kind: "keyboard-pointer-sweep", phase: "lane", laneId },
      ...[...observed.screenshots.keys()].map((press) => ({
        path: path.join(laneOutputDir, pressScreenshot(press)),
        kind: "full-page-screenshot" as const,
        phase: "action" as const,
        laneId,
        actionId: `press-${press}`,
        sequence: press
      }))
    ]
  });
  return { ...laneRecord, manifestFile };
}

export async function runKeyboardPointerSweepLane<TPage extends KeyboardPointerSweepLanePage>(
  options: RunKeyboardPointerSweepLaneOptions<TPage>
): Promise<KeyboardPointerSweepLaneResult> {
  const laneId = options.laneId ?? `keyboard-pointer-sweep-${Date.now()}`;
  assertSafeRunId(laneId);
  const allowedOrigins = normalizeAllowedOrigins(
    options.allowedOrigins,
    "keyboard and pointer sweep"
  );
  assertAllowedOrigin(options.targetUrl, allowedOrigins, "Keyboard and pointer sweep");
  const laneOutputDir = path.resolve(
    options.projectRoot,
    options.outputDir ?? "aee-output",
    laneId
  );
  const sweepFile = path.join(laneOutputDir, "keyboard-pointer-sweep.json");
  const screenshotFile = path.join(laneOutputDir, "full-page.png");
  const manifestFile = path.join(laneOutputDir, "manifest.json");
  const header = {
    schemaVersion: "0.2.0" as const,
    laneId,
    driver: "keyboard-pointer-sweep" as const,
    isolation: options.page ? ("test-page" as const) : ("dedicated-browser-context" as const),
    targetUrl: options.targetUrl,
    allowedOrigins,
    activateControls: options.activateControls,
    startedAt: new Date().toISOString()
  };
  const blockedNavigations: string[] = [];
  const steps: SweepStep[] = [];
  let sweep:
    Pick<KeyboardPointerSweepLaneResult, "tabStops" | "activated" | "findings"> | undefined;
  const focusCropFiles: string[] = [];
  let runError: unknown;

  await mkdir(laneOutputDir, { recursive: true });
  const {
    page,
    still,
    video: pageVideo,
    close
  } = await openSweepPages(
    options,
    laneOutputDir,
    navigationGuard(allowedOrigins, blockedNavigations)
  );
  try {
    const result = await sweepKeyboardAndPointer({
      page,
      url: options.targetUrl,
      activateControls: options.activateControls,
      onStep: (step) => steps.push(step)
    });
    const stillRequests = trackOpenRequests(still);
    try {
      await still.goto(options.targetUrl);
      await waitForQuietPage(still, stillRequests);
    } finally {
      stillRequests.stop();
    }
    await still.screenshot({ path: screenshotFile, fullPage: true });
    const locations = await locateElements(
      still,
      result.findings.map(({ selector }) => selector)
    );
    const stopLocations = await locateElements(
      still,
      result.tabStops.map(({ selector }) => selector)
    );
    const tabStops: KeyboardPointerSweepLaneTabStop[] = [];
    for (const [index, { focusedCrop, ...stop }] of result.tabStops.entries()) {
      const focusCrop = focusedCrop ? `tab-stop-${index + 1}.png` : undefined;
      if (focusedCrop && focusCrop) {
        const file = path.join(laneOutputDir, focusCrop);
        await writeFile(file, focusedCrop);
        focusCropFiles.push(file);
      }
      const targetBox = stopLocations[index];
      tabStops.push({
        ...stop,
        ...(targetBox ? { targetBox } : {}),
        ...(focusCrop ? { focusCrop } : {})
      });
    }
    sweep = {
      tabStops,
      activated: result.activated,
      findings: result.findings.map((finding, index) => {
        const targetBox = locations[index];
        return targetBox ? { ...finding, targetBox } : finding;
      })
    };
  } catch (error) {
    runError = error;
  } finally {
    await close();
  }

  const status = sweep ? "completed" : blockedNavigations.length > 0 ? "blocked" : "failed";
  const laneRecord: KeyboardPointerSweepLaneDocument = {
    ...header,
    status,
    finishedAt: new Date().toISOString(),
    blockedNavigations,
    ...(sweep ?? {
      diagnostics: [runError instanceof Error ? runError.message : String(runError)]
    })
  };
  assertValidSchema(
    "keyboardPointerSweepLane",
    laneRecord,
    "keyboard and pointer sweep lane output"
  );
  await writeFile(sweepFile, JSON.stringify(laneRecord, null, 2), "utf8");
  const video = pageVideo
    ? await persistInteractionVideo({
        video: pageVideo,
        rootDir: laneOutputDir,
        laneDir: laneOutputDir,
        laneId,
        driver: "keyboard-pointer-sweep",
        status,
        startedAt: laneRecord.startedAt,
        finishedAt: laneRecord.finishedAt,
        actions: steps.map((step, index) => ({
          id: `step-${index + 1}`,
          sequence: index + 1,
          ...step
        })),
        ...(laneRecord.diagnostics ? { diagnostics: laneRecord.diagnostics } : {})
      })
    : undefined;
  await writeEvidenceManifest({
    assessmentId: laneId,
    rootDir: laneOutputDir,
    manifestFile,
    lanes: [{ id: laneId, driver: "keyboard-pointer-sweep", status, actions: [] }],
    supplementalFiles: [
      { path: sweepFile, kind: "keyboard-pointer-sweep", phase: "lane", laneId },
      ...(video
        ? [video.videoFile, video.sidecarFile, video.captionsFile].map((file) => ({
            path: file,
            laneId
          }))
        : []),
      ...(sweep
        ? [
            {
              path: screenshotFile,
              kind: "full-page-screenshot" as const,
              phase: "lane" as const,
              laneId
            }
          ]
        : []),
      ...focusCropFiles.map((file) => ({
        path: file,
        kind: "focus-crop" as const,
        phase: "lane" as const,
        laneId
      }))
    ]
  });
  if (!sweep) throw runError;
  return {
    ...laneRecord,
    ...sweep,
    status: "completed",
    sweepFile,
    screenshotFile,
    manifestFile,
    ...(video ? { video } : {})
  };
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

/** The most characters a lane or action run id may have: each names a folder of its evidence. */
export const MAX_RUN_ID_LENGTH = 128;

const SAFE_RUN_ID = new RegExp(`^[A-Za-z0-9][A-Za-z0-9._-]{0,${MAX_RUN_ID_LENGTH - 1}}$`);

/** The run id of a lane's action at a place in the lane, counted from 1: `<lane id>-001`. */
export function actionRunId(laneId: string, sequence: number): string {
  return `${laneId}-${String(sequence).padStart(3, "0")}`;
}

/** The id of the lane an input comparison runs its pointer or its keyboard actions in. */
export function inputComparisonLaneId(
  comparisonId: string,
  driver: InputComparisonLane["driver"]
): string {
  return `${comparisonId}-${driver}`;
}

function assertSafeRunId(runId: string): void {
  if (!SAFE_RUN_ID.test(runId) || runId === "." || runId === "..") {
    throw new Error(
      `Invalid runId. Use 1-${MAX_RUN_ID_LENGTH} letters, numbers, dots, underscores, or hyphens, beginning with a letter or number.`
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

interface CdpEnabledPageLike extends PlaywrightPageLike, Partial<FramedPage> {
  context?(): CdpContext;
}

/** The page, when it can be read frame by frame over the DevTools protocol, as a Playwright page can. */
function framedCdpPage<TPage extends CdpEnabledPageLike>(
  page: TPage
): (TPage & FramedPage & { context(): CdpContext }) | undefined {
  return page.context && page.frames && page.mainFrame
    ? (page as TPage & FramedPage & { context(): CdpContext })
    : undefined;
}

interface EvaluatablePageLike extends PlaywrightPageLike {
  evaluate?<TArgument>(
    pageFunction: (argument: TArgument) => unknown,
    argument?: TArgument
  ): Promise<unknown>;
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
  const cdpPage = framedCdpPage(page as CdpEnabledPageLike);
  const evaluatablePage = page as EvaluatablePageLike;
  const eventedPage = page as EventedPageLike;
  const customScreenshot = page.snapshotScreenshot?.bind(page);
  const customRunAxeAnalysis = page.runAxeAnalysis?.bind(page);
  const listenVirtualScreenReader = virtualScreenReader
    ? async () => virtualScreenReader.listen()
    : undefined;
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
    : cdpPage
      ? async () => withPageSessions(cdpPage.context(), cdpPage, fetchAccessibilityTree)
      : undefined;
  const snapshotFocusTarget = page.snapshotFocusTarget
    ? async () => page.snapshotFocusTarget?.()
    : cdpPage
      ? async () => {
          // DOM focus and the accessibility tree's focus are read from the same sessions, so both
          // describe the page at the same moment.
          const focusState = await withPageSessions(cdpPage.context(), cdpPage, async (frames) => {
            const domFocus = await captureDomFocus(frames);
            return (
              domFocus && { ...domFocus, accessibilityFocus: await accessibilityFocusOf(frames) }
            );
          });
          if (focusState) assertValidSchema("focusState", focusState, "deep focus state");
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
    ? async (options: AxeAnalysisOptions) => customRunAxeAnalysis(options)
    : evaluatablePage.evaluate
      ? async (options: AxeAnalysisOptions) => {
          // `options()` replaces axe's run options, so it goes before `withTags()` adds the tags.
          const axeResult = await new AxeBuilder({
            page: page as unknown as ConstructorParameters<typeof AxeBuilder>[0]["page"]
          })
            .options({ rules: enableExperimentalAxeRules(options.experimentalTags ?? []) })
            .withTags(options.tags)
            .analyze();
          // Contrast axe could not decide over an image or a gradient is measured from the pixels.
          const result = nativeScreenshot
            ? await settleContrastByPixels(page as unknown as ContrastMeasuringPage, axeResult)
            : axeResult;
          const targets = result.violations.flatMap((rule, ruleIndex) =>
            rule.nodes.map((node, nodeIndex) => ({
              key: `${ruleIndex}:${nodeIndex}`,
              selector: String(node.target[0] ?? ""),
              // Only an element an AI specialist may be asked about gets its surroundings captured.
              needsContext: Boolean(conceptForAxeRule(rule.id)?.ai.specialistId)
            }))
          );
          const locatablePage = evaluatablePage as EvaluatablePageLike & ElementLocationPage;
          const contextTargets = targets.filter(({ needsContext }) => needsContext);
          const locationByKey = byTargetKey(
            targets,
            await locateElements(
              locatablePage,
              targets.map(({ selector }) => selector)
            )
          );
          // An AI specialist is asked only with the element as the accessibility tree has it.
          const contextByKey = byTargetKey(
            contextTargets,
            cdpPage && contextTargets.length > 0
              ? await withPageSessions(cdpPage.context(), cdpPage, (sessions) =>
                  describeElementContexts(
                    locatablePage,
                    sessions,
                    contextTargets.map(({ selector }) => selector)
                  )
                )
              : []
          );
          return {
            ...result,
            violations: result.violations.map((rule, ruleIndex) => ({
              ...rule,
              nodes: rule.nodes.map((node, nodeIndex) => {
                const key = `${ruleIndex}:${nodeIndex}`;
                return {
                  ...node,
                  ...(locationByKey.has(key) ? { aeeTarget: locationByKey.get(key) } : {}),
                  ...(contextByKey.has(key) ? { aeeContext: contextByKey.get(key) } : {})
                };
              })
            }))
          };
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
    snapshotElementMap: cdpPage
      ? async () => {
          const elementMap = await withPageSessions(cdpPage.context(), cdpPage, captureElementMap);
          assertValidSchema("elementMap", elementMap, "element map");
          return elementMap;
        }
      : undefined,
    snapshotFocusTarget,
    snapshotScreenshot,
    runAxeAnalysis,
    snapshotVirtualScreenReaderTranscript,
    listenVirtualScreenReader,
    setupNetworkTracking,
    snapshotNetworkLog,
    teardownNetworkTracking
  };
}

/** Where the accessibility tree has focus, in whichever frame holds it. */
async function accessibilityFocusOf(frames: PageSessions): Promise<Record<string, unknown>> {
  try {
    const { nodes } = await fetchAccessibilityTree(frames);
    const focusedNodes = nodes.filter((node) =>
      node.properties?.some(({ name, value }) => name === "focused" && value.value === true)
    );
    const focusedNode =
      focusedNodes.find((node) => !["RootWebArea", "WebArea"].includes(String(node.role?.value))) ??
      focusedNodes.at(-1);

    if (!focusedNode) return { status: "not-exposed" };
    return {
      status: "matched",
      nodeId: focusedNode.nodeId,
      backendDOMNodeId: focusedNode.backendDOMNodeId,
      frameId: focusedNode.frameId,
      role: focusedNode.role?.value,
      name: focusedNode.name?.value
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
  }
}

/** Pairs each target's key with its result, dropping the targets the page could not find. */
function byTargetKey<Result>(
  targets: Array<{ key: string }>,
  results: Array<Result | null>
): Map<string, Result> {
  return new Map(
    targets.flatMap(({ key }, index) => {
      const result = results[index];
      return result ? [[key, result] as const] : [];
    })
  );
}

/**
 * axe runs no experimental rule unless it is enabled by id (axe-core API.md, "Example 3"). The ids
 * come from the same axe-core release that @axe-core/playwright injects, so a rule axe adds or
 * graduates is picked up without a hand-kept list.
 */
export function enableExperimentalAxeRules(
  tags: readonly string[]
): Record<string, { enabled: true }> {
  return Object.fromEntries(
    axe
      .getRules(["experimental"])
      .filter((rule) => rule.tags.some((tag) => tags.includes(tag)))
      .map((rule) => [rule.ruleId, { enabled: true }])
  );
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
      url: redactUrl(request.url()),
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
      url: redactUrl(response.url()),
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
