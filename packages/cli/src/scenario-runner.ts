import { spawn } from "node:child_process";
import { copyFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  accessibleNameSpecialist,
  AiNotConfiguredError,
  createModelProvider,
  imagePurposeSpecialist,
  imageRoleFromMarkup,
  parseModelProviderName,
  proposeAccessibleLabelFix,
  proposeImageAlternativeFix,
  type AiProposedFix,
  type ImageRole,
  type ModelProvider
} from "@aee/ai-fixes";
import { isAdvisoryAxeRule } from "@aee/observers";
import {
  aggregateEvidenceManifests,
  announcedWithoutName,
  runInputComparison,
  runKeyboardPointerSweepLane,
  runVirtualScreenReaderLane,
  SWEEP_FINDING_CONCEPTS,
  type ContrastMeasurement,
  type ElementContext,
  type ElementMap,
  type EvidenceManifest,
  type InputComparisonResult,
  type InteractionComparisonBrowser,
  type KeyboardPointerSweepLaneBrowser,
  type KeyboardPointerSweepLaneDocument,
  type KeyboardPointerSweepLaneFinding,
  type KeyboardPointerSweepLaneResult,
  type PageCheckpointStep,
  type SweepFindingKind,
  type VirtualScreenReaderCommand,
  type VirtualScreenReaderLaneBrowser,
  type VirtualScreenReaderLaneResult
} from "@aee/playwright";
import {
  assertValidSchema,
  conceptForAxeRule,
  CURRENT_SCHEMA_VERSION,
  patternForAxeRule,
  patternLink,
  remediationEntry,
  remediationRegistry,
  type PatternLink
} from "@aee/schemas";
import { chromium, type Browser, type Page } from "@playwright/test";

import {
  ACTIVATE_PAGE_CONTROLS,
  compileScenarioPlan,
  loadScenario,
  type AeeScenario,
  type ScenarioPlan,
  type ScenarioProfile
} from "./scenario";

export interface ExecuteScenarioOptions {
  outputDir?: string;
  browser?: Browser;
  /** The model the allowlisted AI specialists ask; defaults to aeeRunModelProvider(). */
  aiProvider?: ModelProvider;
}

export interface ScenarioActionReport {
  journeyId: string;
  laneId: string;
  driver: "pointer" | "keyboard" | "portable-virtual-screen-reader" | "playwright-test";
  actionId: string;
  sequence: number;
  runId: string;
  pageUrl: string;
  results: { pass: number; fail: number; unknown: number };
  releaseVerdict: "pass" | "fail" | "unknown";
  reportPath: string;
  artifactPaths: string[];
}

export interface ScenarioIntegratedReport {
  schemaVersion: "0.1.0";
  assessmentId: string;
  scenarioId: string;
  name?: string;
  scenarioDigest: string;
  planDigest: string;
  profile: ScenarioProfile;
  target: string;
  goal: string;
  standard: string;
  status: "completed" | "partial";
  verdict: "pass" | "fail" | "unknown";
  startedAt: string;
  finishedAt: string;
  completeness: {
    status: "complete" | "incomplete";
    plannedLanes: number;
    completedLanes: number;
    missingArtifacts: number;
    failedArtifacts: number;
    /** Whether the plan runs the keyboard and mouse sweep and the virtual screen reader at all. */
    plannedChecks: { keyboard: boolean; reader: boolean };
  };
  summary: {
    actions: number;
    passed: number;
    failed: number;
    unknown: number;
    /** Findings that block release. */
    findings: number;
    /** Advisory findings: reported, never blocking. */
    advisories: number;
    artifacts: number;
  };
  journeys: Array<{ id: string; name: string; goal: string; startUrl: string }>;
  actions: ScenarioActionReport[];
  findings: Array<Record<string, unknown>>;
  synthesis: ScenarioSynthesis;
  artifacts: Array<Record<string, unknown>>;
  diagnostics: string[];
  files: {
    html: string;
    json: string;
    markdown: string;
    prComment: string;
    csv: string;
    manifest: string;
    plan: string;
  };
  privacy: {
    classification: "sensitive";
    reviewedForSharing: false;
    remoteUploadAuthorized: false;
  };
  ai: { present: boolean; label: string };
}

/** The files every run writes its report to. */
interface ReportFiles {
  html: string;
  json: string;
  markdown: string;
  /** The report as one pull-request comment. */
  prComment: string;
  /** Every fix as one row, for an issue tracker's CSV import. */
  csv: string;
}

export interface ExecuteScenarioResult {
  assessmentId: string;
  outputDir: string;
  verdict: ScenarioIntegratedReport["verdict"];
  completeness: ScenarioIntegratedReport["completeness"]["status"];
  /** The verdict in words, as the pull-request comment's heading says it. */
  headline: string;
  reportFiles: ReportFiles;
  manifestFile: string;
  planFile: string;
}

interface ActionJudgmentView {
  judgeId: string;
  verdict: "pass" | "fail" | "unknown";
  severity?: string;
  summary: string;
  suggestedFix?: string;
}

interface ActionReportView {
  action: ScenarioActionReport;
  judgments: ActionJudgmentView[];
  observerSummaries: string[];
  readError?: string;
}

interface AxeRuleView {
  id: string;
  impact: string;
  help: string;
  description: string;
  helpUrl?: string;
  nodeCount: number;
  targets: string[];
  htmlSamples: string[];
  tags: string[];
  failureSummary?: string;
  failureSummaries: string[];
  nodes: AxeNodeView[];
}

interface AxeNodeView {
  target: string;
  html?: string;
  failureSummary?: string;
  targetBox?: AxeTargetBox;
  /** The page around the element, captured for the AI specialists that may be asked about it. */
  context?: ElementContext;
  /** Why axe could not decide the element: its reason key and its own words. */
  undecided?: { key: string; message: string };
  /** AEE's measurement of the pixels behind a text whose contrast axe could not decide. */
  contrast?: ContrastMeasurement;
}

interface AxeTargetBox {
  x: number;
  y: number;
  width: number;
  height: number;
  pageWidth: number;
  pageHeight: number;
}

interface AxeReportView {
  path: string;
  actionId: string;
  laneId: string;
  runId: string;
  violations: AxeRuleView[];
  incomplete: AxeRuleView[];
  passes: number;
  inapplicable: number;
  readError?: string;
}

interface InputComparisonView {
  path: string;
  comparisonId: string;
  name: string;
  status: string;
  isolation: string;
  equivalence: { verdict: "pass" | "fail" | "unknown"; summary: string };
  expectation: { verdict: "pass" | "fail" | "unknown"; summary: string };
  pointer: { actionIds: string[]; url?: string; visible?: boolean; text?: string };
  keyboard: { actionIds: string[]; url?: string; visible?: boolean; text?: string };
  readError?: string;
}

interface ReaderEntryView {
  sequence: number;
  command: string;
  announcement: string;
  role?: string;
  name?: string;
  level?: number;
  nodePath?: string;
  focusBefore: string;
  focusAfter: string;
  focusMoved: boolean;
  visualBounds?: { x: number; y: number; width: number; height: number };
}

interface ReaderTranscriptView {
  path: string;
  textPath?: string;
  pageUrl: string;
  mode: string;
  fidelity: string;
  entries: ReaderEntryView[];
  readError?: string;
}

/** Every lane that can produce a finding: the authored action lanes and the sweep. */
type LaneDriver = ScenarioActionReport["driver"] | "keyboard-pointer-sweep";

interface SweepView {
  path: string;
  screenshotPath?: string;
  document?: KeyboardPointerSweepLaneDocument;
  readError?: string;
}

interface FindingCheckpointSynthesis {
  actionId: string;
  laneId: string;
  runId: string;
  driver: LaneDriver;
  behaviorVerdict: "pass" | "fail" | "unknown";
  behaviorSummary: string;
  nodeCount: number;
  targets: string[];
  htmlSamples: string[];
  axePath?: string;
  domPath?: string;
  accessibilityTreePath?: string;
  focusPath?: string;
  screenshotPath?: string;
  viewportPath?: string;
  readerTranscriptPath?: string;
  sweepPath?: string;
}

interface FindingSynthesis {
  ruleId: string;
  title: string;
  severity: string;
  /** The status row this finding belongs to. */
  area: "keyboard" | "semantics" | "contrast";
  /** An axe best-practice rule or a heuristic sweep check: reported, but it never blocks release. */
  advisory: boolean;
  wcagCriteria: string[];
  /** The a11y-skills pattern that explains how to build this correctly, when the registry maps the rule. */
  pattern?: PatternLink;
  conclusion: string;
  occurrenceCount: number;
  checkpointCount: number;
  maximumAffectedNodes: number;
  instanceCount: number;
  componentCount: number;
  instances: FindingInstanceSynthesis[];
  checkpoints: FindingCheckpointSynthesis[];
  remediation: {
    deterministic: string;
    ai: FindingAi;
    verification: string[];
  };
}

/** What AI contributed to a finding. It never changes the finding's verdict. */
interface FindingAi {
  used: boolean;
  status: "not-applicable" | "available-if-needed" | "not-configured" | "suggested";
  reason: string;
  specialistId?: string;
  providerId?: string;
  suggestions?: AiSuggestion[];
  /** Elements the specialist was not asked about, or could not answer for, and why. */
  notes?: string[];
}

/** One AI answer for one affected element, labelled as AI and applied only once a person accepts it with `aee fix`. */
interface AiSuggestion {
  selector: string;
  /** The proposed accessible name or text alternative; empty for a decorative image. */
  text: string;
  classification?: ImageRole;
  rationale: string;
  confidence: number;
  citedEvidenceIds: string[];
  patch: string;
}

interface FindingInstanceSynthesis {
  component: string;
  label: string;
  selector: string;
  /** The element's tag, when the evidence recorded its HTML. */
  tagName?: string;
  detail?: string;
  targetBox?: AxeTargetBox;
}

export interface ScenarioSynthesis {
  conclusion: string;
  directJudgments: { passed: number; failed: number; unknown: number };
  releaseGates: { passed: number; failed: number; unknown: number };
  findingOccurrences: number;
  affectedInstancesAtLargestCheckpoint: number;
  incompleteRuleResults: number;
  uniqueIncompleteRules: string[];
  lanes: Array<{
    driver: ScenarioActionReport["driver"];
    actions: number;
    passed: number;
    failed: number;
    unknown: number;
    summary: string;
  }>;
  comparisons: InputComparisonView[];
  reader: { commands: number; passed: number; failed: number; unknown: number };
  /** One row per area, computed once from the findings and evidence; every view renders these. */
  status: StatusArea[];
  findings: FindingSynthesis[];
  /** Each text whose contrast is left for a person, once, with why it could not be decided. */
  undecidedContrast: Array<{ selector: string; reason: string }>;
}

export interface StatusArea {
  id: "keyboard" | "reader" | "semantics" | "contrast";
  label: string;
  /** `not-run`: the run does not include this check, so it says nothing either way. */
  verdict: "pass" | "fail" | "unknown" | "not-run";
  result: string;
  detail: string;
}

interface IntegratedHtmlViews {
  transcripts: ReaderTranscriptView[];
  actionReports: ActionReportView[];
  axeReports: AxeReportView[];
  comparisons: InputComparisonView[];
  sweeps: SweepView[];
  screens: ScreenView[];
  elementMaps: ElementMapView[];
}

/** A checkpoint's element map and the full-page screenshot taken at the same moment. */
interface ElementMapView {
  path: string;
  runId?: string;
  screenshotPath?: string;
  map?: ElementMap;
  readError?: string;
}

/** A full-page screenshot and its size in pixels, read from its PNG header. */
interface ScreenView {
  path: string;
  width?: number;
  height?: number;
}

/**
 * How the report names each sweep finding, who it affects, how to fix it, and its status row. A
 * heuristic check is advisory: it measures how something looks, and only a person can confirm what
 * the author meant.
 */
const SWEEP_FINDING_TEXT: Record<
  SweepFindingKind,
  {
    title: string;
    /** What should happen instead, as a ticket's "expected". */
    expected: string;
    impact: string;
    fix: string;
    area: FindingSynthesis["area"];
    advisory?: true;
  }
> = {
  "pointer-only": {
    title: "Works with a mouse only",
    expected: "Tab reaches it, and Enter or Space does what a click does.",
    impact: "Keyboard users cannot reach or press it.",
    fix: "Use a native button, or a link if it goes to another page, so it is in the Tab order and works with Enter and Space.",
    area: "keyboard"
  },
  "hover-only": {
    title: "Shown on mouse hover only",
    expected: "What shows on mouse hover also shows when its trigger gets keyboard focus.",
    impact: "Keyboard and touch-screen users never see this content.",
    fix: "Show the same content when its trigger gets keyboard focus, or put it behind a button that opens it, such as a details element.",
    area: "keyboard"
  },
  "activation-differs": {
    title: "The keyboard does something different from a click",
    expected: "Pressing it with the keyboard does what clicking it does.",
    impact: "Keyboard users do not get the result a mouse user gets.",
    fix: "Make Enter, or Space for check boxes and switches, do exactly what a click does; a native button does this for free.",
    area: "keyboard"
  },
  "focus-lost": {
    title: "Focus is lost after an action",
    expected: "After the action, keyboard focus is on something visible and sensible.",
    impact:
      "Keyboard and screen-reader users lose their place and have to start again from the top of the page.",
    fix: "After the action, move focus to the element that replaces the one that disappeared, or to the next sensible control.",
    area: "keyboard"
  },
  "looks-like-heading": {
    title: "Looks like a heading, but is not one",
    expected: "Text that looks like a section heading is marked up as a heading.",
    impact:
      "Screen-reader users who move through the page by headings skip this section title, and do not hear where the section starts.",
    fix: "Make it a real heading (h2 to h6) at the level the design shows. A summary is a button, so a heading inside it is lost: put the heading before the details element, or around the whole disclosure.",
    area: "semantics",
    advisory: true
  }
};

function isSweepFindingKind(ruleId: string): ruleId is SweepFindingKind {
  return Object.hasOwn(SWEEP_FINDING_TEXT, ruleId);
}

/** Executes only approved, user-authored scenario commands and integrates every resulting lane. */
export async function executeScenario(
  scenarioPath: string,
  options: ExecuteScenarioOptions = {}
): Promise<ExecuteScenarioResult> {
  const absoluteScenarioPath = path.resolve(scenarioPath);
  const scenario = await loadScenario(absoluteScenarioPath);
  const plan = compileScenarioPlan(scenario);
  assertScenarioCanRun(plan);
  const plannedLanes = countPlannedLanes(scenario);
  const assessmentId = `${scenario.id}-${Date.now()}`;
  const assessmentDir = path.resolve(options.outputDir ?? "aee-output", assessmentId);
  const startedAt = new Date().toISOString();
  const childManifestFiles: string[] = [];
  const actions: ScenarioActionReport[] = [];
  const findings: Array<Record<string, unknown>> = [];
  const diagnostics: string[] = [];

  const browser = options.browser ?? (await chromium.launch({ headless: true }));
  const ownsBrowser = !options.browser;
  const assessment = { assessmentDir, childManifestFiles, actions, findings, diagnostics };
  const runLane = laneRunner(assessment);
  try {
    for (const journey of scenario.journeys) {
      const startUrl = new URL(journey.startPath ?? "/", scenario.target.url).href;
      const allowedOrigins = plan.safety.allowedOrigins;
      await runPageLanes(assessment, {
        target: { browser },
        journeyId: journey.id,
        startUrl,
        allowedOrigins,
        activateControls: journey.allowedActions.includes(ACTIVATE_PAGE_CONTROLS),
        commands: journey.virtualScreenReaderCommands ?? []
      });

      for (const comparison of journey.interactionComparisons ?? []) {
        const comparisonId = `${journey.id}-${comparison.id}`;
        await runLane(comparisonId, async () => {
          const result = await runInputComparison({
            browser: browser as unknown as InteractionComparisonBrowser<Page>,
            projectRoot: process.cwd(),
            outputDir: assessmentDir,
            comparisonId,
            name: comparison.name,
            targetUrl: startUrl,
            allowedOrigins,
            pointerActions: comparison.pointerActions,
            keyboardActions: comparison.keyboardActions,
            observe: comparison.observe,
            expected: comparison.expected
          });
          await collectInputActions(assessmentDir, journey.id, result, actions, findings);
          return result.manifestFile;
        });
      }
    }
  } finally {
    if (ownsBrowser) await browser.close();
  }

  return finishAssessment({
    assessmentId,
    assessmentDir,
    scenario,
    plan,
    startedAt,
    plannedLanes,
    actions,
    findings,
    childManifestFiles,
    diagnostics,
    aiProvider: options.aiProvider
  });
}

/** What an assessment's lanes add to as they run, before `finishAssessment` integrates it. */
export interface AssessmentInProgress {
  assessmentDir: string;
  childManifestFiles: string[];
  actions: ScenarioActionReport[];
  findings: Array<Record<string, unknown>>;
  diagnostics: string[];
}

/**
 * Runs one lane of an assessment. A lane that fails still counts: its error becomes a diagnostic
 * and any evidence it wrote stays in the manifest, so the report can never read as complete.
 */
function laneRunner({ assessmentDir, childManifestFiles, diagnostics }: AssessmentInProgress) {
  return async (laneId: string, run: () => Promise<string>) => {
    try {
      childManifestFiles.push(await run());
    } catch (error) {
      diagnostics.push(describeExecutionError(laneId, error));
      const expectedManifest = path.join(assessmentDir, laneId, "manifest.json");
      if (await fileExists(expectedManifest)) childManifestFiles.push(expectedManifest);
    }
  };
}

/**
 * Sweeps a journey's start page by keyboard and mouse, then runs its virtual screen-reader
 * commands, each as a lane of the assessment: in browser contexts of their own for a scenario, or
 * on the page a test drives, which keeps the test's session, routes and storage.
 */
export async function runPageLanes(
  assessment: AssessmentInProgress,
  input: {
    target: { browser: Browser } | { page: Page };
    journeyId: string;
    startUrl: string;
    allowedOrigins: string[];
    activateControls: boolean;
    commands: VirtualScreenReaderCommand[];
  }
): Promise<void> {
  const { assessmentDir, actions, findings, diagnostics } = assessment;
  const { journeyId, startUrl, allowedOrigins, commands } = input;
  const runLane = laneRunner(assessment);
  const lane = {
    projectRoot: process.cwd(),
    outputDir: assessmentDir,
    targetUrl: startUrl,
    allowedOrigins
  };
  const sweepLaneId = `${journeyId}-keyboard-pointer-sweep`;
  await runLane(sweepLaneId, async () => {
    const sweep = await runKeyboardPointerSweepLane({
      ...("browser" in input.target
        ? { browser: input.target.browser as unknown as KeyboardPointerSweepLaneBrowser<Page> }
        : { page: input.target.page }),
      ...lane,
      laneId: sweepLaneId,
      activateControls: input.activateControls
    });
    collectSweepFindings(journeyId, sweep, findings);
    for (const url of sweep.blockedNavigations) {
      diagnostics.push(`${sweepLaneId}: stopped a navigation outside the allowed origins: ${url}`);
    }
    return sweep.manifestFile;
  });

  if (commands.length === 0) return;
  const readerLaneId = `${journeyId}-virtual-reader`;
  await runLane(readerLaneId, async () => {
    const reader = await runVirtualScreenReaderLane({
      ...("browser" in input.target
        ? { browser: input.target.browser as unknown as VirtualScreenReaderLaneBrowser<Page> }
        : { page: input.target.page }),
      ...lane,
      laneId: readerLaneId,
      commands
    });
    await collectVirtualReaderActions(assessmentDir, journeyId, reader, actions, findings);
    return reader.manifestFile!;
  });
}

/** Where an assessment's plan, manifest and reports live. */
function assessmentFiles(assessmentDir: string) {
  return {
    planFile: path.join(assessmentDir, "scenario-plan.json"),
    manifestFile: path.join(assessmentDir, "manifest.json"),
    reportFiles: {
      html: path.join(assessmentDir, "aee-report.html"),
      json: path.join(assessmentDir, "aee-report.json"),
      markdown: path.join(assessmentDir, "aee-report.md"),
      prComment: path.join(assessmentDir, "aee-pr-comment.md"),
      csv: path.join(assessmentDir, "aee-fixes.csv")
    }
  };
}

/**
 * Turns the lanes' evidence into one assessment: the plan, the integrated report in every format
 * and the aggregate manifest. `aee run` and the Playwright test fixture both end here, so a test's
 * report reads exactly like a scenario's.
 */
export async function finishAssessment(input: {
  assessmentId: string;
  assessmentDir: string;
  scenario: AeeScenario;
  plan: ScenarioPlan;
  startedAt: string;
  plannedLanes: number;
  actions: ScenarioActionReport[];
  findings: Array<Record<string, unknown>>;
  childManifestFiles: string[];
  diagnostics: string[];
  aiProvider?: ModelProvider;
}): Promise<ExecuteScenarioResult> {
  const { assessmentId, assessmentDir, scenario, plan, childManifestFiles } = input;
  const { planFile, manifestFile, reportFiles } = assessmentFiles(assessmentDir);
  const aiSuggester = createAiSuggester(input.aiProvider ?? aeeRunModelProvider());
  await mkdir(assessmentDir, { recursive: true });
  await writeFile(planFile, JSON.stringify(plan, null, 2), "utf8");
  const childEvidence = await loadChildEvidence(assessmentDir, childManifestFiles);
  const consolidatedFindings = deduplicateFindings(input.findings);
  const report = createIntegratedReport({
    assessmentId,
    scenario,
    plan,
    startedAt: input.startedAt,
    finishedAt: new Date().toISOString(),
    plannedLanes: input.plannedLanes,
    actions: input.actions,
    findings: consolidatedFindings,
    artifacts: childEvidence.artifacts,
    completedLanes: childEvidence.completedLanes,
    missingArtifacts: childEvidence.missingArtifacts,
    failedArtifacts: childEvidence.failedArtifacts,
    diagnostics: input.diagnostics,
    assessmentDir,
    reportFiles,
    manifestFile,
    planFile
  });
  await writeIntegratedReport(report, reportFiles, assessmentDir, aiSuggester);
  let aggregate = await aggregateEvidenceManifests({
    assessmentId,
    rootDir: assessmentDir,
    childManifestFiles,
    scenarioId: scenario.id,
    scenarioDigest: plan.scenarioDigest,
    profile: scenario.profile,
    manifestFile,
    supplementalFiles: reportSupplementalFiles(reportFiles, planFile)
  });
  report.summary.artifacts = aggregate.manifest.summary.total;
  report.completeness.missingArtifacts = aggregate.manifest.summary.missing;
  report.completeness.failedArtifacts = aggregate.manifest.summary.failed;
  report.completeness.status =
    aggregate.manifest.status === "completed" ? "complete" : "incomplete";
  report.status = report.completeness.status === "complete" ? "completed" : "partial";
  if (report.completeness.status === "incomplete" && report.verdict === "pass") {
    report.verdict = "unknown";
  }
  await writeIntegratedReport(report, reportFiles, assessmentDir, aiSuggester);
  aggregate = await aggregateEvidenceManifests({
    assessmentId,
    rootDir: assessmentDir,
    childManifestFiles,
    scenarioId: scenario.id,
    scenarioDigest: plan.scenarioDigest,
    profile: scenario.profile,
    manifestFile,
    supplementalFiles: reportSupplementalFiles(reportFiles, planFile)
  });

  return {
    assessmentId,
    outputDir: assessmentDir,
    verdict: report.verdict,
    completeness: report.completeness.status,
    headline: verdictHeadline(report),
    reportFiles,
    manifestFile: aggregate.manifestFile,
    planFile
  };
}

function deduplicateFindings(
  findings: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  const consolidated = new Map<string, Record<string, unknown>>();
  for (const finding of findings) {
    const { source, ...findingWithoutSource } = finding;
    const key = JSON.stringify([
      finding.ruleId ?? finding.id,
      finding.message,
      finding.target,
      finding.severity,
      finding.outcome
    ]);
    const existing = consolidated.get(key);
    if (existing) {
      const occurrences = existing.occurrences as unknown[];
      if (source !== undefined) occurrences.push(source);
      continue;
    }
    consolidated.set(key, {
      ...findingWithoutSource,
      occurrences: source === undefined ? [] : [source]
    });
  }
  return [...consolidated.values()];
}

export function openScenarioReport(reportFile: string): void {
  const target = path.resolve(reportFile);
  const command =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", target] : [target];
  const child = spawn(command, args, { detached: true, stdio: "ignore", shell: false });
  child.unref();
}

function assertScenarioCanRun(plan: ScenarioPlan): void {
  if (plan.readiness.status === "blocked") {
    throw new Error(`Cannot run scenario “${plan.scenarioId}”: ${plan.readiness.summary}`);
  }
  if (plan.approval.status !== "approved") {
    throw new Error(
      `Cannot run scenario “${plan.scenarioId}” until plan ${plan.planDigest} is approved in approval.approvedPlanDigest.`
    );
  }
}

/** Every journey is swept; authored commands and comparisons add their own lanes. */
function countPlannedLanes(scenario: AeeScenario): number {
  return scenario.journeys.reduce(
    (count, journey) =>
      count +
      1 +
      (journey.virtualScreenReaderCommands?.length ? 1 : 0) +
      (journey.interactionComparisons?.length ?? 0) * 2,
    0
  );
}

/** One finding per kind, like one per axe rule; its elements are read back from the lane's evidence. */
function collectSweepFindings(
  journeyId: string,
  sweep: KeyboardPointerSweepLaneResult,
  findings: Array<Record<string, unknown>>
): void {
  for (const kind of new Set(sweep.findings.map(({ kind }) => kind))) {
    findings.push({
      id: `${sweep.laneId}:${kind}`,
      ruleId: kind,
      message: SWEEP_FINDING_TEXT[kind].title,
      severity: SWEEP_FINDING_TEXT[kind].advisory ? "low" : "high",
      source: { journeyId, laneId: sweep.laneId }
    });
  }
}

async function collectVirtualReaderActions(
  rootDir: string,
  journeyId: string,
  lane: VirtualScreenReaderLaneResult,
  actions: ScenarioActionReport[],
  findings: Array<Record<string, unknown>>
): Promise<void> {
  for (const step of lane.steps) {
    await collectAction(
      rootDir,
      journeyId,
      lane.laneId,
      lane.driver,
      `command-${step.sequence}-${step.command}`,
      step,
      actions,
      findings
    );
  }
}

/** A Playwright test's checkpoints, as actions of one lane, like a reader lane's commands. */
export async function collectPageCheckpointActions(
  rootDir: string,
  journeyId: string,
  lane: { laneId: string; steps: PageCheckpointStep[] },
  actions: ScenarioActionReport[],
  findings: Array<Record<string, unknown>>
): Promise<void> {
  for (const step of lane.steps) {
    await collectAction(
      rootDir,
      journeyId,
      lane.laneId,
      "playwright-test",
      step.actionId,
      step,
      actions,
      findings
    );
  }
}

async function collectInputActions(
  rootDir: string,
  journeyId: string,
  result: InputComparisonResult,
  actions: ScenarioActionReport[],
  findings: Array<Record<string, unknown>>
): Promise<void> {
  for (const lane of [result.lanes.pointer, result.lanes.keyboard]) {
    const laneId = `${result.comparisonId}-${lane.driver}`;
    for (const step of lane.steps) {
      await collectAction(
        rootDir,
        journeyId,
        laneId,
        lane.driver,
        step.action.id,
        step,
        actions,
        findings
      );
    }
  }
}

async function collectAction(
  rootDir: string,
  journeyId: string,
  laneId: string,
  driver: ScenarioActionReport["driver"],
  actionId: string,
  step: {
    sequence: number;
    runId: string;
    pageUrl: string;
    results: ScenarioActionReport["results"];
    releaseVerdict: ScenarioActionReport["releaseVerdict"];
    reporterFiles: string[];
    artifactFiles: string[];
  },
  actions: ScenarioActionReport[],
  findings: Array<Record<string, unknown>>
): Promise<void> {
  const jsonReport = step.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"));
  if (!jsonReport) throw new Error(`Action ${actionId} did not create a JSON report.`);
  actions.push({
    journeyId,
    laneId,
    driver,
    actionId,
    sequence: step.sequence,
    runId: step.runId,
    pageUrl: step.pageUrl,
    results: step.results,
    releaseVerdict: step.releaseVerdict,
    reportPath: relativePath(rootDir, jsonReport),
    artifactPaths: step.artifactFiles.map((filePath) => relativePath(rootDir, filePath))
  });
  const report = JSON.parse(await readFile(jsonReport, "utf8")) as { findings?: unknown[] };
  for (const finding of report.findings ?? []) {
    if (typeof finding === "object" && finding !== null) {
      findings.push({
        ...(finding as Record<string, unknown>),
        source: { journeyId, laneId, actionId, runId: step.runId }
      });
    }
  }
}

async function loadChildEvidence(rootDir: string, manifestFiles: string[]) {
  const artifacts: Array<Record<string, unknown>> = [];
  let completedLanes = 0;
  let missingArtifacts = 0;
  let failedArtifacts = 0;
  for (const manifestFile of manifestFiles) {
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as EvidenceManifest;
    assertValidSchema("evidenceManifest", manifest, `child evidence manifest ${manifestFile}`);
    completedLanes += manifest.lanes.filter(({ status }) => status === "completed").length;
    missingArtifacts += manifest.summary.missing;
    failedArtifacts += manifest.summary.failed;
    for (const artifact of manifest.artifacts) {
      artifacts.push({
        ...artifact,
        path: relativePath(rootDir, path.resolve(path.dirname(manifestFile), artifact.path))
      });
    }
  }
  artifacts.sort((left, right) => String(left.path).localeCompare(String(right.path)));
  return { artifacts, completedLanes, missingArtifacts, failedArtifacts };
}

function createIntegratedReport(input: {
  assessmentId: string;
  scenario: AeeScenario;
  plan: ScenarioPlan;
  startedAt: string;
  finishedAt: string;
  plannedLanes: number;
  actions: ScenarioActionReport[];
  findings: Array<Record<string, unknown>>;
  artifacts: Array<Record<string, unknown>>;
  completedLanes: number;
  missingArtifacts: number;
  failedArtifacts: number;
  diagnostics: string[];
  assessmentDir: string;
  reportFiles: ReportFiles;
  manifestFile: string;
  planFile: string;
}): ScenarioIntegratedReport {
  const failed = input.actions.filter(({ releaseVerdict }) => releaseVerdict === "fail").length;
  const unknown = input.actions.filter(({ releaseVerdict }) => releaseVerdict === "unknown").length;
  const passed = input.actions.filter(({ releaseVerdict }) => releaseVerdict === "pass").length;
  const complete =
    input.completedLanes === input.plannedLanes &&
    input.missingArtifacts === 0 &&
    input.failedArtifacts === 0 &&
    input.diagnostics.length === 0;
  // Axe failures arrive through the actions' release verdicts; sweep findings have no action.
  const sweepFailed = input.findings.some(
    (finding) => isSweepFindingKind(String(finding.ruleId)) && !isAdvisoryFinding(finding)
  );
  const verdict =
    failed > 0 || sweepFailed ? "fail" : !complete || unknown > 0 ? "unknown" : "pass";
  const report: ScenarioIntegratedReport = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    assessmentId: input.assessmentId,
    scenarioId: input.scenario.id,
    ...(input.scenario.name ? { name: input.scenario.name } : {}),
    scenarioDigest: input.plan.scenarioDigest,
    planDigest: input.plan.planDigest,
    profile: input.scenario.profile,
    target: input.scenario.target.url,
    goal: input.scenario.goal,
    standard: input.plan.standard,
    status: complete ? "completed" : "partial",
    verdict,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    completeness: {
      status: complete ? "complete" : "incomplete",
      plannedLanes: input.plannedLanes,
      completedLanes: input.completedLanes,
      missingArtifacts: input.missingArtifacts,
      failedArtifacts: input.failedArtifacts,
      plannedChecks: plannedChecks(input.plan)
    },
    summary: {
      actions: input.actions.length,
      passed,
      failed,
      unknown,
      findings: input.findings.filter((finding) => !isAdvisoryFinding(finding)).length,
      advisories: input.findings.filter(isAdvisoryFinding).length,
      artifacts: input.artifacts.length
    },
    journeys: input.plan.journeys.map(({ id, name, goal, startUrl }) => ({
      id,
      name,
      goal,
      startUrl
    })),
    actions: input.actions,
    findings: input.findings,
    synthesis: emptyScenarioSynthesis(),
    artifacts: input.artifacts,
    diagnostics: input.diagnostics,
    files: {
      html: relativePath(input.assessmentDir, input.reportFiles.html),
      json: relativePath(input.assessmentDir, input.reportFiles.json),
      markdown: relativePath(input.assessmentDir, input.reportFiles.markdown),
      prComment: relativePath(input.assessmentDir, input.reportFiles.prComment),
      csv: relativePath(input.assessmentDir, input.reportFiles.csv),
      manifest: relativePath(input.assessmentDir, input.manifestFile),
      plan: relativePath(input.assessmentDir, input.planFile)
    },
    privacy: {
      classification: "sensitive",
      reviewedForSharing: false,
      remoteUploadAuthorized: false
    },
    ai: { present: false, label: "AI-generated analysis: none in this report." }
  };
  assertValidSchema("scenarioReport", report, "integrated scenario report");
  return report;
}

/** The checks the plan runs besides axe, read from its steps. */
function plannedChecks(
  plan: ScenarioPlan
): ScenarioIntegratedReport["completeness"]["plannedChecks"] {
  const steps = plan.journeys.flatMap(({ steps }) => steps.map(({ id }) => id));
  return {
    keyboard: steps.includes("inventory-interactions"),
    reader: steps.some((id) => id.startsWith("reader-command-"))
  };
}

function emptyScenarioSynthesis(): ScenarioSynthesis {
  return {
    conclusion: "Synthesis is generated from the completed evidence set.",
    directJudgments: { passed: 0, failed: 0, unknown: 0 },
    releaseGates: { passed: 0, failed: 0, unknown: 0 },
    findingOccurrences: 0,
    affectedInstancesAtLargestCheckpoint: 0,
    incompleteRuleResults: 0,
    uniqueIncompleteRules: [],
    lanes: [],
    comparisons: [],
    reader: { commands: 0, passed: 0, failed: 0, unknown: 0 },
    status: [],
    findings: [],
    undecidedContrast: []
  };
}

async function writeIntegratedReport(
  report: ScenarioIntegratedReport,
  files: ReportFiles,
  rootDir: string,
  aiSuggester: AiSuggester
): Promise<void> {
  const [transcripts, actionReports, axeReports, comparisons, sweeps, screens, elementMaps] =
    await Promise.all([
      loadReaderTranscriptViews(report, rootDir),
      loadActionReportViews(report, rootDir),
      loadAxeReportViews(report, rootDir),
      loadInputComparisonViews(report, rootDir),
      loadSweepViews(report, rootDir),
      loadScreenViews(report, rootDir),
      loadElementMapViews(report, rootDir)
    ]);
  const views = {
    transcripts,
    actionReports,
    axeReports,
    comparisons,
    sweeps,
    screens,
    elementMaps
  };
  report.synthesis = buildScenarioSynthesis(report, views);
  await addAiSuggestions(report, views, aiSuggester);
  assertValidSchema("scenarioReport", report, "integrated scenario report");
  const reportFont = path.join(rootDir, "aee-report-display.woff2");
  await Promise.all([
    writeFile(files.json, JSON.stringify(report, null, 2), "utf8"),
    writeFile(files.markdown, renderIntegratedMarkdown(report), "utf8"),
    writeFile(files.prComment, renderPullRequestComment(report), "utf8"),
    writeFile(files.csv, renderFixesCsv(report, views), "utf8"),
    writeFile(files.html, renderIntegratedHtml(report, views), "utf8"),
    copyFile(path.resolve(__dirname, "../assets/aee-display.woff2"), reportFont)
  ]);
}

/** A fix applied to source, as a rerun is asked to confirm it. */
export interface AppliedFix {
  ruleId: string;
  selector: string;
  /** The accessible name the fix gives the element. */
  name: string;
}

export interface FixCheck {
  id: "axe" | "reader" | "cross-evidence";
  verdict: "pass" | "fail" | "unknown";
  detail: string;
}

export interface FixVerification {
  selector: string;
  verdict: "pass" | "fail" | "unknown";
  checks: FixCheck[];
}

/**
 * Reads a rerun's evidence for each applied fix. Three checks must pass: axe no longer reports the
 * rule on the element; the virtual reader, on the scenario's own commands, announced the element
 * with the new name; and that command's cross-evidence judgment passed, so the accessibility tree
 * holds the same role and name, the DOM was captured and the element is drawn on the page. A check
 * with no evidence is unknown, never a pass, and so is the fix.
 */
export async function verifyAppliedFixes(
  reportFile: string,
  fixes: AppliedFix[]
): Promise<FixVerification[]> {
  const rootDir = path.dirname(reportFile);
  const report = JSON.parse(await readFile(reportFile, "utf8")) as ScenarioIntegratedReport;
  const [transcripts, actionReports, axeReports] = await Promise.all([
    loadReaderTranscriptViews(report, rootDir),
    loadActionReportViews(report, rootDir),
    loadAxeReportViews(report, rootDir)
  ]);
  const axeRan = axeReports.filter(({ readError }) => !readError);
  const entries = transcripts.flatMap((transcript) => transcript.entries);
  return fixes.map(({ ruleId, selector, name }) => {
    const check = (id: FixCheck["id"], verdict: FixCheck["verdict"], detail: string) => ({
      id,
      verdict,
      detail
    });
    const stillFound = axeRan.some(({ violations }) =>
      violations.some(({ id, targets }) => id === ruleId && targets.includes(selector))
    );
    const axe = !axeRan.length
      ? check("axe", "unknown", "No axe result was recorded.")
      : stillFound
        ? check("axe", "fail", `axe still reports ${ruleId} on ${selector}.`)
        : check("axe", "pass", `axe no longer reports ${ruleId} on ${selector}.`);
    const reached = entries.filter(({ nodePath }) => nodePath === selector);
    const entry = reached.find((candidate) => candidate.name === name) ?? reached[0];
    const reader = !entry
      ? check(
          "reader",
          "unknown",
          `The virtual reader never reached ${selector}: add reader commands that do.`
        )
      : entry.name === name
        ? check("reader", "pass", `Announced “${entry.announcement}”.`)
        : check("reader", "fail", `Announced “${entry.announcement}”, not the name “${name}”.`);
    const judgment = entry && readerJudgment(actionReports, entry);
    const crossEvidence = judgment
      ? check("cross-evidence", judgment.verdict, judgment.summary)
      : check("cross-evidence", "unknown", `No cross-evidence judgment covers ${selector}.`);
    const checks = [axe, reader, crossEvidence];
    return { selector, verdict: overallVerdict(checks), checks };
  });
}

/** The cross-evidence judgment of the reader command that produced a transcript entry. */
function readerJudgment(
  actionReports: ActionReportView[],
  entry: ReaderEntryView
): ActionJudgmentView | undefined {
  return actionReports
    .find(({ action }) => action.actionId === readerActionId(entry))
    ?.judgments.find(({ judgeId }) => judgeId === "screen-reader");
}

function readerActionId(entry: ReaderEntryView): string {
  return `command-${entry.sequence}-${entry.command}`;
}

async function loadReaderTranscriptViews(
  report: ScenarioIntegratedReport,
  rootDir: string
): Promise<ReaderTranscriptView[]> {
  const artifacts = report.artifacts.filter(
    (artifact) =>
      artifact.kind === "screen-reader-transcript" &&
      artifact.phase === "lane" &&
      /(^|\/)transcript\.json$/.test(String(artifact.path))
  );
  return Promise.all(
    artifacts.map(async (artifact) => {
      const artifactPath = String(artifact.path);
      try {
        const document = await readReportJson(rootDir, artifactPath);
        const entries = Array.isArray(document.entries)
          ? document.entries.filter(isRecord).map(readerEntryView)
          : [];
        const textPath = report.artifacts.find(
          (candidate) =>
            candidate.kind === "screen-reader-transcript" &&
            candidate.phase === "lane" &&
            path.posix.dirname(String(candidate.path)) === path.posix.dirname(artifactPath) &&
            /(^|\/)transcript\.txt$/.test(String(candidate.path))
        );
        return {
          path: artifactPath,
          textPath: textPath ? String(textPath.path) : undefined,
          pageUrl: stringField(document, "pageUrl", report.target),
          mode: stringField(document, "mode", "guide"),
          fidelity: stringField(document, "fidelity", "semantic-simulation"),
          entries
        };
      } catch (error) {
        return {
          path: artifactPath,
          pageUrl: report.target,
          mode: "unknown",
          fidelity: "unknown",
          entries: [],
          readError: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
}

function readerEntryView(entry: Record<string, unknown>): ReaderEntryView {
  const item = isRecord(entry.item) ? entry.item : {};
  const bounds = isRecord(item.visualBounds) ? item.visualBounds : undefined;
  return {
    sequence: numberField(entry, "sequence"),
    command: stringField(entry, "command", "unknown-command"),
    announcement: stringField(entry, "announcement", "No announcement was emitted."),
    role: optionalStringField(item, "role"),
    name: optionalStringField(item, "name"),
    level: optionalNumberField(item, "level"),
    nodePath: optionalStringField(item, "nodePath"),
    focusBefore: stringField(entry, "domFocusBefore", "unknown"),
    focusAfter: stringField(entry, "domFocusAfter", "unknown"),
    focusMoved: entry.focusMoved === true,
    visualBounds:
      bounds && ["x", "y", "width", "height"].every((key) => typeof bounds[key] === "number")
        ? {
            x: Number(bounds.x),
            y: Number(bounds.y),
            width: Number(bounds.width),
            height: Number(bounds.height)
          }
        : undefined
  };
}

async function loadInputComparisonViews(
  report: ScenarioIntegratedReport,
  rootDir: string
): Promise<InputComparisonView[]> {
  const artifacts = report.artifacts.filter((artifact) => artifact.kind === "interaction-trace");
  return Promise.all(
    artifacts.map(async (artifact) => {
      const artifactPath = String(artifact.path);
      try {
        const document = await readReportJson(rootDir, artifactPath);
        const lanes = isRecord(document.lanes) ? document.lanes : {};
        return {
          path: artifactPath,
          comparisonId: stringField(document, "comparisonId", "comparison"),
          name: stringField(document, "name", "Pointer and keyboard comparison"),
          status: stringField(document, "status", "unknown"),
          isolation: stringField(document, "isolation", "unknown"),
          equivalence: comparisonResultView(document.equivalence),
          expectation: comparisonResultView(document.expectation),
          pointer: comparisonLaneView(lanes.pointer),
          keyboard: comparisonLaneView(lanes.keyboard)
        };
      } catch (error) {
        return {
          path: artifactPath,
          comparisonId: "comparison",
          name: "Pointer and keyboard comparison",
          status: "unreadable",
          isolation: "unknown",
          equivalence: { verdict: "unknown", summary: "Comparison could not be read." },
          expectation: { verdict: "unknown", summary: "Expectation could not be read." },
          pointer: { actionIds: [] },
          keyboard: { actionIds: [] },
          readError: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
}

function comparisonResultView(value: unknown): InputComparisonView["equivalence"] {
  const result = isRecord(value) ? value : {};
  return {
    verdict: verdictField(result.verdict),
    summary: stringField(result, "summary", "No comparison summary was emitted.")
  };
}

function comparisonLaneView(value: unknown): InputComparisonView["keyboard"] {
  const lane = isRecord(value) ? value : {};
  const observation = isRecord(lane.observation) ? lane.observation : {};
  const steps = Array.isArray(lane.steps) ? lane.steps.filter(isRecord) : [];
  return {
    actionIds: steps.map((step) => {
      const action = isRecord(step.action) ? step.action : {};
      return stringField(action, "id", "unknown-action");
    }),
    url: optionalStringField(observation, "url"),
    visible: typeof observation.visible === "boolean" ? observation.visible : undefined,
    text: optionalStringField(observation, "text")
  };
}

/** Each full-page screenshot's size, so the Page view can scale boxes onto it. */
async function loadScreenViews(
  report: ScenarioIntegratedReport,
  rootDir: string
): Promise<ScreenView[]> {
  const paths = [
    ...new Set(
      report.artifacts
        .filter((artifact) => artifact.kind === "full-page-screenshot")
        .map((artifact) => String(artifact.path))
    )
  ];
  return Promise.all(
    paths.map(async (screenPath) => {
      // A PNG's width and height are the two big-endian numbers after its signature and IHDR tag.
      const header = Buffer.alloc(24);
      const file = await open(resolveReportPath(rootDir, screenPath)).catch(() => undefined);
      if (!file) return { path: screenPath };
      try {
        await file.read(header, 0, 24, 0);
      } finally {
        await file.close();
      }
      return header.toString("latin1", 1, 4) === "PNG"
        ? { path: screenPath, width: header.readUInt32BE(16), height: header.readUInt32BE(20) }
        : { path: screenPath };
    })
  );
}

/** Each checkpoint's element map, paired with the full-page screenshot taken with it. */
async function loadElementMapViews(
  report: ScenarioIntegratedReport,
  rootDir: string
): Promise<ElementMapView[]> {
  const runIdOf = (artifact: (typeof report.artifacts)[number]) => {
    const provenance = isRecord(artifact.provenance) ? artifact.provenance : {};
    return typeof provenance.runId === "string" ? provenance.runId : undefined;
  };
  const artifacts = report.artifacts.filter(
    (artifact) => artifact.kind === "element-map" && artifact.phase === "after"
  );
  return Promise.all(
    artifacts.map(async (artifact) => {
      const artifactPath = String(artifact.path);
      const runId = runIdOf(artifact);
      const screenshot = report.artifacts.find(
        (candidate) =>
          candidate.kind === "full-page-screenshot" &&
          candidate.phase === "after" &&
          runIdOf(candidate) === runId
      );
      const view = {
        path: artifactPath,
        runId,
        screenshotPath: screenshot ? String(screenshot.path) : undefined
      };
      try {
        const document = await readReportJson(rootDir, artifactPath);
        assertValidSchema("elementMap", document, artifactPath);
        return { ...view, map: document as unknown as ElementMap };
      } catch (error) {
        return { ...view, readError: error instanceof Error ? error.message : String(error) };
      }
    })
  );
}

async function loadSweepViews(
  report: ScenarioIntegratedReport,
  rootDir: string
): Promise<SweepView[]> {
  const artifacts = report.artifacts.filter(
    (artifact) => artifact.kind === "keyboard-pointer-sweep"
  );
  return Promise.all(
    artifacts.map(async (artifact) => {
      const artifactPath = String(artifact.path);
      try {
        const document = await readReportJson(rootDir, artifactPath);
        assertValidSchema("keyboardPointerSweepLane", document, artifactPath);
        const laneId = String(document.laneId);
        const screenshot = report.artifacts.find((candidate) => {
          const provenance = isRecord(candidate.provenance) ? candidate.provenance : {};
          return candidate.kind === "full-page-screenshot" && provenance.laneId === laneId;
        });
        return {
          path: artifactPath,
          screenshotPath: screenshot ? String(screenshot.path) : undefined,
          document: document as unknown as KeyboardPointerSweepLaneDocument
        };
      } catch (error) {
        return {
          path: artifactPath,
          readError: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
}

async function loadActionReportViews(
  report: ScenarioIntegratedReport,
  rootDir: string
): Promise<ActionReportView[]> {
  return Promise.all(
    report.actions.map(async (action) => {
      try {
        const document = await readReportJson(rootDir, action.reportPath);
        const judgments = Array.isArray(document.judgments)
          ? document.judgments.filter(isRecord).map((judgment) => ({
              judgeId: stringField(judgment, "judgeId", "unknown judge"),
              verdict: verdictField(judgment.verdict),
              severity: optionalStringField(judgment, "severity"),
              summary: stringField(judgment, "summary", "No summary was emitted."),
              suggestedFix: optionalStringField(judgment, "suggestedFix")
            }))
          : [];
        const observerSummaries = Array.isArray(document.records)
          ? document.records
              .filter(isRecord)
              .map((record) => optionalStringField(record, "summary"))
              .filter((summary): summary is string => Boolean(summary))
          : [];
        return { action, judgments, observerSummaries };
      } catch (error) {
        return {
          action,
          judgments: [],
          observerSummaries: [],
          readError: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
}

async function loadAxeReportViews(
  report: ScenarioIntegratedReport,
  rootDir: string
): Promise<AxeReportView[]> {
  const artifacts = report.artifacts.filter(
    (artifact) => artifact.kind === "axe-result" && artifact.phase === "after"
  );
  return Promise.all(
    artifacts.map(async (artifact) => {
      const artifactPath = String(artifact.path);
      const provenance = isRecord(artifact.provenance) ? artifact.provenance : {};
      const actionId = stringField(provenance, "actionId", "Unknown action");
      const laneId = stringField(provenance, "laneId", "unknown-lane");
      const runId = stringField(provenance, "runId", "unknown-run");
      try {
        const document = await readReportJson(rootDir, artifactPath);
        return {
          path: artifactPath,
          actionId,
          laneId,
          runId,
          violations: axeRuleViews(document.violations),
          incomplete: axeRuleViews(document.incomplete),
          passes: Array.isArray(document.passes) ? document.passes.length : 0,
          inapplicable: Array.isArray(document.inapplicable) ? document.inapplicable.length : 0
        };
      } catch (error) {
        return {
          path: artifactPath,
          actionId,
          laneId,
          runId,
          violations: [],
          incomplete: [],
          passes: 0,
          inapplicable: 0,
          readError: error instanceof Error ? error.message : String(error)
        };
      }
    })
  );
}

function axeRuleViews(value: unknown): AxeRuleView[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((rule) => {
    const rawNodes = Array.isArray(rule.nodes) ? rule.nodes.filter(isRecord) : [];
    const nodes = rawNodes.map((node) => ({
      target: Array.isArray(node.target) ? node.target.map(String).join(" → ") : "",
      html: optionalStringField(node, "html"),
      failureSummary: optionalStringField(node, "failureSummary"),
      targetBox: axeTargetBox(node.aeeTarget),
      context: isRecord(node.aeeContext)
        ? (node.aeeContext as unknown as ElementContext)
        : undefined,
      undecided: undecidedReason(node),
      contrast: isRecord(node.aeeContrast)
        ? (node.aeeContrast as unknown as ContrastMeasurement)
        : undefined
    }));
    const targets = nodes.map(({ target }) => target).filter(Boolean);
    const htmlSamples = nodes
      .map(({ html }) => html)
      .filter((sample): sample is string => Boolean(sample));
    const failureSummaries = [
      ...new Set(
        nodes
          .map(({ failureSummary }) => failureSummary)
          .filter((summary): summary is string => Boolean(summary))
      )
    ];
    return {
      id: stringField(rule, "id", "unknown-rule"),
      impact: optionalStringField(rule, "impact") ?? "review",
      help: stringField(rule, "help", "No help text was provided."),
      description: stringField(rule, "description", "No description was provided."),
      helpUrl: optionalStringField(rule, "helpUrl"),
      nodeCount: rawNodes.length,
      targets,
      htmlSamples,
      tags: Array.isArray(rule.tags) ? rule.tags.map(String) : [],
      failureSummary: nodes.length > 0 ? nodes[0]!.failureSummary : undefined,
      failureSummaries,
      nodes
    };
  });
}

/** axe's reason for leaving a node undecided, from its first check. */
function undecidedReason(node: Record<string, unknown>): AxeNodeView["undecided"] {
  const check = Array.isArray(node.any) && isRecord(node.any[0]) ? node.any[0] : undefined;
  if (!check) return undefined;
  const data = isRecord(check.data) ? check.data : {};
  return {
    key: typeof data.messageKey === "string" ? data.messageKey : "",
    message: optionalStringField(check, "message") ?? ""
  };
}

/** What is behind a text axe could not measure, in plain words, by axe's reason key. */
const CONTRAST_OBSTACLES: Record<string, string> = {
  bgGradient: "text over a gradient",
  bgImage: "text over a background image",
  imgNode: "text over an image",
  bgOverlap: "another element overlaps it",
  fgAlpha: "the text is see-through",
  elmPartiallyObscured: "part of it is covered",
  pseudoContent: "a pseudo-element sits behind it"
};

/** Why a text's contrast is left for a person, with AEE's measurement when there is one. */
function undecidedContrastReason(node: AxeNodeView): string {
  const obstacle =
    CONTRAST_OBSTACLES[node.undecided?.key ?? ""] ??
    (node.undecided?.message || "axe could not decide");
  const measured = node.contrast;
  if (!measured) return obstacle;
  if (measured.verdict === "unmeasured") return `${obstacle}; not measured, as ${measured.reason}`;
  return `${obstacle}, measured at ${measured.lowest.ratio}:1 to ${measured.highest.ratio}:1 against what is behind it, where ${measured.requiredRatio}:1 is needed`;
}

/** Every text whose contrast is left for a person, once, in the order the checkpoints met them. */
function undecidedContrast(views: IntegratedHtmlViews): ScenarioSynthesis["undecidedContrast"] {
  const texts = new Map<string, string>();
  for (const { incomplete } of views.axeReports) {
    for (const node of incomplete.find(({ id }) => id === "color-contrast")?.nodes ?? []) {
      if (!texts.has(node.target)) texts.set(node.target, undecidedContrastReason(node));
    }
  }
  return [...texts].map(([selector, reason]) => ({ selector, reason }));
}

function buildScenarioSynthesis(
  report: ScenarioIntegratedReport,
  views: IntegratedHtmlViews
): ScenarioSynthesis {
  const direct = views.actionReports.flatMap(({ judgments }) =>
    judgments.filter(({ judgeId }) => judgeId !== "release")
  );
  const directJudgments = countVerdicts(direct.map(({ verdict }) => verdict));
  const incompleteRules = views.axeReports.flatMap(({ incomplete }) =>
    incomplete.filter(({ tags }) => !isAdvisoryAxeRule(tags))
  );
  const uniqueIncompleteRules = [...new Set(incompleteRules.map(({ id }) => id))].sort();
  const findingOccurrences = report.findings.reduce((count, finding) => {
    return count + (Array.isArray(finding.occurrences) ? finding.occurrences.length : 0);
  }, 0);
  const readerJudgments = views.actionReports.flatMap(({ judgments }) =>
    judgments.filter(({ judgeId }) => judgeId === "screen-reader")
  );
  const readerCounts = countVerdicts(readerJudgments.map(({ verdict }) => verdict));
  const lanes = (
    ["keyboard", "pointer", "portable-virtual-screen-reader", "playwright-test"] as const
  )
    .map((driver) => {
      const laneReports = views.actionReports.filter(({ action }) => action.driver === driver);
      const judgments = laneReports.flatMap(({ judgments }) =>
        judgments.filter(({ judgeId }) => judgeId !== "release")
      );
      const counts = countVerdicts(judgments.map(({ verdict }) => verdict));
      return {
        driver,
        actions: laneReports.length,
        ...counts,
        summary: laneSummary(driver, laneReports, counts)
      };
    })
    .filter(({ actions }) => actions > 0);
  const findings = report.findings
    .map((finding) => buildFindingSynthesis(report, views, finding))
    .sort((left, right) => Number(left.advisory) - Number(right.advisory));
  const blocking = findings.filter(({ advisory }) => !advisory);
  const advisoryCount = findings.length - blocking.length;
  const affectedInstancesAtLargestCheckpoint = blocking.reduce(
    (total, finding) => total + finding.maximumAffectedNodes,
    0
  );
  const passedComparisons = views.comparisons.filter(
    ({ equivalence, expectation }) =>
      equivalence.verdict === "pass" && expectation.verdict === "pass"
  ).length;
  const reader = { commands: readerJudgments.length, ...readerCounts };
  const undecided = undecidedContrast(views);
  const status = buildStatusAreas(
    report,
    findings,
    views,
    reader,
    uniqueIncompleteRules,
    undecided
  );
  // A lane's good news is only told when its status row did not fail, so the two never disagree.
  const rowFailed = (id: StatusArea["id"]) =>
    status.some((area) => area.id === id && area.verdict === "fail");
  const positive = [
    readerJudgments.length && !rowFailed("reader")
      ? `${readerCounts.passed} of ${readerJudgments.length} virtual-reader commands passed cross-evidence validation`
      : undefined,
    views.comparisons.length && !rowFailed("keyboard")
      ? `${passedComparisons} of ${views.comparisons.length} pointer/keyboard comparisons matched both equivalence and the expected outcome`
      : undefined
  ].filter((item): item is string => Boolean(item));
  const negative = blocking.length
    ? `${blocking.length} grouped fix${blocking.length === 1 ? "" : "es"} cover ${affectedInstancesAtLargestCheckpoint} affected element-rule instance${affectedInstancesAtLargestCheckpoint === 1 ? "" : "s"} at the largest captured checkpoint and repeated across ${findingOccurrences} checkpoint result${findingOccurrences === 1 ? "" : "s"}`
    : "no confirmed fixes were emitted";
  const unresolved = uniqueIncompleteRules.length
    ? ` ${uniqueIncompleteRules.length} distinct Axe rule${uniqueIncompleteRules.length === 1 ? " remains" : "s remain"} unresolved and require review.`
    : "";
  const advisoryNote = advisoryCount
    ? ` ${advisoryCount} advisory result${advisoryCount === 1 ? " does" : "s do"} not block release.`
    : "";
  return {
    conclusion: `${positive.length ? `${positive.join("; ")}. ` : ""}Within the user-authored scope, ${negative}.${unresolved}${advisoryNote}`,
    directJudgments,
    releaseGates: {
      passed: report.summary.passed,
      failed: report.summary.failed,
      unknown: report.summary.unknown
    },
    findingOccurrences,
    affectedInstancesAtLargestCheckpoint,
    incompleteRuleResults: incompleteRules.length,
    uniqueIncompleteRules,
    lanes,
    comparisons: views.comparisons,
    reader,
    status,
    findings,
    undecidedContrast: undecided
  };
}

/**
 * The report's status rows. A row fails when a blocking finding in its area does, so a row can
 * never say "no confirmed issue" while the fix list holds one; advisory results are named but
 * never fail a row.
 */
function buildStatusAreas(
  report: ScenarioIntegratedReport,
  findings: FindingSynthesis[],
  views: IntegratedHtmlViews,
  reader: ScenarioSynthesis["reader"],
  uniqueIncompleteRules: string[],
  undecided: ScenarioSynthesis["undecidedContrast"]
): StatusArea[] {
  const blockingIn = (area: FindingSynthesis["area"]) =>
    findings.filter((finding) => finding.area === area && !finding.advisory);
  const advisoryNote = (area: FindingSynthesis["area"]) => {
    const advisory = findings.filter((finding) => finding.area === area && finding.advisory);
    return advisory.length ? ` Advisory: ${advisory.map(({ title }) => title).join("; ")}.` : "";
  };
  const fixRequired = (id: StatusArea["id"], label: string, detail: string): StatusArea => ({
    id,
    label,
    verdict: "fail",
    result: "Fix required",
    detail
  });
  const needsReview = (id: StatusArea["id"], label: string, detail: string): StatusArea => ({
    id,
    label,
    verdict: "unknown",
    result: "Needs review",
    detail
  });
  const noIssue = (id: StatusArea["id"], label: string, detail: string): StatusArea => ({
    id,
    label,
    verdict: "pass",
    result: "No confirmed issue",
    detail
  });
  const notRun = (id: StatusArea["id"], label: string, detail: string): StatusArea => ({
    id,
    label,
    verdict: "not-run",
    result: "Not in this run",
    detail
  });
  const { plannedChecks } = report.completeness;
  // The test fixture checks each page with axe alone; a scenario run adds the other checks.
  // The test fixture checks a page by keyboard and with the reader once per run, where a passing
  // test ends on it; a scenario run checks every journey's start page.
  const fixture = report.profile === "playwright-test";
  const titles = (list: FindingSynthesis[]) => `${list.map(({ title }) => title).join("; ")}.`;
  const rulesRan = views.axeReports.length > 0;

  const keyboardFindings = blockingIn("keyboard");
  const swept =
    views.sweeps.length > 0 &&
    views.sweeps.every(({ document }) => document?.status === "completed");
  const comparisonsPassed = views.comparisons.every(
    ({ equivalence, expectation }) =>
      equivalence.verdict === "pass" && expectation.verdict === "pass"
  );
  const pressed = views.sweeps.every(({ document }) => document?.activateControls);
  const keyboard = keyboardFindings.length
    ? fixRequired("keyboard", "Keyboard access", titles(keyboardFindings))
    : !plannedChecks.keyboard
      ? notRun(
          "keyboard",
          "Keyboard access",
          fixture
            ? "Not for this test: the test fixture sweeps each page once per run, where the first passing test ends on it, and this test's page was swept in another test, is not a web page, or the check is off."
            : "This scenario's plan has no keyboard and mouse sweep."
        )
      : swept && comparisonsPassed
        ? noIssue(
            "keyboard",
            "Keyboard access",
            `Tab reached every mouse target and focus showed everything hover did. ${pressed ? "Each control pressed by keyboard matched the click and kept focus." : `Controls were not pressed: ${ACTIVATE_PAGE_CONTROLS} is not allowed.`}`
          )
        : needsReview("keyboard", "Keyboard access", "No complete keyboard result was available.");

  const unnamed = new Map<string, string>();
  for (const { entries } of views.transcripts) {
    for (const entry of entries) {
      if (
        entry.role &&
        entry.nodePath &&
        announcedWithoutName({ role: entry.role, name: entry.name })
      ) {
        unnamed.set(entry.nodePath, `“${entry.announcement}” at ${entry.nodePath}`);
      }
    }
  }
  const readerRow = unnamed.size
    ? fixRequired(
        "reader",
        "Virtual reader",
        `Announced without a name: ${[...unnamed.values()].join(", ")}.`
      )
    : !plannedChecks.reader
      ? notRun(
          "reader",
          "Virtual reader",
          fixture
            ? "Not for this test: the test fixture reads each page once per run, where the first passing test ends on it, and this test's page was read in another test, is not a web page, or the check is off."
            : "No virtual screen-reader commands were chosen; a journey's virtualScreenReaderCommands add them."
        )
      : reader.commands > 0 && reader.failed === 0
        ? {
            id: "reader" as const,
            label: "Virtual reader",
            verdict: "pass" as const,
            result: `${reader.passed}/${reader.commands} commands passed`,
            detail: "Each announcement matched the accessibility tree, visuals and focus state."
          }
        : needsReview(
            "reader",
            "Virtual reader",
            reader.commands
              ? `${reader.commands - reader.passed} of ${reader.commands} commands did not pass the cross-evidence check.`
              : "No virtual screen-reader commands were run."
          );

  const semanticFindings = blockingIn("semantics");
  const semantics = semanticFindings.length
    ? fixRequired("semantics", "Semantics", titles(semanticFindings) + advisoryNote("semantics"))
    : rulesRan
      ? noIssue(
          "semantics",
          "Semantics",
          `No semantic rule failure was confirmed in the tested scope.${advisoryNote("semantics")}`
        )
      : needsReview("semantics", "Semantics", "No rule checks ran in the tested scope.");

  const contrastFindings = blockingIn("contrast");
  const contrast = contrastFindings.length
    ? fixRequired("contrast", "Visual contrast", contrastDetail(contrastFindings))
    : uniqueIncompleteRules.includes("color-contrast")
      ? needsReview(
          "contrast",
          "Visual contrast",
          `${undecided.length} ${undecided.length === 1 ? "text needs" : "texts need"} a person: axe could not measure what is behind ${undecided.length === 1 ? "it" : "them"}, and the pixels did not settle it. Each is listed with why.`
        )
      : rulesRan
        ? noIssue(
            "contrast",
            "Visual contrast",
            "No contrast failure was confirmed in the tested scope."
          )
        : needsReview("contrast", "Visual contrast", "No rule checks ran in the tested scope.");

  return [keyboard, readerRow, semantics, contrast];
}

/** What the contrast failures are, from their own elements: links only when every one is a link. */
function contrastSubject(instances: FindingInstanceSynthesis[]): "link" | "text" {
  return instances.length > 0 && instances.every(({ tagName }) => tagName === "a")
    ? "link"
    : "text";
}

function contrastDetail(findings: FindingSynthesis[]): string {
  const instances = findings.flatMap(({ instances }) => instances);
  const count = instances.length;
  const noun = contrastSubject(instances) === "link" ? "link" : "text element";
  const ratios = [
    ...new Set(
      instances.flatMap(({ detail }) => {
        const ratio = requiredContrastRatio(detail ?? "");
        return ratio ? [ratio] : [];
      })
    )
  ];
  const required = ratios.length === 1 ? `${ratios[0]}:1 ` : "";
  return `${count} ${noun}${count === 1 ? " falls" : "s fall"} below the required ${required}contrast ratio.`;
}

/** The ratio axe required, from its own failure text ("Expected contrast ratio of 4.5:1"). */
function requiredContrastRatio(text: string): number | undefined {
  const ratio = /Expected contrast ratio of ([0-9.]+):1/i.exec(text)?.[1];
  return ratio ? Number(ratio) : undefined;
}

/** Pure synthesis entry point used to verify cross-evidence reporting without launching a browser. */
export function buildScenarioSynthesisForTest(
  report: ScenarioIntegratedReport,
  views: unknown
): ScenarioSynthesis {
  return buildScenarioSynthesis(report, views as IntegratedHtmlViews);
}

/** Pure HTML entry point used to verify the portable report without running a browser journey. */
export function renderFixesCsvForTest(report: ScenarioIntegratedReport, views: unknown): string {
  return renderFixesCsv(report, views as IntegratedHtmlViews);
}

export function renderIntegratedHtmlForTest(
  report: ScenarioIntegratedReport,
  views: unknown
): string {
  return renderIntegratedHtml(report, views as IntegratedHtmlViews);
}

function countVerdicts(verdicts: Array<"pass" | "fail" | "unknown">) {
  return {
    passed: verdicts.filter((verdict) => verdict === "pass").length,
    failed: verdicts.filter((verdict) => verdict === "fail").length,
    unknown: verdicts.filter((verdict) => verdict === "unknown").length
  };
}

function laneSummary(
  driver: ScenarioActionReport["driver"],
  reports: ActionReportView[],
  counts: { passed: number; failed: number; unknown: number }
): string {
  const label = humanDriverName(driver);
  const failingJudges = [
    ...new Set(
      reports.flatMap(({ judgments }) =>
        judgments
          .filter(({ judgeId, verdict }) => judgeId !== "release" && verdict === "fail")
          .map(({ judgeId }) => judgeId)
      )
    )
  ];
  const noun = driver === "playwright-test" ? "checkpoint" : "authored action";
  return `${label} ran ${reports.length} ${noun}${reports.length === 1 ? "" : "s"}: ${counts.passed} direct checks passed, ${counts.failed} failed, and ${counts.unknown} were unresolved.${failingJudges.length ? ` Failing judges: ${failingJudges.join(", ")}.` : ""}`;
}

function buildFindingSynthesis(
  report: ScenarioIntegratedReport,
  views: IntegratedHtmlViews,
  finding: Record<string, unknown>
): FindingSynthesis {
  const ruleId = String(finding.ruleId ?? finding.id ?? "unknown-finding");
  if (isSweepFindingKind(ruleId)) return buildSweepFindingSynthesis(views, ruleId, finding);
  const matchingReports = views.axeReports
    .map((axeReport) => ({
      axeReport,
      rule: axeReport.violations.find(({ id }) => id === ruleId)
    }))
    .filter((entry): entry is { axeReport: AxeReportView; rule: AxeRuleView } =>
      Boolean(entry.rule)
    );
  const allRules = matchingReports.map(({ rule }) => rule);
  const representative = allRules.reduce<AxeRuleView | undefined>(
    (largest, rule) => (!largest || rule.nodeCount > largest.nodeCount ? rule : largest),
    undefined
  );
  const checkpoints = matchingReports.map(({ axeReport, rule }) => {
    const action = report.actions.find(
      (candidate) => candidate.runId === axeReport.runId && candidate.laneId === axeReport.laneId
    );
    const actionView = views.actionReports.find(
      (candidate) => candidate.action.runId === axeReport.runId
    );
    const behavior = actionView?.judgments.find(
      ({ judgeId }) => judgeId !== "axe" && judgeId !== "release"
    );
    return {
      actionId: axeReport.actionId,
      laneId: axeReport.laneId,
      runId: axeReport.runId,
      driver: action?.driver ?? driverFromLaneId(axeReport.laneId),
      behaviorVerdict: behavior?.verdict ?? "unknown",
      behaviorSummary: behavior?.summary ?? "No independent behavior judgment was available.",
      nodeCount: rule.nodeCount,
      targets: rule.targets.slice(0, 8),
      htmlSamples: rule.htmlSamples.slice(0, 3),
      axePath: axeReport.path,
      domPath: action ? actionArtifactPath(report, action, "dom-snapshot", "after") : undefined,
      accessibilityTreePath: action
        ? actionArtifactPath(report, action, "accessibility-tree", "after")
        : undefined,
      focusPath: action ? actionArtifactPath(report, action, "focus-state", "after") : undefined,
      screenshotPath: action
        ? actionArtifactPath(report, action, "full-page-screenshot", "after")
        : undefined,
      viewportPath: action
        ? actionArtifactPath(report, action, "viewport-screenshot", "after")
        : undefined,
      readerTranscriptPath: action
        ? actionArtifactPath(
            report,
            action,
            "screen-reader-transcript",
            "after",
            /json-after\.json$/
          )
        : undefined
    };
  });
  const occurrenceCount = Array.isArray(finding.occurrences)
    ? finding.occurrences.length
    : checkpoints.length;
  const wcagCriteria = [
    ...new Set(allRules.flatMap(({ tags }) => tags.map(wcagCriterionFromTag).filter(Boolean)))
  ] as string[];
  const maximumAffectedNodes = Math.max(0, ...allRules.map(({ nodeCount }) => nodeCount));
  const instances = findingInstances(ruleId, representative);
  const componentCount = new Set(instances.map(({ component }) => component)).size;
  const remediation = findingRemediation(ruleId, representative);
  return {
    ruleId,
    title: representative?.help ?? String(finding.message ?? ruleId),
    severity: String(finding.severity ?? representative?.impact ?? "review"),
    area: axeRuleArea(representative?.tags ?? []),
    advisory: isAdvisoryFinding(finding),
    wcagCriteria,
    pattern: patternForAxeRule(ruleId),
    conclusion: `${representative?.description ?? String(finding.message ?? "A confirmed issue was emitted.")} The same rule was observed at ${checkpoints.length} of ${views.axeReports.length} after-action checkpoints; the largest checkpoint affected ${maximumAffectedNodes} node${maximumAffectedNodes === 1 ? "" : "s"}. Independent behavior results remain shown separately and do not cancel this rule failure.`,
    occurrenceCount,
    checkpointCount: checkpoints.length,
    maximumAffectedNodes,
    instanceCount: instances.length,
    componentCount,
    instances,
    checkpoints,
    remediation
  };
}

/** A sweep finding, grouped like an axe rule: one checkpoint per swept page that shows it. */
function buildSweepFindingSynthesis(
  views: IntegratedHtmlViews,
  kind: SweepFindingKind,
  finding: Record<string, unknown>
): FindingSynthesis {
  const swept = views.sweeps.flatMap(({ path: sweepPath, screenshotPath, document }) => {
    const matches = (document?.findings ?? []).filter((candidate) => candidate.kind === kind);
    return document && matches.length ? [{ sweepPath, screenshotPath, document, matches }] : [];
  });
  const checkpoints: FindingCheckpointSynthesis[] = swept.map(
    ({ sweepPath, screenshotPath, document, matches }) => ({
      actionId: "keyboard-pointer-sweep",
      laneId: document.laneId,
      runId: document.laneId,
      driver: "keyboard-pointer-sweep",
      behaviorVerdict: "fail",
      behaviorSummary: matches[0]!.summary,
      nodeCount: matches.length,
      targets: matches.slice(0, 8).map(({ selector }) => selector),
      htmlSamples: [],
      screenshotPath,
      sweepPath
    })
  );
  const representative = swept.reduce<(typeof swept)[number] | undefined>(
    (largest, entry) =>
      !largest || entry.matches.length > largest.matches.length ? entry : largest,
    undefined
  );
  const instances = (representative?.matches ?? []).map(sweepFindingInstance);
  const maximumAffectedNodes = representative?.matches.length ?? 0;
  const entry = remediationEntry(SWEEP_FINDING_CONCEPTS[kind]);
  const text = SWEEP_FINDING_TEXT[kind];
  return {
    ruleId: kind,
    title: text.title,
    severity: String(finding.severity ?? "high"),
    area: text.area,
    advisory: Boolean(text.advisory),
    wcagCriteria: entry.requirements
      .filter(({ standard, relationship }) => standard === "WCAG" && relationship === "primary")
      .map(({ requirementId }) => `WCAG ${requirementId}`),
    pattern: entry.patterns[0] ? patternLink(entry.patterns[0]) : undefined,
    conclusion: representative
      ? `${representative.matches[0]!.summary} The keyboard and pointer sweep found this on ${checkpoints.length} of ${views.sweeps.length} swept page${views.sweeps.length === 1 ? "" : "s"}.`
      : "The sweep reported this finding, but its evidence could not be read.",
    occurrenceCount: Array.isArray(finding.occurrences)
      ? finding.occurrences.length
      : checkpoints.length,
    checkpointCount: checkpoints.length,
    maximumAffectedNodes,
    instanceCount: instances.length,
    componentCount: new Set(instances.map(({ component }) => component)).size,
    instances,
    checkpoints,
    remediation: {
      deterministic: text.fix,
      ai: registryAi(entry),
      verification: entry.verification
    }
  };
}

function sweepFindingInstance(
  finding: KeyboardPointerSweepLaneFinding,
  index: number
): FindingInstanceSynthesis {
  return {
    component: affectedComponentName(finding.selector),
    label: finding.label || elementLabel(undefined, finding.selector, index),
    selector: finding.selector,
    targetBox: finding.targetBox,
    detail: finding.summary
  };
}

function actionArtifactPath(
  report: ScenarioIntegratedReport,
  action: ScenarioActionReport,
  kind: string,
  phase: string,
  pathPattern?: RegExp
): string | undefined {
  const artifact = report.artifacts.find((candidate) => {
    const provenance = isRecord(candidate.provenance) ? candidate.provenance : {};
    return (
      candidate.kind === kind &&
      candidate.phase === phase &&
      provenance.runId === action.runId &&
      (!pathPattern || pathPattern.test(String(candidate.path)))
    );
  });
  return artifact ? String(artifact.path) : undefined;
}

/**
 * Reported, never blocking: an axe best-practice result (the axe judge tags it so) or a sweep
 * finding from a heuristic check.
 */
function isAdvisoryFinding(finding: Record<string, unknown>): boolean {
  const ruleId = String(finding.ruleId);
  return (
    (Array.isArray(finding.tags) && finding.tags.includes("best-practice")) ||
    (isSweepFindingKind(ruleId) && Boolean(SWEEP_FINDING_TEXT[ruleId].advisory))
  );
}

/** Which status row an axe rule belongs to, from axe's own category tags. */
function axeRuleArea(tags: string[]): FindingSynthesis["area"] {
  if (tags.includes("cat.color")) return "contrast";
  if (tags.includes("cat.keyboard")) return "keyboard";
  return "semantics";
}

function driverFromLaneId(laneId: string): ScenarioActionReport["driver"] {
  if (laneId.endsWith("-keyboard")) return "keyboard";
  if (laneId.endsWith("-pointer")) return "pointer";
  return "portable-virtual-screen-reader";
}

function wcagCriterionFromTag(tag: string): string | undefined {
  const match = /^wcag(\d)(\d)(\d+)$/.exec(tag);
  return match ? `WCAG ${match[1]}.${match[2]}.${match[3]}` : undefined;
}

function findingInstances(
  ruleId: string,
  rule: AxeRuleView | undefined
): FindingInstanceSynthesis[] {
  if (!rule) return [];
  const nodeViews = Array.isArray(rule.nodes) ? rule.nodes : [];
  const nodes = nodeViews.length
    ? nodeViews
    : rule.targets.map((target, index) => ({
        target,
        html: rule.htmlSamples[index],
        failureSummary: rule.failureSummary,
        targetBox: undefined
      }));
  const seen = new Set<string>();
  return nodes.flatMap((node, index) => {
    const selector = node.target || `Affected element ${index + 1}`;
    if (seen.has(selector)) return [];
    seen.add(selector);
    const tagName = htmlTagName(node.html);
    return [
      {
        component: affectedComponentName(selector, node.html),
        label: elementLabel(node.html, selector, index),
        selector,
        ...(tagName ? { tagName } : {}),
        targetBox: node.targetBox,
        detail: node.failureSummary
          ?.replace(/^Fix any of the following:\s*/i, "")
          .replace(/\s+/g, " ")
          .trim()
      }
    ];
  });
}

function axeTargetBox(value: unknown): AxeTargetBox | undefined {
  if (!isRecord(value)) return undefined;
  const keys = ["x", "y", "width", "height", "pageWidth", "pageHeight"] as const;
  if (keys.some((key) => typeof value[key] !== "number" || !Number.isFinite(value[key]))) {
    return undefined;
  }
  return Object.fromEntries(keys.map((key) => [key, value[key]])) as unknown as AxeTargetBox;
}

/** A component name from the element's own place: inside a footer, or its id or first class. */
function affectedComponentName(selector: string, html?: string): string {
  if (`${selector} ${html ?? ""}`.toLowerCase().includes("footer")) return "Footer";
  const id = /#([a-z0-9_-]+)/i.exec(selector)?.[1];
  if (id) return humanActionName(id.replaceAll("_", "-"));
  const className = /\.([a-z0-9_-]+)/i.exec(selector)?.[1];
  return className ? humanActionName(className.replaceAll("_", "-")) : "Page component";
}

/** What a person looks for on the page when an element has no text or id to go by. */
const ELEMENT_KINDS = new Map([
  ["a", "Link"],
  ["button", "Button"],
  ["iframe", "Frame"],
  ["img", "Image"],
  ["input", "Field"],
  ["select", "Field"],
  ["svg", "Graphic"],
  ["textarea", "Field"],
  ["video", "Video"]
]);

function htmlTagName(html: string | undefined): string | undefined {
  return /^<\s*([a-z][a-z0-9-]*)/i.exec(html ?? "")?.[1]?.toLowerCase();
}

function elementLabel(html: string | undefined, selector: string, index: number): string {
  const text = html
    ?.replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
  if (text) return text;
  const id = /#([a-z0-9_-]+)/i.exec(selector)?.[1];
  if (id) return humanActionName(id.replaceAll("_", "-"));
  const source = /\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(html ?? "")?.[1];
  const file = source?.startsWith("data:") ? undefined : source?.split(/[?#]/)[0]?.split("/").pop();
  return `${ELEMENT_KINDS.get(htmlTagName(html) ?? "") ?? "Element"} ${file || index + 1}`;
}

function findingRemediation(
  ruleId: string,
  rule: AxeRuleView | undefined
): FindingSynthesis["remediation"] {
  const measured = rule?.failureSummaries
    .slice(0, 3)
    .map((summary) => summary.replace(/^Fix any of the following:\s*/i, "").trim())
    .join(" ");
  if (ruleId === "aria-required-parent") {
    return {
      deterministic:
        'For ordinary navigation links, remove role="menuitem" and keep native link semantics. If the controls intentionally form an application-style menu, place each menuitem inside an element with role="menu", role="menubar", or role="group" and implement the complete keyboard pattern. ' +
        (measured ?? "Rerun the ARIA parent relationship check after changing the structure."),
      ai: {
        used: false,
        status: "not-applicable",
        reason:
          "The required parent-role relationship is deterministic. A language or vision model should not choose whether invalid ARIA passes."
      },
      verification: [
        "Rerun axe at the same checkpoints and require aria-required-parent to pass.",
        "Confirm the affected controls remain reachable with Tab, with unchanged names and destinations.",
        "Confirm DOM roles match the accessibility tree after the fix."
      ]
    };
  }
  if (ruleId === "color-contrast") {
    const required = requiredContrastRatio(measured ?? "") ?? 4.5;
    return {
      deterministic:
        (measured ? `${measured} ` : "") +
        `Choose a brand-approved foreground/background token pair that computes to at least ${required}:1 for this text, then verify every applicable default, hover, focus, and active state.`,
      ai: {
        used: false,
        status: "available-if-needed",
        reason:
          "A visual specialist may locate complex foreground/background regions or explain brand intent when deterministic extraction is inconclusive. The final contrast ratio and token selection must still be calculated deterministically."
      },
      verification: [
        `Recompute the exact contrast ratio from final rendered colors and require at least ${required}:1.`,
        "Compare the corrected state with the full-page visual and DOM computed styles.",
        "Rerun the same keyboard, pointer, and virtual-reader checkpoints."
      ]
    };
  }
  return {
    deterministic: `${rule ? `${rule.help.replace(/\.?$/, ".")} ` : ""}Fix every affected element listed here, then rerun the same authored journey.`,
    ai: registryAi(conceptForAxeRule(ruleId)),
    verification: [
      "Rerun the same action and require the rule to pass.",
      "Confirm DOM, accessibility tree, focus, visual, and screen-reader evidence still agree."
    ]
  };
}

/** The AI stance the registry gives a concept; a finding the registry does not map gets none. */
function registryAi(entry: { ai: { allowed: boolean; purpose: string } } | undefined): FindingAi {
  if (!entry) {
    return {
      used: false,
      status: "not-applicable",
      reason:
        "No allowlisted contextual AI task is defined for this finding; deterministic evidence remains authoritative."
    };
  }
  return {
    used: false,
    status: entry.ai.allowed ? "available-if-needed" : "not-applicable",
    reason: entry.ai.purpose
  };
}

/** Why an allowlisted finding got no AI answer: `aee run` names no model unless told to. */
const AEE_RUN_AI_SETUP =
  "AI may suggest wording here, but aee run sends page evidence to a model only when you name one: set AEE_LLM_PROVIDER=local for a model on this machine (Ollama with gemma4:e4b by default), or AEE_LLM_PROVIDER=claude with ANTHROPIC_API_KEY.";

/** How many elements of one finding a specialist is asked about, which bounds a run's cost. */
const AI_ELEMENTS_PER_FINDING = 10;

/**
 * The model for `aee run`. Page evidence goes to a model only when AEE_LLM_PROVIDER names one: an
 * API key that happens to be set is not consent to send captured page content anywhere.
 */
export function aeeRunModelProvider(
  env: Record<string, string | undefined> = process.env
): ModelProvider {
  return createModelProvider({
    env,
    provider: parseModelProviderName(env.AEE_LLM_PROVIDER) ?? "stub"
  });
}

type AiOutcome = { suggestion: AiSuggestion } | { note: string } | { notConfigured: true };

interface AiSuggester {
  providerId: string;
  /** Asks the specialist about one element, once per run; undefined when it is not implemented. */
  suggest(
    specialistId: string,
    selector: string,
    context: ElementContext
  ): Promise<AiOutcome> | undefined;
}

/** The implemented registry specialists, each turning captured context into its question. */
const AI_SPECIALISTS: Record<
  string,
  (selector: string, context: ElementContext, provider: ModelProvider) => Promise<AiSuggestion>
> = {
  [accessibleNameSpecialist.id]: async (selector, context, provider) => {
    const fix = await proposeAccessibleLabelFix(
      {
        selector,
        role: context.role ?? ({ a: "link", button: "button" }[context.tagName] || context.tagName),
        iconDescription: context.iconOnly
          ? context.iconHints.length
            ? `an icon; its markup mentions ${context.iconHints.join(", ")}`
            : "an icon with no text or description in its markup"
          : undefined,
        nearbyHeading: context.nearbyHeading,
        nearbyText: context.nearbyText,
        destinationText: context.destination
      },
      provider
    );
    return aiSuggestion(selector, fix, fix.answer.suggestedName);
  },
  [imagePurposeSpecialist.id]: async (selector, context, provider) => {
    const image = context.image;
    const fix = await proposeImageAlternativeFix(
      {
        selector,
        source: image?.source,
        currentAlternative: image?.alt,
        markupRole: imageRoleFromMarkup({
          role: image?.role,
          ariaHidden: image?.ariaHidden,
          alt: image?.alt,
          soleContentOfLinkOrButton: image?.soleContentOfLinkOrButton
        }),
        linkOrButtonText: image?.linkOrButtonText,
        caption: image?.caption,
        title: image?.title,
        nearbyHeading: context.nearbyHeading,
        nearbyText: context.nearbyText
      },
      provider
    );
    return {
      ...aiSuggestion(selector, fix, fix.answer.suggestedAlternative),
      classification: fix.answer.classification
    };
  }
};

function aiSuggestion(
  selector: string,
  fix: AiProposedFix<{ rationale: string; confidence: number; citedEvidenceIds: string[] }>,
  text: string
): AiSuggestion {
  return {
    selector,
    text,
    rationale: fix.answer.rationale,
    confidence: fix.answer.confidence,
    citedEvidenceIds: fix.answer.citedEvidenceIds,
    patch: fix.patches?.[0] ?? ""
  };
}

/** Remembers each answer, so writing the report twice asks the model once. */
function createAiSuggester(provider: ModelProvider): AiSuggester {
  const outcomes = new Map<string, Promise<AiOutcome>>();
  return {
    providerId: provider.id,
    suggest(specialistId, selector, context) {
      const run = AI_SPECIALISTS[specialistId];
      if (!run) return undefined;
      const key = `${specialistId}\n${selector}`;
      if (!outcomes.has(key)) {
        outcomes.set(
          key,
          run(selector, context, provider).then(
            (suggestion) => ({ suggestion }),
            (error: unknown) =>
              error instanceof AiNotConfiguredError
                ? { notConfigured: true }
                : { note: `${selector}: ${error instanceof Error ? error.message : String(error)}` }
          )
        );
      }
      return outcomes.get(key);
    }
  };
}

/**
 * Asks the registry's specialist about each affected element of an allowlisted finding, from the
 * context captured with the axe result. Answers are labelled AI and never change a verdict.
 */
async function addAiSuggestions(
  report: ScenarioIntegratedReport,
  views: IntegratedHtmlViews,
  suggester: AiSuggester
): Promise<void> {
  for (const finding of report.synthesis.findings) {
    const specialistId = conceptForAxeRule(finding.ruleId)?.ai.specialistId;
    if (!specialistId) continue;
    const contexts = new Map(
      views.axeReports
        .flatMap(({ violations }) => violations)
        .filter(({ id }) => id === finding.ruleId)
        .flatMap(({ nodes }) => nodes)
        .flatMap(({ target, context }) => (context ? [[target, context] as const] : []))
    );
    const asked = finding.instances.slice(0, AI_ELEMENTS_PER_FINDING);
    const outcomes = await Promise.all(
      asked.flatMap(({ selector }) => {
        const context = contexts.get(selector);
        const outcome = context && suggester.suggest(specialistId, selector, context);
        return outcome ? [outcome] : [];
      })
    );
    if (outcomes.length === 0) continue;
    const skipped = finding.instances.length - asked.length;
    finding.remediation.ai = findingAi(
      specialistId,
      suggester.providerId,
      outcomes,
      finding.remediation.ai.reason,
      skipped > 0
        ? [`AI was asked about the first ${asked.length} of ${finding.instances.length} elements.`]
        : []
    );
  }
  const suggestions = report.synthesis.findings.reduce(
    (total, finding) => total + (finding.remediation.ai.suggestions?.length ?? 0),
    0
  );
  report.ai = suggestions
    ? {
        present: true,
        label: `AI-generated suggestions: ${suggestions}, from ${suggester.providerId}. Each is labelled AI and needs review; none passes or fails anything.`
      }
    : { present: false, label: "AI-generated analysis: none in this report." };
}

function findingAi(
  specialistId: string,
  providerId: string,
  outcomes: AiOutcome[],
  purpose: string,
  notes: string[]
): FindingAi {
  if (outcomes.some((outcome) => "notConfigured" in outcome)) {
    return { used: false, status: "not-configured", reason: AEE_RUN_AI_SETUP, specialistId };
  }
  const suggestions = outcomes.flatMap((outcome) =>
    "suggestion" in outcome ? [outcome.suggestion] : []
  );
  const allNotes = [
    ...outcomes.flatMap((outcome) => ("note" in outcome ? [outcome.note] : [])),
    ...notes
  ];
  return {
    used: suggestions.length > 0,
    status: suggestions.length > 0 ? "suggested" : "available-if-needed",
    reason: suggestions.length > 0 ? `${purpose} Review each suggestion before use.` : purpose,
    specialistId,
    ...(suggestions.length > 0 ? { providerId, suggestions } : {}),
    ...(allNotes.length > 0 ? { notes: allNotes } : {})
  };
}

async function readReportJson(
  rootDir: string,
  reportPath: string
): Promise<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(
    await readFile(resolveReportPath(rootDir, reportPath), "utf8")
  );
  if (!isRecord(parsed)) throw new Error(`Expected ${reportPath} to contain a JSON object.`);
  return parsed;
}

function resolveReportPath(rootDir: string, reportPath: string): string {
  const root = path.resolve(rootDir);
  const resolved = path.resolve(root, reportPath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`Report evidence path must stay inside ${root}.`);
  }
  return resolved;
}

function renderIntegratedMarkdown(report: ScenarioIntegratedReport): string {
  const lines = [
    `# Accessibility evidence report: ${reportName(report)}`,
    "",
    `**Overall verdict:** ${report.verdict.toUpperCase()}`,
    `**Evidence completeness:** ${report.completeness.status.toUpperCase()}`,
    `**Target:** ${report.target}`,
    `**Standard:** ${report.standard}`,
    `**AI output:** ${report.ai.label}`,
    "",
    "## Summary",
    "",
    report.synthesis.conclusion,
    "",
    `- ${report.summary.actions} user-authored actions evaluated across ${report.synthesis.lanes.length} active lanes`,
    `- ${report.synthesis.directJudgments.passed} direct judgments passed, ${report.synthesis.directJudgments.failed} failed, ${report.synthesis.directJudgments.unknown} unresolved`,
    `- ${report.summary.findings} grouped fixes covering ${report.synthesis.affectedInstancesAtLargestCheckpoint} affected element-rule instances at the largest checkpoint`,
    `- ${report.summary.advisories} advisory results: they do not block release`,
    `- ${report.synthesis.uniqueIncompleteRules.length} unique incomplete Axe rules across ${report.synthesis.incompleteRuleResults} checkpoint results`,
    `- ${report.summary.artifacts} indexed artifacts`,
    "",
    "## Status",
    "",
    "| Area | Result | Detail |",
    "| --- | --- | --- |",
    ...report.synthesis.status.map(
      ({ label, result, detail }) =>
        `| ${escapeMarkdown(label)} | ${escapeMarkdown(result)} | ${escapeMarkdown(detail)} |`
    ),
    "",
    "## Coverage by lane",
    "",
    "| Lane | Actions | Direct pass | Direct fail | Unresolved |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...report.synthesis.lanes.map(
      (lane) =>
        `| ${escapeMarkdown(humanDriverName(lane.driver))} | ${lane.actions} | ${lane.passed} | ${lane.failed} | ${lane.unknown} |`
    ),
    "",
    "## Consolidated findings",
    ""
  ];
  if (report.findings.length === 0) lines.push("No findings were emitted.");
  for (const finding of report.synthesis.findings) {
    lines.push(
      `### ${escapeMarkdown(finding.ruleId)} — ${escapeMarkdown(finding.title)}${finding.advisory ? " (advisory)" : ""}`,
      "",
      finding.conclusion,
      "",
      `**WCAG:** ${finding.wcagCriteria.length ? finding.wcagCriteria.join(", ") : "Mapping not emitted"}`,
      "",
      `**Pattern:** ${finding.pattern ? `[${finding.pattern.id}](${finding.pattern.url}) (a11y-skills)` : "No pattern is mapped for this rule yet."}`,
      "",
      `**Deterministic remediation:** ${finding.remediation.deterministic}`,
      "",
      `**AI:** ${aiMarkdown(finding.remediation.ai)}`,
      "",
      `**Affected instances:** ${finding.instanceCount} distinct page locations in ${finding.componentCount} component group${finding.componentCount === 1 ? "" : "s"}; repeated at ${finding.checkpointCount} checkpoints.`,
      "",
      ...(finding.instances.length
        ? [
            "| Component | Element | Selector |",
            "| --- | --- | --- |",
            ...finding.instances.map(
              (instance) =>
                `| ${escapeMarkdown(instance.component)} | ${escapeMarkdown(instance.label)} | \`${escapeMarkdown(instance.selector)}\` |`
            ),
            ""
          ]
        : []),
      "| Lane | Action | Behavior | Nodes | DOM | Accessibility tree | Visual | Focus | Axe |",
      "| --- | --- | --- | ---: | --- | --- | --- | --- | --- |",
      ...finding.checkpoints.map(
        (checkpoint) =>
          `| ${escapeMarkdown(humanDriverName(checkpoint.driver))} | ${escapeMarkdown(humanActionName(checkpoint.actionId))} | ${checkpoint.behaviorVerdict} | ${checkpoint.nodeCount} | ${markdownEvidenceLink(checkpoint.domPath)} | ${markdownEvidenceLink(checkpoint.accessibilityTreePath)} | ${markdownEvidenceLink(checkpoint.screenshotPath)} | ${markdownEvidenceLink(checkpoint.focusPath)} | ${markdownEvidenceLink(checkpoint.axePath)} |`
      ),
      ""
    );
  }
  lines.push(
    "",
    "## Evidence",
    "",
    `See [manifest.json](${encodeURI(report.files.manifest)}) for checksums, provenance, missing evidence, and privacy state.`,
    "",
    "> Evidence may contain sensitive page content. It has not been reviewed or authorized for sharing.",
    ""
  );
  return lines.join("\n");
}

/** How many elements of one finding a PR comment lists; the full report lists them all. */
const COMMENT_ELEMENTS_PER_FINDING = 5;

/**
 * The report as one pull-request comment: the verdict and status rows, then the blocking fixes,
 * then advisory results, then AI suggestions, labelled as AI. Each finding is collapsed and shows
 * the problem, the elements, the fix and its pattern. Text that can come from the tested page is
 * escaped, and element names and selectors are shown as code, so a page cannot inject markup,
 * mention people or link issues in the comment.
 */
export function renderPullRequestComment(report: ScenarioIntegratedReport): string {
  return [
    `## Accessibility: ${verdictHeadline(report)}`,
    "",
    ...commentBody(report, "###"),
    "<sub>The full report, with screenshots and evidence for every finding, is aee-report.html in the run's output. Evidence may contain sensitive page content.</sub>",
    ""
  ].join("\n");
}

/** Marks the comment AEE owns on a pull request, so a later run updates it instead of adding one. */
export const PR_COMMENT_MARKER = "<!-- aee-pr-comment -->";

/** GitHub refuses a comment over 65,536 characters; this leaves room for the frame around it. */
const COMMENT_LIMIT = 60_000;

/** Fail when any one fails; pass only when every one passes; otherwise unknown. */
export function overallVerdict(
  results: Array<{ verdict: ScenarioIntegratedReport["verdict"] }>
): ScenarioIntegratedReport["verdict"] {
  if (results.some(({ verdict }) => verdict === "fail")) return "fail";
  return results.length && results.every(({ verdict }) => verdict === "pass") ? "pass" : "unknown";
}

/**
 * Every assessment of one run, such as each test of a suite, as the one comment AEE keeps on a
 * pull request. One assessment reads exactly like its own PR comment; several are listed failing
 * first, each collapsed under its test or scenario and its verdict. Past GitHub's size limit, the
 * rest are named as left to the full reports.
 */
export function renderPullRequestSummary(
  reports: ScenarioIntegratedReport[],
  runUrl?: string
): string {
  const footer = runUrl
    ? `<sub>The full reports, with screenshots and evidence for every finding, are in [this run's aee-reports artifact](${encodeURI(runUrl)}). Evidence may contain sensitive page content.</sub>`
    : "<sub>The full reports, with screenshots and evidence for every finding, are aee-report.html in the run's output. Evidence may contain sensitive page content.</sub>";
  if (reports.length === 0) {
    return [
      PR_COMMENT_MARKER,
      "## Accessibility: not decided, no AEE report was written",
      "",
      "The run ended before AEE wrote a report; the job log says why.",
      ""
    ].join("\n");
  }
  if (reports.length === 1) {
    const [report] = reports as [ScenarioIntegratedReport];
    return [
      PR_COMMENT_MARKER,
      `## Accessibility: ${verdictHeadline(report)}`,
      "",
      ...commentBody(report, "###"),
      footer,
      ""
    ].join("\n");
  }
  return renderSuiteSummary(reports, footer);
}

/** How a status row's results are ordered in a suite: what needs work first. */
const STATUS_ORDER: Record<StatusArea["verdict"], number> = {
  fail: 0,
  unknown: 1,
  pass: 2,
  "not-run": 3
};

/** Test names listed per outcome before the rest are left to the full reports. */
const COMMENT_NAMES_PER_GROUP = 30;

/**
 * Several assessments, such as each test of a suite, as one summary: the status rows counted
 * across them, each distinct problem once with the tests that saw it, and the tests by outcome.
 * A shared component's problem is listed once however many tests render it, so the comment
 * grows with the number of problems, not the number of tests.
 */
function renderSuiteSummary(reports: ScenarioIntegratedReport[], footer: string): string {
  // A test suite writes one assessment per test; anything else is named for what it is.
  const noun = reports.every(({ profile }) => profile === "playwright-test")
    ? { one: "test", many: "tests" }
    : { one: "assessment", many: "assessments" };
  const plural = (count: number) => `${count} ${count === 1 ? noun.one : noun.many}`;
  const withVerdict = (verdict: ScenarioIntegratedReport["verdict"]) =>
    reports.filter((report) => report.verdict === verdict);
  const verdict = overallVerdict(reports);
  const headline =
    verdict === "fail"
      ? `release blocked by ${withVerdict("fail").length} of ${plural(reports.length)}`
      : verdict === "pass"
        ? `nothing blocks release in ${plural(reports.length)}`
        : `not decided for ${withVerdict("unknown").length} of ${plural(reports.length)}`;
  const head = [
    PR_COMMENT_MARKER,
    `## Accessibility: ${headline}`,
    "",
    `| Area | Result (${noun.many}) |`,
    "| --- | --- |",
    ...suiteStatusRows(reports),
    ""
  ];

  const problems = suiteFindings(reports);
  const incompleteRules = [
    ...new Set(reports.flatMap(({ synthesis }) => synthesis.uniqueIncompleteRules))
  ].sort();
  const undecided = suiteUndecidedContrast(reports);
  const passed = withVerdict("pass");
  const tail = [
    ...commentAiSuggestions(
      problems.map(({ finding }) => finding),
      "###"
    ),
    ...(incompleteRules.length
      ? [
          `${incompleteRules.length} axe ${incompleteRules.length === 1 ? "check" : "checks"} could not decide and ${incompleteRules.length === 1 ? "needs" : "need"} a person: ${incompleteRules.map(commentCode).join(", ")}.`,
          ""
        ]
      : []),
    ...(undecided.length
      ? [
          `**Contrast left for a person (${undecided.length}):**`,
          "",
          ...undecided
            .slice(0, COMMENT_ELEMENTS_PER_FINDING)
            .map(
              ({ selector, reason, tests }) =>
                `- ${commentCode(selector)}: ${commentText(reason)} (${plural(tests)})`
            ),
          ...(undecided.length > COMMENT_ELEMENTS_PER_FINDING
            ? [`- and ${undecided.length - COMMENT_ELEMENTS_PER_FINDING} more in the full reports`]
            : []),
          ""
        ]
      : []),
    `### ${noun.many[0]!.toUpperCase()}${noun.many.slice(1)} (${reports.length})`,
    "",
    ...(["fail", "unknown"] as const).flatMap((outcome) => {
      const group = withVerdict(outcome);
      return group.length
        ? [
            `**${outcome === "fail" ? "Release blocked" : "Not decided"} (${group.length}):** ${commentNames(group)}`,
            ""
          ]
        : [];
    }),
    ...(passed.length
      ? [
          "<details>",
          `<summary>Nothing blocks release (${passed.length})</summary>`,
          "",
          commentNames(passed),
          "",
          "</details>",
          ""
        ]
      : []),
    footer,
    ""
  ];

  // Problems are listed until GitHub's size limit, blocking ones first; the rest are counted.
  const lines = [...head];
  const size = (parts: string[]) => parts.join("\n").length;
  let shown = 0;
  for (const [index, { finding, tests }] of problems.entries()) {
    const heading =
      index === 0 || problems[index - 1]!.finding.advisory !== finding.advisory
        ? [
            finding.advisory
              ? `### Advisory: reported, never blocks release (${problems.filter(({ finding }) => finding.advisory).length})`
              : `### Blocking fixes (${problems.filter(({ finding }) => !finding.advisory).length})`,
            ""
          ]
        : [];
    const block = [
      ...heading,
      // Problems of one rule on different elements share a title; the first element tells them apart.
      ...commentFinding(finding, {
        names: tests,
        noun,
        element:
          problems.filter((other) => other.finding.title === finding.title).length > 1
            ? finding.instances[0]?.label
            : undefined
      })
    ];
    if (size([...lines, ...block, ...tail]) > COMMENT_LIMIT) break;
    lines.push(...block);
    shown += 1;
  }
  if (shown < problems.length) {
    lines.push(`${problems.length - shown} more problems are in the full reports.`, "");
  }
  return [...lines, ...tail].join("\n");
}

/** Names of tests or scenarios, up to a readable number; the rest are left to the full reports. */
function commentNames(group: Array<{ goal: string }>): string {
  const hidden = group.length - COMMENT_NAMES_PER_GROUP;
  return `${group
    .slice(0, COMMENT_NAMES_PER_GROUP)
    .map(({ goal }) => commentText(goal))
    .join("; ")}${hidden > 0 ? `; and ${hidden} more in the full reports` : ""}`;
}

/** Each status row across the assessments: every result it had, with how many had it. */
function suiteStatusRows(reports: ScenarioIntegratedReport[]): string[] {
  return reports[0]!.synthesis.status.map(({ id, label }) => {
    const results = new Map<string, { verdict: StatusArea["verdict"]; count: number }>();
    for (const report of reports) {
      const row = report.synthesis.status.find((area) => area.id === id);
      if (!row) continue;
      const entry = results.get(row.result) ?? { verdict: row.verdict, count: 0 };
      entry.count += 1;
      results.set(row.result, entry);
    }
    const cells = [...results]
      .sort(([, left], [, right]) => STATUS_ORDER[left.verdict] - STATUS_ORDER[right.verdict])
      .map(([result, { count }]) => (results.size === 1 ? result : `${result} (${count})`));
    return `| ${commentText(label)} | ${commentText(cells.join(" · "))} |`;
  });
}

/**
 * Each distinct problem across the assessments once, blocking first. An element failing a rule is
 * one problem however many assessments saw it; elements of one rule that the same assessments
 * saw are listed together, as the shared component they usually are. The first assessment to
 * report an element gives the problem's wording and fix.
 */
function suiteFindings(
  reports: ScenarioIntegratedReport[]
): Array<{ finding: FindingSynthesis; tests: string[] }> {
  type Seen = { finding: FindingSynthesis; instance?: FindingInstanceSynthesis; tests: string[] };
  const rules = new Map<string, Map<string, Seen>>();
  for (const report of reports) {
    for (const finding of report.synthesis.findings) {
      const rule = `${finding.advisory ? "advisory" : "blocking"}:${finding.ruleId}`;
      const elements = rules.get(rule) ?? new Map<string, Seen>();
      rules.set(rule, elements);
      for (const instance of finding.instances.length ? finding.instances : [undefined]) {
        const seen = elements.get(instance?.selector ?? "") ?? { finding, instance, tests: [] };
        if (!seen.tests.includes(report.goal)) seen.tests.push(report.goal);
        elements.set(instance?.selector ?? "", seen);
      }
    }
  }
  const problems = [...rules.values()].flatMap((elements) => {
    const groups = new Map<string, Seen[]>();
    for (const seen of elements.values()) {
      const key = seen.tests.join("\u0000");
      groups.set(key, [...(groups.get(key) ?? []), seen]);
    }
    return [...groups.values()].map((group) => {
      const { finding, tests } = group[0]!;
      const instances = group.flatMap(({ instance }) => (instance ? [instance] : []));
      const selectors = new Set(instances.map(({ selector }) => selector));
      const suggestions = group
        .flatMap(({ finding: source }) => source.remediation.ai.suggestions ?? [])
        .filter(
          (suggestion, index, all) =>
            selectors.has(suggestion.selector) &&
            all.findIndex(({ selector }) => selector === suggestion.selector) === index
        );
      return {
        finding: {
          ...finding,
          instances,
          instanceCount: instances.length,
          remediation: {
            ...finding.remediation,
            ai: finding.remediation.ai.suggestions
              ? { ...finding.remediation.ai, suggestions }
              : finding.remediation.ai
          }
        },
        tests
      };
    });
  });
  return problems.sort(
    (left, right) => Number(left.finding.advisory) - Number(right.finding.advisory)
  );
}

/** Each text left for a person across the assessments once, with how many saw it. */
function suiteUndecidedContrast(
  reports: ScenarioIntegratedReport[]
): Array<{ selector: string; reason: string; tests: number }> {
  const texts = new Map<string, { selector: string; reason: string; tests: number }>();
  for (const report of reports) {
    for (const { selector, reason } of report.synthesis.undecidedContrast) {
      const entry = texts.get(selector) ?? { selector, reason, tests: 0 };
      entry.tests += 1;
      texts.set(selector, entry);
    }
  }
  return [...texts.values()];
}

function verdictHeadline(report: ScenarioIntegratedReport): string {
  const blocking = report.synthesis.findings.filter(({ advisory }) => !advisory).length;
  return report.verdict === "fail"
    ? `release blocked${blocking ? `, ${blocking} ${blocking === 1 ? "fix" : "fixes"} needed` : ""}`
    : report.verdict === "pass"
      ? "nothing blocks release in the tested scope"
      : "not decided, some evidence is missing or needs a person";
}

/** Everything under a comment's headline; sections take the heading level given. */
function commentBody(report: ScenarioIntegratedReport, heading: string): string[] {
  const { findings, status, uniqueIncompleteRules, undecidedContrast } = report.synthesis;
  const blocking = findings.filter(({ advisory }) => !advisory);
  const advisory = findings.filter(({ advisory }) => advisory);
  const lines = [
    `Tested ${commentCode(report.target)} against ${commentText(report.standard)}. Evidence: ${report.completeness.status}.`,
    "",
    "| Area | Result |",
    "| --- | --- |",
    ...status.map(({ label, result }) => `| ${commentText(label)} | ${commentText(result)} |`),
    ""
  ];
  const section = (title: string, group: FindingSynthesis[]) =>
    group.length
      ? [
          `${heading} ${title} (${group.length})`,
          "",
          ...group.flatMap((finding) => commentFinding(finding))
        ]
      : [];
  lines.push(
    ...section("Blocking fixes", blocking),
    ...section("Advisory: reported, never blocks release", advisory),
    ...commentAiSuggestions(findings, heading)
  );
  if (uniqueIncompleteRules.length) {
    lines.push(
      `${uniqueIncompleteRules.length} axe ${uniqueIncompleteRules.length === 1 ? "check" : "checks"} could not decide and ${uniqueIncompleteRules.length === 1 ? "needs" : "need"} a person: ${uniqueIncompleteRules.map(commentCode).join(", ")}.`,
      ""
    );
  }
  if (undecidedContrast.length) {
    const hidden = undecidedContrast.length - COMMENT_ELEMENTS_PER_FINDING;
    lines.push(
      `**Contrast left for a person (${undecidedContrast.length}):**`,
      "",
      ...undecidedContrast
        .slice(0, COMMENT_ELEMENTS_PER_FINDING)
        .map(({ selector, reason }) => `- ${commentCode(selector)}: ${commentText(reason)}`),
      ...(hidden > 0 ? [`- and ${hidden} more in the full report`] : []),
      ""
    );
  }
  return lines;
}

/** One finding, collapsed; in a suite summary, with the tests that saw it. */
function commentFinding(
  finding: FindingSynthesis,
  seenIn?: { names: string[]; noun: { one: string; many: string }; element?: string }
): string[] {
  const facts = [
    finding.wcagCriteria.join(", "),
    seenIn?.element ? `on “${seenIn.element}”` : "",
    `${finding.instanceCount} ${finding.instanceCount === 1 ? "element" : "elements"}`,
    seenIn
      ? `seen in ${seenIn.names.length} ${seenIn.names.length === 1 ? seenIn.noun.one : seenIn.noun.many}`
      : ""
  ].filter(Boolean);
  const hidden = finding.instances.length - COMMENT_ELEMENTS_PER_FINDING;
  return [
    "<details>",
    `<summary><strong>${commentHtml(finding.title)}</strong> · ${commentHtml(facts.join(" · "))}</summary>`,
    "",
    `**Problem:** ${commentText(findingImpact(finding))}`,
    "",
    "**Elements:**",
    "",
    ...finding.instances
      .slice(0, COMMENT_ELEMENTS_PER_FINDING)
      .map(({ label, selector }) => `- ${commentCode(label)} at ${commentCode(selector)}`),
    ...(hidden > 0 ? [`- and ${hidden} more in the full report`] : []),
    "",
    `**Fix:** ${commentText(finding.remediation.deterministic)}`,
    "",
    `**Pattern:** ${finding.pattern ? `[${commentText(finding.pattern.id)}](${encodeURI(finding.pattern.url)}) (a11y-skills)` : "none mapped for this rule yet"}`,
    "",
    ...(seenIn
      ? [`**Seen in:** ${commentNames(seenIn.names.map((name) => ({ goal: name })))}`, ""]
      : []),
    "</details>",
    ""
  ];
}

/** AI answers come last, each labelled as AI; without a model, one line says how to turn it on. */
function commentAiSuggestions(findings: FindingSynthesis[], heading: string): string[] {
  const suggested = findings.flatMap((finding) =>
    (finding.remediation.ai.suggestions ?? []).map((suggestion) => ({ finding, suggestion }))
  );
  if (suggested.length === 0) {
    const off = findings.find(({ remediation }) => remediation.ai.status === "not-configured");
    return off ? [`**AI suggestions:** ${commentText(off.remediation.ai.reason)}`, ""] : [];
  }
  return [
    `${heading} AI suggestions (${suggested.length}): review before use`,
    "",
    "An AI suggestion never passes or fails anything: a finding stands until a rerun passes.",
    "",
    ...suggested.map(({ finding, suggestion }) => {
      const text = suggestion.text
        ? commentCode(suggestion.text)
        : "an empty alternative (decorative)";
      const role = suggestion.classification ? `, image role ${suggestion.classification}` : "";
      return `- **AI suggestion** for ${commentCode(suggestion.selector)} (${commentText(finding.title)}): ${text}${role}. Based on ${commentText(citedEvidence(suggestion.citedEvidenceIds))}; confidence ${suggestion.confidence.toFixed(2)}; suggested by ${commentCode(finding.remediation.ai.providerId ?? "a model")}.`;
    }),
    ""
  ];
}

/**
 * Text shown literally: in a code span GitHub renders no Markdown or HTML and makes no mentions
 * or issue links. The fence is longer than any run of backticks in the text.
 */
function commentCode(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return "(no text)";
  const fence = "`".repeat(
    Math.max(0, ...(text.match(/`+/g) ?? []).map(({ length }) => length)) + 1
  );
  const pad = text.startsWith("`") || text.endsWith("`") ? " " : "";
  return `${fence}${pad}${text}${pad}${fence}`;
}

/** Text inside HTML, such as a summary: entities for markup, and no mentions or issue links. */
function commentHtml(value: string): string {
  return escapeHtml(withoutReferences(value.replace(/\s+/g, " ").trim()));
}

/** Text inside Markdown: commentHtml's escaping, and Markdown punctuation shown as itself. */
function commentText(value: string): string {
  return commentHtml(value).replace(/[\\`*_[\]()!|~]/g, "\\$&");
}

/**
 * A zero-width space stops GitHub turning page text into a mention (@name, not inside a word, as
 * in an email address) or an issue link (#123, also owner/repo#123); a colour such as #3f4c48 is
 * left alone, since GitHub links only digits.
 */
function withoutReferences(value: string): string {
  return value.replace(/(?<!\w)@(?=[a-z\d])/gi, "@\u200b").replace(/#(?=\d+\b)/g, "#\u200b");
}

interface FindingEffort {
  size: "Small" | "Medium" | "Needs triage";
  hours: string;
  minimumHours: number;
  maximumHours: number;
  rationale: string;
}

function findingEffort(ruleId: string): FindingEffort {
  if (ruleId === "aria-required-parent") {
    return {
      size: "Small",
      hours: "1–2 hours",
      minimumHours: 1,
      maximumHours: 2,
      rationale:
        "Likely one shared component. Includes the semantic change and a keyboard/reader regression check."
    };
  }
  if (ruleId === "color-contrast") {
    return {
      size: "Medium",
      hours: "2–4 hours",
      minimumHours: 2,
      maximumHours: 4,
      rationale:
        "Choose an approved token, update both contexts and interactive states, then verify contrast and visual consistency."
    };
  }
  return {
    size: "Needs triage",
    hours: "Not estimated",
    minimumHours: 0,
    maximumHours: 0,
    rationale:
      "Inspect the affected component and ownership before estimating implementation effort."
  };
}

function totalEffortSummary(findings: FindingSynthesis[]): string {
  const estimates = findings.map(({ ruleId }) => findingEffort(ruleId));
  if (estimates.some(({ size }) => size === "Needs triage")) {
    return "At least one finding needs engineering triage before the total can be estimated.";
  }
  const minimum = estimates.reduce((sum, estimate) => sum + estimate.minimumHours, 0);
  const maximum = estimates.reduce((sum, estimate) => sum + estimate.maximumHours, 0);
  return `${minimum}–${maximum} engineering hours for the identified fixes and focused regression checks.`;
}

function executiveStatusSummary(report: ScenarioIntegratedReport): string {
  const blocking = report.summary.findings;
  const issues = blocking
    ? `${blocking} grouped fix${blocking === 1 ? "" : "es"} cover ${report.synthesis.affectedInstancesAtLargestCheckpoint} affected instances at the largest checkpoint and still block release in this scope.`
    : "No confirmed fix was found in this scope.";
  const clear = report.synthesis.status
    .filter(({ verdict }) => verdict === "pass")
    .map(({ label }) => label.toLowerCase());
  return clear.length ? `${issues} No confirmed issue in: ${clear.join(", ")}.` : issues;
}

function jsonForInlineScript(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function renderIntegratedHtml(
  report: ScenarioIntegratedReport,
  views: IntegratedHtmlViews
): string {
  const screenshots = report.artifacts.filter(
    (artifact) => artifact.kind === "full-page-screenshot" && artifact.phase === "after"
  );
  const videos = report.artifacts.filter((artifact) => artifact.kind === "interaction-video");
  const captions = report.artifacts.filter((artifact) => artifact.kind === "video-captions");
  const captionFor = (videoPath: string) => {
    const parent = path.posix.dirname(videoPath);
    return captions.find((artifact) => path.posix.dirname(String(artifact.path)) === parent);
  };
  const availableArtifacts = Math.max(
    0,
    report.summary.artifacts -
      report.completeness.missingArtifacts -
      report.completeness.failedArtifacts
  );
  const tabLinks = [
    ["overview", "Status & plan"],
    ["page", "Page view"],
    [
      "findings",
      `Fix review (${report.summary.findings}${report.summary.advisories ? ` + ${report.summary.advisories} advisory` : ""})`
    ],
    ["journeys", "Tested journeys"],
    ["media", `Visuals & video (${videos.length + screenshots.length})`],
    ["annex", "Technical annex"]
  ] as const;
  const statusSummary = executiveStatusSummary(report);
  const readerStatus = report.synthesis.status.find(({ id }) => id === "reader");
  const effortSummary = totalEffortSummary(report.synthesis.findings);
  const assistantKnowledge = jsonForInlineScript({
    verdict: report.verdict,
    target: report.target,
    scope: `${report.summary.actions} authored actions across ${report.completeness.completedLanes} completed lanes`,
    conclusion: report.synthesis.conclusion,
    directJudgments: report.synthesis.directJudgments,
    releaseGates: report.synthesis.releaseGates,
    reader: report.synthesis.reader,
    status: report.synthesis.status,
    blocking: report.summary.findings,
    advisories: report.summary.advisories,
    findings: report.synthesis.findings.map((finding) => ({
      ruleId: finding.ruleId,
      title: finding.title,
      fixLabel: findingFixLabel(finding),
      advisory: finding.advisory,
      severity: finding.severity,
      effort: findingEffort(finding.ruleId),
      fix: finding.remediation.deterministic,
      checkpoints: finding.checkpointCount,
      instances: finding.instanceCount,
      components: finding.componentCount,
      wcag: finding.wcagCriteria,
      pattern: finding.pattern
    })),
    affectedInstancesAtLargestCheckpoint: report.synthesis.affectedInstancesAtLargestCheckpoint,
    incompleteRules: report.synthesis.uniqueIncompleteRules,
    effortSummary
  });
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accessibility evidence report: ${escapeHtml(reportName(report))}</title>
<style>
@font-face{font-family:"AEE Display";src:url("aee-report-display.woff2") format("woff2");font-style:normal;font-weight:100 900;font-display:swap}
:root{color-scheme:light;--ink:#17221e;--muted:#5b6963;--paper:#fbfaf6;--surface:#fff;--wash:#edf2ee;--line:#c8d1cc;--line-strong:#87978f;--forest:#123d31;--forest-deep:#092a22;--mint:#a8e6ce;--pass:#087443;--fail:#a51d32;--fail-wash:#fff1f3;--unknown:#745900;--unknown-wash:#fff8df;--ai:#3a3f9e;--ai-wash:#f0f1ff;--focus:#b86e00;--marker:#f6b73c;--serif:"AEE Display",Georgia,serif;--sans:"Avenir Next",Avenir,"Segoe UI",system-ui,sans-serif;--mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
*{box-sizing:border-box}
html{scroll-behavior:smooth;scrollbar-color:var(--line-strong) var(--wash)}
body{margin:0;font:16px/1.6 var(--sans);color:var(--ink);background:var(--paper);font-variant-numeric:tabular-nums}
::selection{color:#fff;background:var(--forest)}
a{color:#086246;text-decoration-thickness:1px;text-underline-offset:.22em}
a:hover{text-decoration-thickness:2px}
a:focus-visible,button:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:3px;border-radius:2px}
.skip-link{position:absolute;left:1rem;top:-5rem;background:#fff;color:#000;padding:.75rem 1rem;z-index:10}
.skip-link:focus{top:1rem}
.report-header{color:var(--forest-deep);background:#e1eee8;border-bottom:1px solid var(--line-strong)}
.header-inner{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(18rem,.8fr);gap:clamp(2rem,7vw,7rem);max-width:1220px;margin:auto;padding:clamp(2.5rem,6vw,5.5rem) 1.5rem clamp(2rem,5vw,4rem)}
.report-header h1{max-width:12ch;margin:0;font:700 clamp(3rem,7vw,6rem)/.94 var(--serif);letter-spacing:-.035em;text-wrap:balance}
.report-header h1::first-letter{text-transform:uppercase}
.lede{max-width:58ch;margin:1.5rem 0 0;font-size:clamp(1.05rem,2vw,1.25rem);color:#29493f}
.header-meta{align-self:end;border-top:1px solid var(--line-strong);padding-top:1rem}
.header-meta dt{font-size:.75rem;letter-spacing:.08em;text-transform:uppercase;color:#496159}
.header-meta dd{margin:0 0 1rem;font-weight:650}
.header-links{display:flex;flex-wrap:wrap;gap:.6rem 1.5rem;max-width:1220px;margin:auto;padding:0 1.5rem 1.5rem;border-top:1px solid rgb(18 61 49/.15)}
.header-links a{padding-top:1rem;color:var(--forest-deep);font-weight:700}
.page-shell{max-width:1220px;margin:auto;padding:clamp(1.5rem,4vw,3.5rem) 1.5rem 5rem}
.scoreboard{display:grid;grid-template-columns:minmax(16rem,.8fr) minmax(0,1.8fr);background:var(--forest-deep);color:#fff;border-radius:16px;overflow:hidden}
.score-primary{padding:clamp(1.5rem,4vw,3rem);background:var(--forest)}
.score-primary p{margin:.25rem 0;color:#d7e9e2}
.score-primary .score-label{margin:0;font:750 1rem/1.4 var(--sans);color:var(--mint)}
.score-primary strong{display:block;margin:.2rem 0;font:750 clamp(3.25rem,7vw,5.5rem)/1 var(--serif);letter-spacing:-.035em}
.score-primary.fail strong{color:#ffafbb}.score-primary.pass strong{color:#91e4c1}.score-primary.unknown strong{color:#f3d47c}
.score-facts{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));margin:0;padding:clamp(1.5rem,4vw,3rem)}
.score-facts div{padding:0 clamp(1rem,3vw,2rem);border-left:1px solid rgb(255 255 255/.2)}
.score-facts div:first-child{border-left:0}
.score-facts dt{color:#b7cbc4;font-size:.78rem;letter-spacing:.07em;text-transform:uppercase}
.score-facts dd{margin:.25rem 0 0;font:700 clamp(1.65rem,3vw,2.65rem)/1 var(--serif);white-space:nowrap}
.score-facts small{display:block;margin-top:.6rem;color:#d7e2de;font:400 .86rem/1.35 var(--sans);white-space:normal}
.score-note{max-width:72ch;margin:1rem 0 2.5rem;color:var(--muted)}
.decision-room{display:grid;grid-template-columns:minmax(0,1.25fr) minmax(20rem,.75fr);gap:1.5rem;margin-bottom:2rem}
.status-brief{padding:clamp(1.5rem,4vw,3.25rem);color:#fff;background:var(--forest-deep);border-radius:16px}
.status-brief h2{max-width:14ch;margin:.55rem 0 1rem;font:700 clamp(2.25rem,5vw,4.6rem)/.96 var(--serif);letter-spacing:-.035em;text-wrap:balance}
.status-brief>p{max-width:62ch;color:#d7e9e2;font-size:1.08rem}
.status-flag{display:inline-flex;align-items:center;gap:.55rem;padding:.35rem .7rem;border:1px solid #ffafbb;border-radius:999px;color:#ffd5db;font-weight:800;font-size:.78rem;letter-spacing:.04em;text-transform:uppercase}
.status-flag::before{content:"";width:.55rem;height:.55rem;border-radius:50%;background:#ff8094}
.status-meta{display:flex;flex-wrap:wrap;gap:.75rem 2rem;margin:2rem 0 0;padding-top:1.25rem;border-top:1px solid rgb(255 255 255/.24)}
.status-meta strong{display:block;font:700 1.45rem/1.15 var(--serif)}.status-meta span{color:#b7cbc4;font-size:.82rem}
.report-assistant{display:flex;flex-direction:column;padding:1.5rem;background:#fff;border:1px solid var(--line-strong);border-radius:16px}
.report-assistant h2{margin:0;font:700 1.7rem/1.1 var(--serif)}.report-assistant>p{margin:.55rem 0 1rem;color:var(--muted)}
.question-chips{display:flex;flex-wrap:wrap;gap:.5rem;margin-bottom:1rem}.question-chips button,.fix-filters button,.ask-about{border:1px solid var(--line-strong);border-radius:999px;padding:.5rem .75rem;color:var(--forest-deep);background:var(--paper);font:700 .84rem/1.2 var(--sans);cursor:pointer}.question-chips button:hover,.fix-filters button:hover,.ask-about:hover,.filter-active{color:#fff!important;background:var(--forest)!important}
.ask-form{display:flex;gap:.5rem;margin-top:auto}.ask-form label{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}.ask-form input{min-width:0;flex:1;border:1px solid var(--line-strong);border-radius:8px;padding:.75rem;font:inherit;color:var(--ink);background:#fff}.ask-form button{border:0;border-radius:8px;padding:.75rem 1rem;color:#fff;background:var(--forest);font:800 .9rem/1 var(--sans);cursor:pointer}.ask-form button:hover{background:var(--forest-deep)}
.assistant-answer{min-height:6rem;margin:1rem 0 0;padding:1rem;background:var(--wash);border-radius:8px;color:#29493f}.assistant-answer p{margin:0}.assistant-answer strong{color:var(--forest-deep)}
.health-map{border-top:1px solid var(--line-strong);margin:1.5rem 0 2rem}.health-row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:1rem;align-items:center;padding:1rem 0;border-bottom:1px solid var(--line)}.health-signal{width:.75rem;height:.75rem;border-radius:50%}.health-signal.pass{background:var(--pass)}.health-signal.fail{background:var(--fail)}.health-signal.unknown{background:var(--unknown)}.health-signal.not-run{background:var(--line-strong)}.health-row strong,.health-row span{display:block}.health-row span{color:var(--muted);font-size:.9rem}.health-result{font-size:.9rem}.health-result.pass{color:var(--pass)}.health-result.fail{color:var(--fail)}.health-result.unknown{color:var(--unknown)}.health-result.not-run{color:var(--muted)}.health-detail{padding:0 0 1rem 1.75rem;border-bottom:1px solid var(--line)}.health-detail summary{cursor:pointer;padding:.5rem 0}.health-detail li{overflow-wrap:anywhere}
.journey-proof{display:grid;grid-template-columns:minmax(15rem,.72fr) minmax(0,1.28fr);gap:clamp(1.25rem,4vw,3rem);align-items:center;margin:0 0 1.5rem;padding:clamp(1.25rem,3vw,2rem);color:#fff;background:var(--forest-deep);border-radius:12px}.journey-proof h3{margin:0 0 .55rem;font:700 clamp(1.45rem,3vw,2rem)/1.1 var(--serif)}.journey-proof p{margin:.45rem 0;color:#d7e9e2}.journey-proof ol{margin:.8rem 0;padding-left:1.25rem}.journey-proof li{margin:.25rem 0}.journey-proof a{color:var(--mint);font-weight:750}.journey-proof video{width:100%;border-color:var(--line-strong);background:#000}.journey-proof-links{display:flex;flex-wrap:wrap;gap:.4rem 1rem;margin-top:1rem!important;font-size:.88rem}
.priority-snapshot{padding:0;list-style:none;border-top:1px solid var(--line-strong)}.priority-snapshot li{display:grid;grid-template-columns:2rem minmax(0,1fr) max-content;gap:1rem;align-items:start;padding:1rem 0;border-bottom:1px solid var(--line)}.priority-snapshot li>span{display:grid;width:1.8rem;height:1.8rem;place-items:center;border-radius:50%;color:#fff;background:var(--forest);font-weight:800}.priority-snapshot p{margin:.2rem 0 0;color:var(--muted);font-size:.9rem}.priority-snapshot b{color:var(--forest)}
.section-intro{display:flex;align-items:end;justify-content:space-between;gap:2rem;margin-bottom:1rem}.section-intro h2{margin:0;font:700 clamp(2rem,4vw,3.5rem)/1.05 var(--serif);letter-spacing:-.025em}.section-intro p{max-width:58ch;margin:0;color:var(--muted)}
.planner-tools{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 0;border-top:1px solid var(--line-strong);border-bottom:1px solid var(--line-strong)}.planner-tools p{margin:0}.fix-filters{display:flex;flex-wrap:wrap;gap:.5rem}
.fix-list{margin-top:1rem}.fix-row{display:grid;grid-template-columns:minmax(5.5rem,max-content) minmax(0,1fr) 13rem;gap:1.5rem;padding:2rem 0;border-bottom:1px solid var(--line-strong)}.fix-order{display:flex;flex-direction:column;align-items:center;gap:.5rem}.fix-order span{color:var(--fail);font-weight:850}
.fix-order span.advisory{color:var(--unknown)}.fix-order strong{font:700 2.6rem/1 var(--serif)}.fix-main{min-width:0}.fix-main>header{display:flex;justify-content:space-between;gap:1rem}.fix-main h3{max-width:30ch;margin:0;font:700 clamp(1.4rem,3vw,2rem)/1.1 var(--serif)}.effort{padding-left:1.5rem;border-left:1px solid var(--line)}.effort>strong{display:block;font:700 1.5rem/1.2 var(--serif)}.effort>span{color:var(--forest);font-weight:800}.effort p{color:var(--muted);font-size:.9rem}
.fix-scope{display:flex;flex-wrap:wrap;gap:.25rem .65rem;margin:1rem 0;padding:.8rem 1rem;background:var(--wash);border-top:1px solid var(--line-strong);border-bottom:1px solid var(--line-strong)}.fix-scope strong{color:var(--forest)}.fix-scope span{color:var(--muted)}
.before-after{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1.25rem 0}.before-after figure{min-width:0;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:#fff}.issue-crop{position:relative;display:block;height:15rem;overflow:hidden;background:#121212}.before-after img{width:100%;height:100%;object-fit:cover;object-position:top;border:0;border-radius:0}.current-state[data-rule-id="color-contrast"] .issue-crop img{transform:scale(1.85);transform-origin:50% 3%}.issue-crop b{position:absolute;left:.6rem;bottom:.6rem;padding:.32rem .5rem;border-radius:4px;color:#fff;background:rgb(9 42 34/.94);font-size:.72rem;letter-spacing:.02em}.target-crop-grid{display:grid;gap:.65rem;padding:.65rem;background:var(--wash)}.target-crop{position:relative;display:block;height:8.4rem;overflow:hidden;border:1px solid var(--line-strong);border-radius:8px;background:var(--forest-deep);color:#fff}.target-crop img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;object-position:var(--target-x) var(--target-y);filter:brightness(.78)}.target-crop i{position:absolute;left:var(--target-left);top:var(--target-y);width:var(--target-width);min-width:3rem;height:2rem;transform:translateY(-50%);border:3px solid var(--marker);border-radius:4px;background:rgb(246 183 60/.12)}.target-crop b,.target-crop span{position:absolute;left:.6rem;z-index:1;padding:.2rem .4rem;border-radius:4px;background:rgb(9 42 34/.94)}.target-crop b{top:.55rem}.target-crop span{bottom:.55rem;font-size:.72rem}.before-after figcaption{display:flex;flex-direction:column;gap:.35rem;margin:0;padding:.8rem 1rem;border-top:1px solid var(--line)}.before-after figcaption span{color:var(--muted);font-size:.85rem}.visual-targets{display:grid;gap:.35rem;margin:.25rem 0;padding:0;list-style:none}.visual-targets li{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.2rem .75rem;padding:.4rem 0;border-top:1px solid var(--line)}.visual-targets b{font-size:.82rem}.visual-targets span{font-size:.78rem}.semantic-evidence{display:flex;min-height:15rem;flex-direction:column;justify-content:center;gap:.7rem;padding:1.25rem;background:var(--wash)}.semantic-evidence>strong{font:700 1.35rem/1.15 var(--serif)}.semantic-evidence p{margin:0;color:var(--muted)}.semantic-evidence code{display:block;margin-top:.35rem;padding:.65rem;background:#fff;border:1px solid var(--line);font-size:.74rem}.instance-chips{display:flex;flex-wrap:wrap;gap:.4rem}.instance-chips span{padding:.28rem .55rem;border:1px solid var(--line-strong);border-radius:999px;background:#fff;font-size:.72rem;font-weight:750}.preview-stage{display:flex;align-items:center;justify-content:center;gap:1rem;min-height:15rem;padding:1.25rem;background:var(--wash)}.semantic-preview .preview-stage>div:not(.change-arrow){display:flex;flex-direction:column;gap:.6rem}.semantic-preview .preview-stage span{font-size:.76rem;font-weight:800;letter-spacing:.04em;text-transform:uppercase;color:var(--muted)}.semantic-preview code{display:block;padding:.8rem;background:#fff;border:1px solid var(--line)}.change-arrow{color:var(--forest);font:700 2rem/1 var(--serif)}.contrast-pair{display:flex;flex:1;min-width:0;flex-direction:column;gap:.45rem;color:var(--ink)}.contrast-pair>strong{font-size:.9rem}.contrast-pair small{color:var(--muted);line-height:1.45}.color-field{display:flex;min-height:6rem;align-items:center;justify-content:center;border:1px solid var(--line-strong);border-radius:8px}.color-field i{display:block;width:56%;height:1.15rem;border-radius:999px}.instance-list{width:100%;min-width:0;max-width:100%;overflow:hidden;margin:1.2rem 0;padding:1rem;background:#fff;border:1px solid var(--line-strong);border-radius:8px}.instance-list summary{color:var(--forest);font-weight:800}.instance-list>p{max-width:75ch;color:var(--muted)}.instance-list .table-wrap{width:100%;min-width:0;max-width:100%;overflow-x:auto}.instance-list table{font-size:.84rem}.instance-list th:first-child,.instance-list td:first-child{width:3rem;text-align:right}.instance-list td:nth-child(2){min-width:12rem}.instance-list td:nth-child(3){min-width:12rem}.instance-list td:last-child{min-width:24rem}.instance-list td small{display:block;margin-top:.45rem;color:var(--muted);line-height:1.4}.fix-actions{display:flex;flex-wrap:wrap;align-items:center;gap:.6rem 1rem}.fix-actions a{font-weight:750}.estimate-note{max-width:75ch;color:var(--muted);font-size:.88rem}
.annex-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:2rem}.annex-block{padding-top:2rem;border-top:1px solid var(--line-strong)}.annex-block>h3{font:700 1.7rem/1.2 var(--serif)}
.conclusion{max-width:72ch;margin:1rem 0 2.5rem;font:600 clamp(1.2rem,2.2vw,1.55rem)/1.5 var(--serif);color:#29493f}
.report-tabs{display:flex;gap:1.5rem;overflow-x:auto;border-bottom:1px solid var(--line-strong);scrollbar-width:thin}
.report-tabs a{flex:0 0 auto;padding:.9rem .1rem .75rem;border-bottom:3px solid transparent;color:var(--muted);font-weight:700;text-decoration:none}
.report-tabs a:hover{color:var(--forest-deep);border-color:var(--line)}
.report-tabs a[aria-selected="true"]{color:var(--forest-deep);border-color:var(--forest)}
.tab-panel{scroll-margin-top:1rem;padding-top:clamp(1.5rem,4vw,3rem)}
.tab-panel>h2{max-width:22ch;margin:0 0 .5rem;font:700 clamp(2rem,4vw,3.5rem)/1.05 var(--serif);letter-spacing:-.025em;text-wrap:balance}
.tab-panel>h2+p{max-width:72ch;color:var(--muted)}
.tabs-ready .tab-panel[hidden]{display:none}
.panel{padding:clamp(1.25rem,3vw,2rem) 0;margin:1.5rem 0;border-top:1px solid var(--line-strong)}
.panel>h3:first-child{margin-top:0}
.result-card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:clamp(1.15rem,3vw,1.75rem);margin:1rem 0}
.result-card>h3:first-child{margin-top:0}
.coverage-table td:first-child{font-weight:750}.coverage-table td:last-child{min-width:24rem}
.finding-index{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,22rem),1fr));gap:1rem;padding:0;list-style:none}
.finding-index li{padding:1rem 0;border-top:1px solid var(--line)}
.finding-index a{font:700 1.15rem/1.3 var(--serif)}
.finding-dossier{margin:2rem 0 4rem;padding-top:2rem;border-top:2px solid var(--forest)}
.finding-dossier>header{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:1rem;align-items:start}
.finding-dossier h3{max-width:24ch;margin:0;font:700 clamp(1.6rem,3.5vw,2.5rem)/1.1 var(--serif);letter-spacing:-.02em}
.finding-summary{max-width:72ch;font-size:1.08rem;color:#34463f}
.evidence-preview{display:grid;grid-template-columns:minmax(15rem,.8fr) minmax(0,1.2fr);gap:clamp(1.25rem,4vw,3rem);align-items:start;margin:1.5rem 0 2rem}
.evidence-preview img{width:100%;max-height:30rem;object-fit:cover;object-position:top}
.finding-dossier[data-rule-id="aria-required-parent"] .evidence-preview img{object-position:bottom}
.evidence-preview h4,.remediation-grid h4{margin-top:0}
.evidence-links{display:flex;flex-wrap:wrap;gap:.45rem 1rem;padding:0;list-style:none}
.evidence-links a{font-weight:700}
.remediation-grid{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(16rem,.8fr);gap:2rem;margin:2rem 0;padding:1.5rem;background:var(--wash);border-radius:12px}
.remediation-grid section+section{border-left:1px solid var(--line-strong);padding-left:2rem}
.verification-list li{margin:.45rem 0}
.reader-announcement{font:600 1.05rem/1.45 var(--serif)}
.bounds{color:var(--muted);font-size:.9rem}
.outcome-pair{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin:1.25rem 0}
.outcome{padding-top:1rem;border-top:1px solid var(--line-strong)}
.outcome h4{display:flex;justify-content:space-between;gap:1rem;margin:0}
.lane-visuals{display:grid;grid-template-columns:1fr 1fr;gap:1rem;margin:1rem 0}
.lane-visuals figure{min-width:0}
.lane-visuals img{width:100%;aspect-ratio:16/10;object-fit:cover;object-position:top}
.technical-sample{font-size:.8rem;max-height:12rem}
.notice-grid{display:grid;grid-template-columns:1fr 1fr;gap:2rem;margin-top:2rem}
.notice,.ai{border-top-color:var(--unknown)}
.ai{border-top-color:#5367d8}
.badge{display:inline-block;align-self:start;border:1px solid currentColor;border-radius:999px;padding:.12rem .55rem;font-size:.75rem;line-height:1.4;font-weight:800;letter-spacing:.035em;text-transform:uppercase;white-space:nowrap}
.badge.suggested{color:var(--ai);background:var(--ai-wash)}.ai-suggestion{margin:1rem 0;padding:1rem 1.1rem;border:1px solid var(--ai);border-radius:.5rem;background:var(--ai-wash)}.ai-suggestion h4{display:flex;gap:.6rem;align-items:center;margin:0 0 .5rem}.ai-suggestion ul{margin:0;padding-left:1.1rem}.ai-suggestion li+li{margin-top:.6rem}.ai-suggestion li p{margin:.15rem 0}.ai-meta,.ai-note{color:var(--muted);font-size:.9rem}.badge.fail{color:var(--fail);background:var(--fail-wash)}.badge.pass{color:var(--pass);background:#eaf8f1}.badge.unknown{color:var(--unknown);background:var(--unknown-wash)}
.card-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem}
.card-heading h3{margin:.1rem 0;font:700 clamp(1.3rem,3vw,1.75rem)/1.15 var(--serif)}
.technical-id{color:var(--muted);font:400 .78rem/1.4 var(--mono)}
.metrics{display:flex;flex-wrap:wrap;gap:.4rem 1.5rem;color:var(--muted)}
dl.meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.5rem 1.5rem;max-width:58rem}
dt{font-weight:750}dd{margin:0;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}.table-wrap:focus-visible{outline:3px solid var(--focus);outline-offset:2px}
table{border-collapse:collapse;width:100%;min-width:640px}
caption{text-align:left;font-weight:700;padding:.75rem 1rem;background:var(--wash)}
th,td{padding:.8rem 1rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
tbody tr:last-child td{border-bottom:0}th{background:#f3f6f4;color:#34463f;font-size:.82rem;letter-spacing:.025em}
code,pre{white-space:pre-wrap;overflow-wrap:anywhere;background:var(--wash);border-radius:4px;padding:.2rem .35rem;font-family:var(--mono)}
pre{padding:1.25rem;max-height:34rem;overflow:auto;border:1px solid var(--line);line-height:1.65}
details{margin:.8rem 0;border-top:1px solid var(--line);padding-top:.75rem}
summary{cursor:pointer;font-weight:700}
.finding-list,.file-list{padding-left:1.35rem}.finding-list li,.file-list li{margin:.7rem 0}.finding-list li::marker{color:var(--fail);font-weight:800}
.rule{padding:1rem 0;margin:1rem 0;border-top:1px solid var(--line)}
.rule:first-of-type{border-top-color:var(--line-strong)}
.media-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,340px),1fr));gap:1.5rem}
img,video{display:block;max-width:100%;height:auto;border:1px solid var(--line-strong);border-radius:8px;background:#000}
figure{margin:0}figcaption{margin:.6rem 0;color:var(--muted);overflow-wrap:anywhere}.raw-link{font-size:.92rem;font-weight:700}.empty{color:var(--muted);font-style:italic}
.image-viewer-trigger{display:block;cursor:zoom-in}.image-viewer-trigger:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.image-dialog{width:min(94vw,76rem);max-width:none;max-height:92vh;margin:auto;padding:0;border:1px solid var(--line-strong);border-radius:12px;color:var(--ink);background:var(--paper)}.image-dialog::backdrop{background:rgb(9 42 34/.82)}.image-dialog-header{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:1rem 1.25rem;border-bottom:1px solid var(--line);background:#fff}.image-dialog-header h2{margin:0;font:700 clamp(1.25rem,3vw,1.75rem)/1.1 var(--serif)}.image-dialog-close{border:1px solid var(--line-strong);border-radius:8px;padding:.55rem .8rem;color:var(--forest-deep);background:var(--paper);font:750 .9rem/1 var(--sans);cursor:pointer}.image-dialog-close:hover{color:#fff;background:var(--forest)}.image-dialog-visual{display:grid;min-height:18rem;max-height:72vh;place-items:center;overflow:auto;padding:1rem;background:var(--wash)}.image-dialog-visual>img{max-width:none;width:auto;max-height:68vh;object-fit:contain}.image-dialog-visual .target-crop,.image-dialog-visual .issue-crop{width:min(100%,70rem);height:auto;aspect-ratio:var(--viewer-aspect);pointer-events:none;cursor:default}.image-dialog-footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:.5rem 1rem;margin:0;padding:.85rem 1.25rem;border-top:1px solid var(--line);background:#fff}.image-dialog-footer span{color:var(--muted)}.image-dialog-footer a{font-weight:750}
.layer-toggles{display:flex;flex-wrap:wrap;gap:.5rem 1.5rem;align-items:center;margin:0 0 1.5rem;padding:.6rem 1rem;border:1px solid var(--line);border-radius:10px}.layer-toggles legend{padding:0 .3rem;font-weight:750}.layer-toggles label{display:inline-flex;gap:.45rem;align-items:center;cursor:pointer}.layer-toggles input{width:1.15rem;height:1.15rem;margin:0;accent-color:var(--forest)}.layer-toggles input:focus-visible{outline:3px solid var(--focus);outline-offset:3px}
.page-state{margin:0 0 3rem}.page-state>h3{margin:0;font:700 1.35rem/1.2 var(--serif)}.page-state>.technical-id{margin:.2rem 0 1rem}
.page-view{display:grid;grid-template-columns:minmax(0,1fr) minmax(16rem,22rem);gap:1.5rem;align-items:start}
.page-canvas{position:sticky;top:1rem;max-height:85vh;overflow:auto;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface)}.page-canvas:focus-visible{outline:3px solid var(--focus);outline-offset:2px}.page-canvas svg{display:block;width:100%;height:auto}
.page-marker .halo{fill:none;stroke:#fff;stroke-width:6;vector-effect:non-scaling-stroke}.page-marker .outline{fill:none;stroke-width:3;vector-effect:non-scaling-stroke}.page-marker.fail .outline{stroke:var(--fail)}.page-marker.advisory .outline{stroke:var(--unknown)}.page-marker.neutral .outline{stroke:var(--ink);stroke-dasharray:8 5}.page-marker .badge{stroke:#fff;stroke-width:2}.page-marker.fail .badge{fill:var(--fail)}.page-marker.advisory .badge{fill:var(--unknown)}.page-marker.neutral .badge{fill:var(--ink)}.page-marker text{fill:#fff;font:700 17px/1 var(--sans);text-anchor:middle}.page-marker.current .halo{stroke:var(--marker);stroke-width:12}
.page-lists h4{margin:0 0 .5rem;font:700 1.1rem/1.2 var(--serif)}.page-lists h5{margin:1rem 0 .4rem;font:700 1rem/1.2 var(--serif)}.page-lists section+section{margin-top:1.75rem}.marker-list{margin:0;padding:0;list-style:none}.marker-item{display:flex;gap:.7rem;width:100%;padding:.55rem .6rem;border:0;border-bottom:1px solid var(--line);color:inherit;background:none;font:inherit;text-align:left;cursor:pointer}.marker-item:hover{background:var(--wash)}.marker-item[aria-current=true]{background:var(--unknown-wash);box-shadow:inset 4px 0 0 var(--marker)}.marker-item small,.marker-unplaced small{display:block;color:var(--muted)}.marker-unplaced{padding:.55rem .6rem;border-bottom:1px solid var(--line)}.marker-number{display:grid;flex:none;place-items:center;min-width:1.75rem;height:1.75rem;border-radius:50%;color:#fff;font-size:.85rem;font-weight:750}.marker-number.fail{background:var(--fail)}.marker-number.advisory{background:var(--unknown)}.marker-number.neutral{border-radius:4px;background:var(--ink)}.marker-flag{padding:0 .3rem;border-radius:4px;color:var(--fail);background:var(--fail-wash);font-size:.8rem;font-weight:750}.marker-nav{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin:0 0 .5rem}.marker-nav button{padding:.35rem .8rem;border:1px solid var(--line-strong);border-radius:6px;color:var(--forest-deep);background:var(--surface);font:650 .9rem/1.2 var(--sans);cursor:pointer}.marker-nav button:hover{color:#fff;background:var(--forest)}.marker-scope{color:var(--muted);font-size:.9rem}
${PAGE_LAYERS.map(({ id }) => `#panel-page:has([data-layer-toggle=${id}]:not(:checked)) [data-layer=${id}]`).join(",")}{display:none}
.marker-list li[style]{padding-left:calc(var(--depth)*1.1rem)}.marker-unplaced{display:flex;gap:.7rem}.focus-crop{display:block;max-width:100%;height:auto;margin-top:.4rem;border:1px solid var(--line);border-radius:4px}
@media(max-width:900px){.page-view{grid-template-columns:1fr}.page-canvas{top:0;max-height:45vh;z-index:1}.page-canvas svg{width:min(var(--page-width),180vw)}.page-lists :is(button,h4){scroll-margin-top:calc(45vh + 1rem)}}
.visually-hidden{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}.copy-status{color:var(--pass);font-weight:650}.ticket-text{margin-top:.75rem}.ticket-text summary{cursor:pointer;font-weight:650;color:var(--forest)}.ticket-text textarea{display:block;width:100%;margin-top:.5rem;padding:.75rem;border:1px solid var(--line-strong);border-radius:8px;background:var(--surface);color:var(--ink);font:.85rem/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;resize:vertical}.ticket-text textarea:focus-visible{outline:3px solid var(--focus);outline-offset:2px}.csv-download{font-weight:750}
@media(max-width:1000px){.decision-room{grid-template-columns:1fr}.fix-row{grid-template-columns:minmax(5.5rem,max-content) minmax(0,1fr)}.effort{grid-column:2;padding:1rem 0 0;border-left:0;border-top:1px solid var(--line)}}
@media(max-width:900px){.header-inner,.scoreboard{grid-template-columns:1fr}.header-meta{align-self:auto}.score-facts{grid-template-columns:repeat(2,minmax(0,1fr));padding:1.5rem}.score-facts div{padding:1rem;border-left:0;border-top:1px solid rgb(255 255 255/.2)}.score-facts div:nth-child(odd){border-right:1px solid rgb(255 255 255/.2)}.evidence-preview{grid-template-columns:1fr}.coverage-table td:last-child{min-width:18rem}.before-after{grid-template-columns:1fr}.planner-tools,.section-intro{align-items:flex-start;flex-direction:column}}
@media(max-width:680px){.notice-grid,.remediation-grid,.outcome-pair,.lane-visuals,.journey-proof{grid-template-columns:1fr;gap:1rem}.remediation-grid section+section{border-left:0;border-top:1px solid var(--line-strong);padding:1.25rem 0 0}.finding-dossier>header{grid-template-columns:1fr}.coverage-table td:last-child{min-width:14rem}.health-row{grid-template-columns:auto minmax(0,1fr)}.health-result{grid-column:2}.fix-row{grid-template-columns:1fr;gap:.75rem}.fix-order{align-items:center;flex-direction:row}.effort{grid-column:1}.preview-stage{min-height:12rem}.ask-form{flex-direction:column}}
@media(max-width:560px){.header-inner{padding:2.5rem 1rem 2rem}.report-header h1{font-size:clamp(2.7rem,14vw,4rem)}.header-links{padding-inline:1rem}.page-shell{padding:1.5rem 1rem 4rem}.score-facts{grid-template-columns:1fr;padding:0 1.5rem 1.5rem}.score-facts div,.score-facts div:first-child,.score-facts div:nth-child(odd){padding:1rem 0;border-left:0;border-right:0;border-top:1px solid rgb(255 255 255/.2)}dl.meta{grid-template-columns:1fr;gap:.1rem}dl.meta dd{margin-bottom:.7rem}.report-tabs{gap:1.2rem}}
@media print{.report-tabs{display:none}.tab-panel[hidden]{display:block!important}.report-header{background:#fff;color:#000}.header-inner{display:block;padding:1rem 0}.header-links{padding-inline:0}.page-shell{max-width:none;padding-inline:0}.scoreboard{border:1px solid #000;color:#000;background:#fff}.score-primary{background:#fff}.score-primary strong,.score-primary p,.score-primary .score-label,.score-facts dt,.score-facts small{color:#000!important}.panel,.result-card,.scoreboard{break-inside:avoid}}
</style></head>
<body><a class="skip-link" href="#report-content">Skip to report content</a><header class="report-header"><div class="header-inner"><div><h1>${escapeHtml(reportName(report))}</h1><p class="lede">Accessibility review · ${escapeHtml(report.standard)} · ${report.summary.actions} tested actions</p></div><dl class="header-meta"><dt>Target</dt><dd><a href="${escapeAttribute(report.target)}">${escapeHtml(report.target)}</a></dd><dt>Assessment</dt><dd>${escapeHtml(report.completeness.status)} · ${report.completeness.completedLanes}/${report.completeness.plannedLanes} lanes</dd></dl></div><nav class="header-links" aria-label="Report downloads"><a href="${encodeURI(report.files.manifest)}">Manifest</a><a href="${encodeURI(report.files.json)}">JSON</a><a href="${encodeURI(report.files.markdown)}">Markdown</a></nav></header>
<main id="report-content" class="page-shell"><div class="decision-room"><section class="status-brief" aria-labelledby="status-heading"><span class="status-flag">${report.verdict === "pass" ? "Ready in tested scope" : report.verdict === "fail" ? "Release blocked in tested scope" : "Decision needs review"}</span><h2 id="status-heading">${report.summary.findings ? `Complete ${report.summary.findings} grouped fix${report.summary.findings === 1 ? "" : "es"} before release` : "No confirmed blocker in the tested scope"}</h2><p>${escapeHtml(statusSummary)}</p><div class="status-meta"><div><strong>${report.summary.findings}</strong><span>grouped fixes</span></div><div><strong>${report.synthesis.affectedInstancesAtLargestCheckpoint}</strong><span>affected instances at the largest checkpoint</span></div><div><strong>${escapeHtml(effortSummary.replace(" engineering hours for the identified fixes and focused regression checks.", " hours"))}</strong><span>estimated focused effort</span></div>${readerStatus ? `<div><strong>${escapeHtml(readerStatus.result)}</strong><span>virtual reader</span></div>` : ""}</div></section><section class="report-assistant" aria-labelledby="assistant-heading"><h2 id="assistant-heading">Ask this report</h2><p>Ask about status, priorities, effort, keyboard access, screen-reader behavior, or a specific finding. Answers stay local and use only captured evidence.</p><div class="question-chips"><button type="button" data-question="How bad is the accessibility of this page?">How bad is it?</button><button type="button" data-question="What should I fix first?">What first?</button><button type="button" data-question="How much effort will the fixes take?">Estimate effort</button></div><form class="ask-form" data-ask-form><label for="report-question">Ask a question about this report</label><input id="report-question" name="question" autocomplete="off" placeholder="Ask about this test…"><button type="submit">Ask</button></form><div class="assistant-answer" role="status" aria-live="polite" aria-atomic="true"><p><strong>Start here:</strong> ${report.summary.findings ? `${report.summary.findings} grouped fixes cover ${report.synthesis.affectedInstancesAtLargestCheckpoint} affected instances at the largest checkpoint. Fixing the shared components should resolve the repeated instances; verify every listed location afterward.` : "No confirmed blocker was found in the tested scope. Ask me what was tested or what remains uncertain."}</p></div></section></div>
<nav class="report-tabs" data-tab-list aria-label="Report sections">${tabLinks.map(([id, label]) => `<a href="#panel-${id}" data-tab>${escapeHtml(label)}</a>`).join("")}</nav>
<section id="panel-overview" class="tab-panel" data-tab-panel><div class="section-intro"><div><h2>Your accessibility status</h2><p>What passed, what failed, and what that means for the tested journey.</p></div><p><strong>Important:</strong> this is a scoped assessment, not a universal accessibility score.</p></div>${renderStatusAreas(report)}<section class="panel"><h3>Recommended fix order</h3>${renderPrioritySnapshot(report)}</section><section class="panel"><h3>What remains uncertain</h3><p>${report.synthesis.uniqueIncompleteRules.length} automated rule type${report.synthesis.uniqueIncompleteRules.length === 1 ? "" : "s"} need human review: ${report.synthesis.uniqueIncompleteRules.map(escapeHtml).join(", ")}. They are not counted as confirmed failures or passes.</p></section></section>
<section id="panel-page" class="tab-panel" data-tab-panel><div class="section-intro"><div><h2>The page as tested</h2><p>Each issue and what the screen reader said, drawn where they were found. Select an item to see it on the page.</p></div></div>${renderPageView(report, views)}</section>
<section id="panel-findings" class="tab-panel" data-tab-panel><div class="section-intro"><div><h2>Grouped fix review</h2><p>Each row is one shared component or token fix. Expand its instance list to see every page location found at the largest checkpoint.</p></div></div>${renderFixPlanner(report, views)}</section>
<section id="panel-journeys" class="tab-panel" data-tab-panel><div class="section-intro"><div><h2>Tested user journeys</h2><p>Behavior results for keyboard, pointer, and the portable virtual reader.</p></div></div><section class="annex-block"><h3>Keyboard and pointer sweep</h3>${renderSweepOverview(views)}</section><section class="annex-block"><h3>Keyboard and pointer overview</h3>${renderKeyboardOverview(report, views)}</section><section class="annex-block"><h3>Virtual screen-reader report</h3>${renderReaderOverview(report, views)}</section></section>
<section id="panel-media" class="tab-panel" data-tab-panel><h2>Visual evidence and recordings</h2><section class="panel"><h3>Interaction videos</h3><div class="media-grid">${
    videos.length
      ? videos
          .map((artifact) => {
            const videoPath = String(artifact.path);
            const caption = captionFor(videoPath);
            const label = artifactLabel(artifact, "Interaction lane");
            return `<figure><video controls preload="metadata"><source src="${encodeURI(videoPath)}" type="video/webm">${caption ? `<track kind="descriptions" src="${encodeURI(String(caption.path))}" srclang="en" label="Action descriptions">` : ""}<a href="${encodeURI(videoPath)}">Download the WebM recording</a></video><figcaption>${escapeHtml(label)}${caption ? ` · <a href="${encodeURI(String(caption.path))}">Read action descriptions</a>` : ""}</figcaption></figure>`;
          })
          .join("")
      : '<p class="empty">No videos were recorded.</p>'
  }</div></section><section class="panel"><h3>Full-page screenshots after each action</h3><div class="media-grid">${
    screenshots.length
      ? screenshots
          .map((artifact) => {
            const artifactPath = String(artifact.path);
            const label = artifactLabel(artifact, "an action");
            return `<figure><a class="image-viewer-trigger" href="${encodeURI(artifactPath)}" data-image-viewer data-view-title="${escapeAttribute(label)}"><img loading="lazy" src="${encodeURI(artifactPath)}" alt="Full-page view after ${escapeAttribute(label)}"></a><figcaption>${escapeHtml(label)} · Click the preview to enlarge · <a href="${encodeURI(artifactPath)}">Open complete page capture</a></figcaption></figure>`;
          })
          .join("")
      : '<p class="empty">No screenshots were captured.</p>'
  }</div></section></section>
<section id="panel-annex" class="tab-panel" data-tab-panel><div class="section-intro"><div><h2>Technical annex</h2><p>Trace every conclusion to DOM, accessibility-tree, focus, Axe, visual, and raw-file evidence.</p></div></div><section class="annex-block"><h3>Correlated finding dossiers</h3>${renderFindingDossiers(report)}</section><section class="annex-block"><h3>Axe results</h3>${renderAxeReportViews(views.axeReports)}</section><section class="annex-block"><h3>Coverage by active lane</h3>${renderLaneCoverage(report)}</section><section class="annex-block"><h3>Assessment scope</h3><dl class="meta"><dt>Scenario</dt><dd>${escapeHtml(report.scenarioId)}</dd><dt>Profile</dt><dd>${escapeHtml(report.profile)}</dd><dt>Target</dt><dd><a href="${escapeAttribute(report.target)}">${escapeHtml(report.target)}</a></dd><dt>Standard</dt><dd>${escapeHtml(report.standard)}</dd><dt>Actions tested</dt><dd>${report.summary.actions} user-authored actions</dd><dt>Evidence</dt><dd>${availableArtifacts}/${report.summary.artifacts} available</dd></dl></section><section class="annex-block"><h3>Evidence files</h3>${renderEvidenceGroups(report.artifacts)}</section><div class="notice-grid"><section class="panel notice"><h3>Privacy</h3><p>Evidence is sensitive, unreviewed, and not authorized for remote upload or sharing.</p></section><section class="panel ai"><h3>AI-generated output</h3><p>${escapeHtml(report.ai.label)}</p></section></div></section>
</main><dialog class="image-dialog" data-image-dialog aria-labelledby="image-dialog-title"><div class="image-dialog-header"><h2 id="image-dialog-title" data-image-dialog-title>Enlarged evidence view</h2><button type="button" class="image-dialog-close" data-image-dialog-close>Close</button></div><div class="image-dialog-visual" data-image-dialog-visual></div><p class="image-dialog-footer"><span>This view preserves the crop and issue marker shown in the report.</span><a href="" data-image-dialog-original>Open complete page capture</a></p></dialog><script type="application/json" id="report-knowledge">${assistantKnowledge}</script><script>
(() => {
  const list=document.querySelector('[data-tab-list]');
  const imageDialog=document.querySelector('[data-image-dialog]');
  const imageDialogVisual=document.querySelector('[data-image-dialog-visual]');
  const imageDialogTitle=document.querySelector('[data-image-dialog-title]');
  const imageDialogOriginal=document.querySelector('[data-image-dialog-original]');
  const imageDialogClose=document.querySelector('[data-image-dialog-close]');
  let lastImageTrigger;
  document.querySelectorAll('[data-image-viewer]').forEach(trigger=>trigger.addEventListener('click',event=>{
    if(!imageDialog?.showModal||!imageDialogVisual||!imageDialogTitle||!imageDialogOriginal)return;
    event.preventDefault();
    lastImageTrigger=trigger;
    const image=trigger.querySelector('img');
    const triggerBounds=trigger.getBoundingClientRect();
    let visual;
    if(trigger.classList.contains('target-crop')){
      visual=trigger.cloneNode(true);
      visual.removeAttribute('href');
      visual.removeAttribute('data-image-viewer');
      visual.classList.remove('image-viewer-trigger');
      visual.setAttribute('role','img');
      visual.setAttribute('aria-label',image?.alt||'Enlarged evidence crop');
      visual.style.setProperty('--viewer-aspect',triggerBounds.width+' / '+triggerBounds.height);
      visual.querySelector('img')?.setAttribute('alt','');
    }else if(trigger.querySelector('.issue-crop')){
      visual=trigger.querySelector('.issue-crop').cloneNode(true);
      visual.setAttribute('role','img');
      visual.setAttribute('aria-label',image?.alt||'Enlarged evidence crop');
      visual.style.setProperty('--viewer-aspect',triggerBounds.width+' / '+triggerBounds.height);
      visual.querySelector('img')?.setAttribute('alt','');
    }else{
      visual=image?.cloneNode(true);
      visual?.removeAttribute('loading');
    }
    if(!visual)return;
    imageDialogVisual.replaceChildren(visual);
    imageDialogTitle.textContent=trigger.dataset.viewTitle||image?.alt||'Enlarged evidence view';
    imageDialogOriginal.href=trigger.href;
    imageDialogOriginal.textContent=trigger.dataset.originalLabel||'Open original image';
    imageDialog.showModal();
  }));
  const closeImageDialog=()=>imageDialog?.close();
  imageDialogClose?.addEventListener('click',closeImageDialog);
  imageDialog?.addEventListener('click',event=>{if(event.target===imageDialog)closeImageDialog();});
  imageDialog?.addEventListener('close',()=>lastImageTrigger?.focus());
  if(!list)return;
  const tabs=[...list.querySelectorAll('[data-tab]')];
  const panels=tabs.map(tab=>document.querySelector(tab.getAttribute('href')));
  list.setAttribute('role','tablist');
  const activate=(index,focus=false)=>{
    tabs.forEach((tab,i)=>{
      tab.setAttribute('role','tab');
      tab.setAttribute('aria-selected',String(i===index));
      tab.setAttribute('tabindex',i===index?'0':'-1');
      tab.setAttribute('aria-controls',panels[i].id);
      panels[i].setAttribute('role','tabpanel');
      panels[i].setAttribute('aria-labelledby',tab.id||(tab.id='report-tab-'+i));
      panels[i].hidden=i!==index;
    });
    if(focus)tabs[index].focus();
  };
  tabs.forEach((tab,index)=>{
    tab.addEventListener('click',event=>{
      event.preventDefault();
      activate(index);
      history.replaceState(null,'',tab.getAttribute('href'));
    });
    tab.addEventListener('keydown',event=>{
      let next=index;
      if(event.key==='ArrowRight'||event.key==='ArrowDown')next=(index+1)%tabs.length;
      else if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=(index-1+tabs.length)%tabs.length;
      else if(event.key==='Home')next=0;
      else if(event.key==='End')next=tabs.length-1;
      else return;
      event.preventDefault();
      activate(next,true);
    });
  });
  const initialPanel=location.hash.startsWith('#finding-')?'#panel-annex':location.hash;
  const requested=tabs.findIndex(tab=>tab.getAttribute('href')===initialPanel);
  activate(requested>=0?requested:0);
  document.body.classList.add('tabs-ready');

  document.querySelectorAll('[data-open-annex]').forEach(link=>link.addEventListener('click',event=>{
    event.preventDefault();
    const index=tabs.findIndex(tab=>tab.getAttribute('href')==='#panel-annex');
    activate(index);
    const selector=link.getAttribute('href');
    history.replaceState(null,'',selector);
    requestAnimationFrame(()=>document.querySelector(selector)?.scrollIntoView());
  }));
  document.querySelectorAll('[data-open-fix-review]').forEach(link=>link.addEventListener('click',event=>{
    event.preventDefault();
    const index=tabs.findIndex(tab=>tab.getAttribute('href')==='#panel-findings');
    activate(index);
    history.replaceState(null,'','#panel-findings');
    list.scrollIntoView();
  }));

  const pagePanel=document.querySelector('#panel-page');
  const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const selectMarker=button=>{
    const state=button.closest('.page-state');
    state.querySelectorAll('.marker-item[aria-current]').forEach(item=>item.removeAttribute('aria-current'));
    state.querySelectorAll('.page-marker.current').forEach(shape=>shape.classList.remove('current'));
    button.setAttribute('aria-current','true');
    const readerList=button.closest('[data-reader-list]');
    if(readerList){
      const items=[...readerList.querySelectorAll('.marker-item')];
      readerList.querySelector('[data-reader-count]').textContent=(items.indexOf(button)+1)+' of '+items.length;
    }
    const shape=state.querySelector('[data-marker-shape="'+button.dataset.marker+'"]');
    const canvas=state.querySelector('.page-canvas');
    if(!shape||!canvas)return;
    shape.classList.add('current');
    shape.parentNode.appendChild(shape);
    const box=shape.getBoundingClientRect();
    const view=canvas.getBoundingClientRect();
    canvas.scrollBy({left:box.left+box.width/2-view.left-view.width/2,top:box.top+box.height/2-view.top-view.height/2,behavior:reducedMotion?'auto':'smooth'});
  };
  pagePanel?.querySelectorAll('.marker-item').forEach(button=>button.addEventListener('click',()=>selectMarker(button)));
  pagePanel?.querySelectorAll('[data-reader-step]').forEach(step=>step.addEventListener('click',()=>{
    const items=[...step.closest('[data-reader-list]').querySelectorAll('.marker-item')];
    const current=items.findIndex(item=>item.getAttribute('aria-current')==='true');
    selectMarker(items[current<0?0:Math.min(items.length-1,Math.max(0,current+Number(step.dataset.readerStep)))]);
  }));

  document.querySelectorAll('[data-copy-ticket]').forEach(button=>button.addEventListener('click',async()=>{
    const row=button.closest('.fix-row');
    const text=row.querySelector('.ticket-text textarea');
    const status=row.querySelector('[data-copy-status]');
    try{
      await navigator.clipboard.writeText(text.value);
      status.textContent='Ticket copied. Paste it into your issue tracker.';
    }catch{
      row.querySelector('.ticket-text').open=true;
      text.focus();
      text.select();
      status.textContent='Copying is blocked here, so the ticket text is selected: press Ctrl+C or Command+C.';
    }
  }));
  const filterButtons=[...document.querySelectorAll('[data-fix-filter]')];
  const fixRows=[...document.querySelectorAll('[data-fix-size]')];
  filterButtons.forEach(button=>{
    button.setAttribute('aria-pressed',String(button.dataset.fixFilter==='all'));
    button.addEventListener('click',()=>{
      const filter=button.dataset.fixFilter;
      filterButtons.forEach(item=>{
        const active=item===button;
        item.classList.toggle('filter-active',active);
        item.setAttribute('aria-pressed',String(active));
      });
      fixRows.forEach(row=>row.hidden=filter!=='all'&&row.dataset.fixSize!==filter);
    });
  });

  const knowledge=JSON.parse(document.querySelector('#report-knowledge').textContent);
  const form=document.querySelector('[data-ask-form]');
  const input=form?.querySelector('input');
  const answerNode=document.querySelector('.assistant-answer');
  const answer=(question)=>{
    const q=question.trim().toLowerCase();
    const first=knowledge.findings[0];
    const named=knowledge.findings.find(finding=>q.includes(finding.ruleId.toLowerCase())||q.includes(finding.title.toLowerCase()));
    if(!q)return 'Ask about status, fix priority, effort, keyboard access, virtual-reader behavior, or a finding name.';
    if(named)return named.fixLabel+' ('+named.ruleId+') is one grouped fix covering '+named.instances+' affected page locations in '+named.components+' component group'+(named.components===1?'':'s')+' and repeated at '+named.checkpoints+' checkpoints. Recommended fix: '+named.fix+' Estimated effort: '+named.effort.hours+'.';
    if(q.includes('first')||q.includes('priority')||q.includes('start'))return first?'Start with '+first.fixLabel+'. It is the highest-priority grouped fix, covers '+first.instances+' affected locations, and is estimated at '+first.effort.hours+'. '+first.fix:'No confirmed fix is queued in this authored scope. Review the incomplete checks or author another journey before estimating work.';
    if(q.includes('effort')||q.includes('long')||q.includes('time')||q.includes('cost'))return knowledge.effortSummary+' These are focused engineering estimates, not delivery commitments; design approval and release process are excluded.';
    const row=(id)=>{const area=knowledge.status.find(candidate=>candidate.id===id);return area?area.label+': '+area.result+'. '+area.detail:'';};
    if(q.includes('keyboard')||q.includes('pointer')||q.includes('hover')||q.includes('focus'))return row('keyboard')+' This does not prove every control or page journey is keyboard accessible.';
    if(q.includes('screen reader')||q.includes('reader')||q.includes('announcement'))return row('reader')+' This is semantic simulation evidence, not VoiceOver or NVDA fidelity testing.';
    if(q.includes('axe')||q.includes('automatic')||q.includes('incomplete')||q.includes('review'))return knowledge.blocking+' grouped fixes block release, covering '+knowledge.affectedInstancesAtLargestCheckpoint+' affected instances at the largest checkpoint.'+(knowledge.advisories?' '+knowledge.advisories+' advisory results do not block release.':'')+' '+knowledge.incompleteRules.length+' rule types remain incomplete and need review'+(knowledge.incompleteRules.length?': '+knowledge.incompleteRules.join(', '):'')+'.';
    if(q.includes('ai'))return 'No AI generated the conclusions in this report. The answers here are deterministic summaries of local captured evidence. AI may be used later only where the report labels it and must be verified.';
    if(q.includes('bad')||q.includes('good')||q.includes('status')||q.includes('score')||q.includes('accessible')||q.includes('release')){
      const scopeNote=' '+knowledge.status.map(area=>area.label+': '+area.result).join('; ')+'. This is not a whole-site accessibility score.';
      if(knowledge.verdict==='pass')return 'No confirmed blocker was found in the tested scope.'+scopeNote;
      if(knowledge.verdict==='fail')return 'Release is blocked in the tested scope because '+knowledge.blocking+' grouped fixes cover '+knowledge.affectedInstancesAtLargestCheckpoint+' affected instances at the largest checkpoint. Fixing the shared components may resolve many repeated locations, but every listed instance must be retested.'+scopeNote;
      return 'The release decision needs review because the captured evidence is incomplete or inconclusive.'+scopeNote;
    }
    return 'I can answer from this report about overall status, what to fix first, estimated effort, keyboard and pointer behavior, virtual-reader results, Axe findings, or a named rule. This question may require a new authored test or an external AI analysis.';
  };
  const showAnswer=(question)=>{
    if(!answerNode)return;
    answerNode.replaceChildren();
    const paragraph=document.createElement('p');
    const label=document.createElement('strong');
    label.textContent='Answer: ';
    paragraph.append(label,document.createTextNode(answer(question)));
    answerNode.append(paragraph);
  };
  form?.addEventListener('submit',event=>{event.preventDefault();showAnswer(input.value);});
  document.querySelectorAll('[data-question]').forEach(button=>button.addEventListener('click',()=>{
    const question=button.dataset.question;
    if(input)input.value=question;
    showAnswer(question);
    document.querySelector('.report-assistant')?.scrollIntoView({block:'nearest'});
  }));
})();
</script></body></html>`;
}

function renderLaneCoverage(report: ScenarioIntegratedReport): string {
  const rows = report.synthesis.lanes
    .map(
      (lane) =>
        `<tr><th scope="row">${escapeHtml(humanDriverName(lane.driver))}</th><td>${lane.actions}</td><td>${lane.passed}</td><td>${lane.failed}</td><td>${lane.unknown}</td><td>${escapeHtml(lane.summary)}</td></tr>`
    )
    .join("");
  return `<section class="panel"><h3>Coverage by active lane</h3><p>These counts exclude the derived release decision so successful behavior is not hidden by the final gate.</p><div class="table-wrap" tabindex="0"><table class="coverage-table"><caption>Direct judgments across the user-authored actions</caption><thead><tr><th scope="col">Lane</th><th scope="col">Actions</th><th scope="col">Passed</th><th scope="col">Failed</th><th scope="col">Unresolved</th><th scope="col">Interpretation</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderStatusAreas(report: ScenarioIntegratedReport): string {
  const laneArtifact = (laneSuffix: string, kind: string) =>
    report.artifacts.find((artifact) => {
      const provenance = isRecord(artifact.provenance) ? artifact.provenance : {};
      return (
        artifact.kind === kind &&
        (kind !== "viewport-screenshot" || artifact.phase === "after") &&
        stringField(provenance, "laneId", "").endsWith(laneSuffix)
      );
    });
  // The authored keyboard lane when there is one; otherwise the sweep, which tabs every stop.
  const authored = Boolean(laneArtifact("-keyboard", "interaction-video"));
  const laneSuffix = authored ? "-keyboard" : "-keyboard-pointer-sweep";
  const keyboardVideo = laneArtifact(laneSuffix, "interaction-video");
  const keyboardCaptions = laneArtifact(laneSuffix, "video-captions");
  const keyboardTimeline = laneArtifact(laneSuffix, "video-sidecar");
  const keyboardPoster = laneArtifact(laneSuffix, "viewport-screenshot");
  const keyboardActions = report.actions.filter(({ driver }) => driver === "keyboard");
  const { undecidedContrast } = report.synthesis;
  const undecidedContrastList = undecidedContrast.length
    ? `<details class="health-detail"><summary>Texts left for a person (${undecidedContrast.length})</summary><ul>${undecidedContrast.map(({ selector, reason }) => `<li><code>${escapeHtml(selector)}</code>: ${escapeHtml(reason)}</li>`).join("")}</ul></details>`
    : "";
  const keyboardRecording = keyboardVideo
    ? `<section class="journey-proof" aria-labelledby="keyboard-recording-heading"><div><h3 id="keyboard-recording-heading">${authored ? "Keyboard journey recording" : "Keyboard sweep recording"}</h3><p>${authored ? "Watch the isolated keyboard lane that produced this result. The recording shows only the user-authored test actions—not a claim about every keyboard path on the page." : "Watch the sweep press Tab through every stop, hover what shows more on hover, and press each control it was allowed to. The descriptions name each step."}</p>${keyboardActions.length ? `<ol>${keyboardActions.map(({ actionId }) => `<li>${escapeHtml(humanActionName(actionId))}</li>`).join("")}</ol>` : ""}<p class="journey-proof-links">${keyboardCaptions ? `<a href="${encodeURI(String(keyboardCaptions.path))}">Read action descriptions</a>` : ""}${keyboardTimeline ? `<a href="${encodeURI(String(keyboardTimeline.path))}">Inspect timed action data</a>` : ""}<a href="${encodeURI(String(keyboardVideo.path))}" download>Download recording</a></p></div><video controls preload="metadata"${keyboardPoster ? ` poster="${encodeURI(String(keyboardPoster.path))}"` : ""} aria-label="Keyboard testing journey recording"><source src="${encodeURI(String(keyboardVideo.path))}" type="video/webm">${keyboardCaptions ? `<track kind="descriptions" src="${encodeURI(String(keyboardCaptions.path))}" srclang="en" label="Action descriptions">` : ""}<a href="${encodeURI(String(keyboardVideo.path))}">Download the keyboard journey recording</a></video></section>`
    : "";
  return `<div class="health-map">${report.synthesis.status
    .map(
      ({ id, label, verdict, result, detail }) =>
        `<div class="health-row" data-status="${escapeAttribute(id)}"><span class="health-signal ${verdict}" aria-hidden="true"></span><div><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span></div><b class="health-result ${verdict}">${escapeHtml(result)}</b></div>${id === "keyboard" ? keyboardRecording : ""}${id === "contrast" ? undecidedContrastList : ""}`
    )
    .join("")}</div>`;
}

function renderSweepOverview(views: IntegratedHtmlViews): string {
  if (views.sweeps.length === 0) {
    return '<p class="empty">No keyboard and pointer sweep evidence was recorded.</p>';
  }
  return views.sweeps
    .map(({ path: sweepPath, screenshotPath, document, readError }) => {
      if (!document) {
        return `<article class="finding-dossier"><p>${escapeHtml(readError ?? "The sweep record could not be read.")}</p></article>`;
      }
      const findings = document.findings ?? [];
      const blocking = findings.filter(({ kind }) => !SWEEP_FINDING_TEXT[kind].advisory);
      // Advisory results never fail the sweep's badge, as they never fail its status row.
      const badge =
        document.status !== "completed"
          ? { verdict: "unknown", label: document.status }
          : blocking.length
            ? {
                verdict: "fail",
                label: `${blocking.length} finding${blocking.length === 1 ? "" : "s"}`
              }
            : findings.length
              ? { verdict: "unknown", label: `${findings.length} advisory` }
              : { verdict: "pass", label: "No findings" };
      const pressed = document.activateControls
        ? `${document.activated?.length ?? 0} controls pressed by keyboard and by mouse`
        : `Controls not pressed: ${ACTIVATE_PAGE_CONTROLS} is not allowed`;
      const rows = findings
        .map((finding, index) => {
          const { label, selector } = sweepFindingInstance(finding, index);
          const { title, advisory } = SWEEP_FINDING_TEXT[finding.kind];
          return `<li><strong>${escapeHtml(title)}${advisory ? " (advisory)" : ""}:</strong> ${escapeHtml(label)} <code>${escapeHtml(selector)}</code></li>`;
        })
        .join("");
      return `<article class="finding-dossier"><header><div><h4>${escapeHtml(document.targetUrl)}</h4><p>${document.tabStops?.length ?? 0} tab stops · ${escapeHtml(pressed)}</p></div><span class="badge ${badge.verdict}">${escapeHtml(badge.label)}</span></header>${document.diagnostics ? `<p>${escapeHtml(document.diagnostics.join(" "))}</p>` : ""}${rows ? `<ul>${rows}</ul>` : ""}<p class="evidence-links"><a href="${encodeURI(sweepPath)}">Open the sweep record</a>${screenshotPath ? ` <a href="${encodeURI(screenshotPath)}">Open the page capture</a>` : ""}</p></article>`;
    })
    .join("");
}

/** One grouped fix as a ticket someone else can act on, from the report alone. */
interface FixTicket {
  title: string;
  severity: string;
  wcag: string[];
  rule: string;
  ruleLink?: string;
  pattern?: string;
  page: string;
  elements: string[];
  pageState: string;
  steps: string[];
  expected: string;
  actual: string[];
  suggestedFix: string;
  aiSuggestion?: string;
  affected: string;
  evidence: string[];
}

/** WCAG and axe requirement titles and links, by requirement id, from the remediation registry. */
const REGISTRY_REQUIREMENTS = new Map(
  remediationRegistry.entries
    .flatMap(({ requirements }) => requirements)
    .map((requirement) => [`${requirement.standard}:${requirement.requirementId}`, requirement])
);

function fixTicket(
  report: ScenarioIntegratedReport,
  views: IntegratedHtmlViews,
  finding: FindingSynthesis
): FixTicket {
  const checkpoint = finding.checkpoints[0];
  const page =
    report.actions.find(({ runId }) => runId === checkpoint?.runId)?.pageUrl ??
    report.journeys[0]?.startUrl ??
    report.target;
  const labels = finding.instances.map(({ label }) => label);
  const first = finding.instances[0];
  const axeRule = REGISTRY_REQUIREMENTS.get(`axe-core:${finding.ruleId}`);
  const ai = finding.remediation.ai;
  const shorten = (text: string) =>
    text.length > 300 ? `${text.slice(0, 300).replace(/\s+\S*$/, "")}…` : text;
  // What the reader said at the element is the clearest "actual"; axe's check list is the fallback.
  const announced = finding.instances.flatMap(({ selector }) => {
    const entry = views.transcripts
      .flatMap(({ entries }) => entries)
      .find(({ nodePath }) => nodePath === selector);
    return entry
      ? [`The virtual screen reader announced "${entry.announcement}" at ${selector}.`]
      : [];
  });
  const expected = isSweepFindingKind(finding.ruleId)
    ? SWEEP_FINDING_TEXT[finding.ruleId].expected
    : finding.title;
  return {
    title: `${finding.title}: ${labels.slice(0, 2).join(", ")}${labels.length > 2 ? ` and ${labels.length - 2} more` : ""}`,
    severity: finding.advisory ? "Advisory, does not block release" : "Blocks release",
    wcag: finding.wcagCriteria.map((criterion) => {
      const requirement = REGISTRY_REQUIREMENTS.get(`WCAG:${criterion.replace(/^WCAG\s*/, "")}`);
      return requirement
        ? `${requirement.requirementId} ${requirement.title}${requirement.level ? ` (${requirement.level})` : ""} ${requirement.url}`
        : criterion;
    }),
    rule: finding.ruleId,
    ruleLink: axeRule?.url,
    pattern: finding.pattern?.url,
    page,
    elements: finding.instances.map(({ selector }) => selector),
    pageState: checkpoint
      ? pageStateLabel(checkpoint.driver, checkpoint.actionId)
      : "The page as tested",
    steps: [
      `Open ${page}.`,
      ...(checkpoint?.driver === "playwright-test"
        ? [
            `Reach the state the test checked: ${humanActionName(checkpoint.actionId).toLowerCase()}.`
          ]
        : []),
      first ? `Find ${first.label} (${first.selector}).` : "Find the affected element.",
      `Check: ${expected.replace(/\.$/, "")}.`
    ],
    expected,
    actual: announced.length
      ? announced.slice(0, 3)
      : [
          ...new Set(finding.instances.flatMap(({ detail }) => (detail ? [shorten(detail)] : [])))
        ].slice(0, 3),
    suggestedFix: finding.remediation.deterministic,
    aiSuggestion:
      ai.status === "suggested" && ai.suggestions?.length
        ? `${ai.suggestions.map(({ selector, text }) => `"${text}" for ${selector}`).join("; ")} (suggested by AI${ai.providerId ? `, ${ai.providerId}` : ""})`
        : undefined,
    affected: `${finding.instanceCount}: ${finding.instances
      .slice(0, 10)
      .map(({ label, selector }) => `${label} (${selector})`)
      .join("; ")}${finding.instanceCount > 10 ? ` and ${finding.instanceCount - 10} more` : ""}`,
    evidence: [
      report.files.html,
      ...(checkpoint?.screenshotPath ? [checkpoint.screenshotPath] : [])
    ]
  };
}

/** A ticket in Markdown that renders as written in GitHub, Jira Cloud and Linear. */
function renderTicketMarkdown(ticket: FixTicket): string {
  // Page text can hold `<label>` or `*`, which Markdown would read as markup.
  const text = (value: string) => value.replace(/[\\`*_[\]<>]/g, "\\$&");
  const code = (value: string) => `\`${value.replaceAll("`", "'")}\``;
  const field = (name: string, value: string) => `- **${name}:**${value ? ` ${value}` : ""}`;
  return [
    `### ${text(ticket.title)}`,
    "",
    field("Severity", ticket.severity),
    field("WCAG", ticket.wcag.map(text).join("; ") || "Not mapped"),
    field("Rule", `${code(ticket.rule)}${ticket.ruleLink ? ` ${ticket.ruleLink}` : ""}`),
    ...(ticket.pattern ? [field("How to build it", ticket.pattern)] : []),
    field(
      "Where",
      `${ticket.page}, ${ticket.elements.slice(0, 3).map(code).join(", ")}, ${text(ticket.pageState.toLowerCase())}`
    ),
    field("Steps to reproduce", ""),
    ...ticket.steps.map((step, index) => `  ${index + 1}. ${text(step)}`),
    field("Expected", text(ticket.expected)),
    field("Actual", ticket.actual.map(text).join(" ") || "See the report's evidence."),
    field("Suggested fix", text(ticket.suggestedFix)),
    ...(ticket.aiSuggestion
      ? [field("AI suggestion, review before use", text(ticket.aiSuggestion))]
      : []),
    field("Affected elements", text(ticket.affected)),
    field("Evidence", ticket.evidence.map(code).join(", "))
  ].join("\n");
}

const CSV_COLUMNS: Array<[string, (ticket: FixTicket) => string]> = [
  ["Title", (ticket) => ticket.title],
  ["Severity", (ticket) => ticket.severity],
  ["WCAG", (ticket) => ticket.wcag.join("; ")],
  ["Rule", (ticket) => ticket.rule],
  ["Rule link", (ticket) => ticket.ruleLink ?? ""],
  ["How to build it", (ticket) => ticket.pattern ?? ""],
  ["Page", (ticket) => ticket.page],
  ["Elements", (ticket) => ticket.elements.join("; ")],
  ["Page state", (ticket) => ticket.pageState],
  [
    "Steps to reproduce",
    (ticket) => ticket.steps.map((step, index) => `${index + 1}. ${step}`).join("\n")
  ],
  ["Expected", (ticket) => ticket.expected],
  ["Actual", (ticket) => ticket.actual.join("\n")],
  ["Suggested fix", (ticket) => ticket.suggestedFix],
  ["AI suggestion, review before use", (ticket) => ticket.aiSuggestion ?? ""],
  ["Affected elements", (ticket) => ticket.affected],
  ["Evidence", (ticket) => ticket.evidence.join("; ")]
];

/**
 * Every fix as one CSV row (RFC 4180), for an issue tracker's import. A cell a spreadsheet would
 * run as a formula, one starting with =, +, -, @ or a tab, is kept as text.
 */
function renderFixesCsv(report: ScenarioIntegratedReport, views: IntegratedHtmlViews): string {
  const cell = (value: string) => {
    const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
    return /[",\n\r]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
  };
  const rows = [
    CSV_COLUMNS.map(([name]) => name),
    ...report.synthesis.findings.map((finding) => {
      const ticket = fixTicket(report, views, finding);
      return CSV_COLUMNS.map(([, value]) => value(ticket));
    })
  ];
  return `${rows.map((row) => row.map(cell).join(",")).join("\r\n")}\r\n`;
}

function renderFixPlanner(report: ScenarioIntegratedReport, views: IntegratedHtmlViews): string {
  if (report.synthesis.findings.length === 0) {
    return '<p class="empty">No confirmed findings need a fix plan in this authored scope.</p>';
  }
  const rows = report.synthesis.findings
    .map((finding, index) => {
      const representative = finding.checkpoints[0];
      const effort = findingEffort(finding.ruleId);
      const priority = finding.advisory
        ? "Advisory"
        : finding.severity === "critical"
          ? "P0"
          : index === 0
            ? "P1"
            : "P2";
      const screenshot = representative?.screenshotPath;
      const video = report.artifacts.find((artifact) => artifact.kind === "interaction-video");
      return `<article class="fix-row" data-fix-size="${escapeAttribute(effort.size.toLowerCase())}" id="review-${escapeAttribute(finding.ruleId)}"><div class="fix-order"><span${finding.advisory ? ' class="advisory"' : ""}>${escapeHtml(priority)}</span><strong>${index + 1}</strong></div><div class="fix-main"><header><div><h3>${escapeHtml(findingFixLabel(finding))}</h3><p class="technical-id">${escapeHtml(finding.ruleId)}${finding.wcagCriteria.length ? ` · ${finding.wcagCriteria.map(escapeHtml).join(", ")}` : ""}</p></div>${renderFindingBadge(finding)}</header><p>${escapeHtml(findingImpact(finding))}</p>${renderPatternLink(finding)}<div class="fix-scope"><strong>One grouped fix</strong><span>${finding.instanceCount} affected page location${finding.instanceCount === 1 ? "" : "s"} in ${finding.componentCount} component group${finding.componentCount === 1 ? "" : "s"}, repeated at ${finding.checkpointCount} checkpoints.</span></div><div class="before-after">${renderCurrentEvidence(finding, screenshot)}${renderProposedFix(finding)}</div>${renderAiSuggestions(finding.remediation.ai)}${renderFindingInstances(finding)}<div class="fix-actions"><a href="#finding-${escapeAttribute(finding.ruleId)}" data-open-annex>Inspect correlated evidence</a>${video ? `<a href="${encodeURI(String(video.path))}">Watch tested journey</a>` : ""}<button type="button" class="ask-about" data-question="What should I do about ${escapeAttribute(finding.ruleId)}?">Ask this report</button><button type="button" class="ask-about" data-copy-ticket>Copy as ticket<span class="visually-hidden"> for ${escapeHtml(findingFixLabel(finding))}</span></button><span class="copy-status" role="status" data-copy-status></span></div><details class="ticket-text"><summary>Ticket text<span class="visually-hidden"> for ${escapeHtml(findingFixLabel(finding))}</span></summary><textarea readonly rows="14" aria-label="${escapeAttribute(`Ticket for ${findingFixLabel(finding)}`)}">${escapeHtml(renderTicketMarkdown(fixTicket(report, views, finding)))}</textarea></details></div><aside class="effort"><strong>${escapeHtml(effort.size)}</strong><span>${escapeHtml(effort.hours)}</span><p>${escapeHtml(effort.rationale)}</p></aside></article>`;
    })
    .join("");
  return `<div class="planner-tools"><p><strong>Estimated focused effort:</strong> ${escapeHtml(totalEffortSummary(report.synthesis.findings))}</p><a class="csv-download" href="${encodeURI(report.files.csv)}" download>Download all fixes as CSV</a><div class="fix-filters" role="group" aria-label="Filter fix plan"><button type="button" class="filter-active" data-fix-filter="all">All fixes</button><button type="button" data-fix-filter="small">Quick wins</button><button type="button" data-fix-filter="medium">Medium effort</button></div></div><div class="fix-list">${rows}</div><p class="estimate-note">Effort is a planning estimate based on the captured components and includes focused regression checks. It does not include release process, design approval, or unrelated refactoring.</p>`;
}

/** An advisory result is labelled as such, never with a severity that suggests it blocks. */
function renderFindingBadge(finding: FindingSynthesis): string {
  return finding.advisory
    ? '<span class="badge unknown">Advisory</span>'
    : `<span class="badge fail">${escapeHtml(finding.severity)}</span>`;
}

function findingFixLabel(finding: FindingSynthesis): string {
  if (isSweepFindingKind(finding.ruleId)) return SWEEP_FINDING_TEXT[finding.ruleId].title;
  if (finding.ruleId === "aria-required-parent")
    return "Give each ARIA role the parent it requires";
  if (finding.ruleId === "color-contrast") {
    return `Replace the low-contrast ${contrastSubject(finding.instances)} color`;
  }
  return humanActionName(finding.ruleId);
}

function renderCurrentEvidence(finding: FindingSynthesis, screenshot?: string): string {
  if (finding.ruleId === "aria-required-parent") {
    const samples = finding.instances.slice(0, 6);
    return `<figure class="current-state semantic-current"><div class="semantic-evidence"><strong>This defect is not visible in a screenshot</strong><p>The pixels look normal. The failure is in the roles given to the affected elements.</p><div class="instance-chips">${samples.map(({ label }) => `<span>${escapeHtml(label)}</span>`).join("")}${finding.instanceCount > samples.length ? `<span>+${finding.instanceCount - samples.length} more</span>` : ""}</div></div><figcaption><strong>Current evidence</strong><span>${finding.instanceCount} instances share the same incorrect component pattern${screenshot ? ` · <a href="${encodeURI(screenshot)}">open page context</a>` : ""}</span></figcaption></figure>`;
  }
  if (screenshot) {
    const locatedTargets = finding.instances.filter(({ targetBox }) => Boolean(targetBox));
    const visibleTargets = finding.instances
      .map(
        (instance, index) =>
          `<li><b>${index + 1}. ${escapeHtml(instance.label)}</b><span>${escapeHtml(instance.component)}${instanceMeasurement(instance.detail) ? ` · ${escapeHtml(instanceMeasurement(instance.detail)!)} contrast` : ""}</span></li>`
      )
      .join("");
    const targetCrops = locatedTargets.length
      ? `<div class="target-crop-grid">${locatedTargets
          .map((instance, index) => {
            const targetBox = instance.targetBox!;
            const centerX = ((targetBox.x + targetBox.width / 2) / targetBox.pageWidth) * 100;
            const centerY = ((targetBox.y + targetBox.height / 2) / targetBox.pageHeight) * 100;
            const left = (targetBox.x / targetBox.pageWidth) * 100;
            const width = Math.max((targetBox.width / targetBox.pageWidth) * 100, 4);
            return `<a class="target-crop image-viewer-trigger" href="${encodeURI(screenshot)}" data-image-viewer data-view-title="${escapeAttribute(`${instance.label} in ${instance.component}`)}" data-original-label="Open complete page capture" style="--target-x:${centerX.toFixed(3)}%;--target-y:${centerY.toFixed(3)}%;--target-left:${left.toFixed(3)}%;--target-width:${width.toFixed(3)}%"><img loading="lazy" src="${encodeURI(screenshot)}" alt="Page crop locating ${escapeAttribute(instance.label)} in the ${escapeAttribute(instance.component)}"><i aria-hidden="true"></i><b>${index + 1}. ${escapeHtml(instance.label)}</b><span>${escapeHtml(instance.component)}${instanceMeasurement(instance.detail) ? ` · ${escapeHtml(instanceMeasurement(instance.detail)!)} contrast` : ""}</span></a>`;
          })
          .join("")}</div>`
      : `<a class="image-viewer-trigger" href="${encodeURI(screenshot)}" data-image-viewer data-view-title="${escapeAttribute(findingFixLabel(finding))}" data-original-label="Open complete page capture"><span class="issue-crop"><img loading="lazy" src="${encodeURI(screenshot)}" alt="Page context for ${escapeAttribute(findingFixLabel(finding))}"><b>Visual context only</b></span></a>`;
    return `<figure class="current-state" data-rule-id="${escapeAttribute(finding.ruleId)}">${targetCrops}<figcaption><strong>Exact affected locations</strong>${visibleTargets ? `<ol class="visual-targets">${visibleTargets}</ol>` : ""}<span>Click a crop to enlarge that exact view. · <a href="${encodeURI(screenshot)}">Open complete page capture</a></span></figcaption></figure>`;
  }
  return `<figure class="current-state"><div class="semantic-evidence"><strong>No visual capture was available</strong><p>Use the exact element locations below with the DOM and Axe evidence.</p></div><figcaption><strong>Current evidence</strong><span>${finding.instanceCount} affected page location${finding.instanceCount === 1 ? "" : "s"}</span></figcaption></figure>`;
}

function instanceMeasurement(detail?: string): string | undefined {
  return /contrast of\s+([0-9.]+)/i.exec(detail ?? "")?.[1]?.concat(":1");
}

function renderPatternLink(finding: FindingSynthesis): string {
  if (!finding.pattern) return "";
  return `<p class="pattern-link"><strong>How to build it right:</strong> <a href="${escapeAttribute(finding.pattern.url)}">${escapeHtml(finding.pattern.id)} pattern</a> (a11y-skills)</p>`;
}

function renderFindingInstances(finding: FindingSynthesis): string {
  if (!finding.instances.length) return "";
  const groups = [...new Set(finding.instances.map(({ component }) => component))];
  const rows = finding.instances
    .map(
      (instance, index) =>
        `<tr><td>${index + 1}</td><td><strong>${escapeHtml(instance.component)}</strong></td><td>${escapeHtml(instance.label)}</td><td><code>${escapeHtml(instance.selector)}</code>${instance.detail ? `<small>${escapeHtml(instance.detail)}</small>` : ""}</td></tr>`
    )
    .join("");
  return `<details class="instance-list"><summary>Show all ${finding.instanceCount} affected page location${finding.instanceCount === 1 ? "" : "s"}</summary><p>Grouped into ${groups.length} component group${groups.length === 1 ? "" : "s"}: ${groups.map(escapeHtml).join(", ")}. These are listed once from the largest checkpoint; the same pattern repeated at ${finding.checkpointCount} checkpoints.</p><div class="table-wrap" tabindex="0"><table><caption>Every distinct affected location in the representative checkpoint</caption><thead><tr><th scope="col">#</th><th scope="col">Component</th><th scope="col">Visible element</th><th scope="col">Exact locator and measurement</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
}

function renderPrioritySnapshot(report: ScenarioIntegratedReport): string {
  if (report.synthesis.findings.length === 0) {
    return '<p class="empty">No confirmed fixes are queued in this authored scope.</p>';
  }
  return `<ol class="priority-snapshot">${report.synthesis.findings
    .map((finding, index) => {
      const effort = findingEffort(finding.ruleId);
      return `<li><span>${index + 1}</span><div><strong>${escapeHtml(finding.title)}</strong>${finding.advisory ? " (advisory)" : ""}<p>${escapeHtml(findingImpact(finding))}</p></div><b>${escapeHtml(effort.hours)}</b></li>`;
    })
    .join(
      ""
    )}</ol><p><a href="#panel-findings" data-open-fix-review>Open the visual fix review</a></p>`;
}

function findingImpact(finding: FindingSynthesis): string {
  if (isSweepFindingKind(finding.ruleId)) return SWEEP_FINDING_TEXT[finding.ruleId].impact;
  if (finding.ruleId === "aria-required-parent") {
    return "Screen-reader users may hear roles, such as menu items, that the page does not implement, which misleads them about its structure.";
  }
  if (finding.ruleId === "color-contrast") {
    return `Some people with low vision or reduced contrast sensitivity may not be able to read this ${contrastSubject(finding.instances) === "link" ? "link text" : "text"}.`;
  }
  if (finding.advisory) {
    return "A best-practice result: it can make the page harder to use, but it is not a WCAG failure and does not block release.";
  }
  return "The confirmed rule failure can prevent people from understanding or operating the tested page as intended.";
}

const AI_STATUS_LABELS: Record<FindingAi["status"], string> = {
  "not-applicable": "Not used",
  "available-if-needed": "Allowed, not used",
  "not-configured": "Allowed, no model set",
  suggested: "AI suggestion"
};

/** Plain words for the evidence a specialist cites. */
const EVIDENCE_WORDS: Record<string, string> = {
  selector: "its selector",
  role: "its role",
  iconDescription: "its icon's markup",
  nearbyHeading: "the heading above it",
  nearbyText: "the text around it",
  destinationText: "where it leads",
  source: "the image file",
  currentAlternative: "its current alternative",
  markupRole: "its markup",
  linkOrButtonText: "its link or button text",
  caption: "its caption",
  title: "its title"
};

/** The AI answers on a fix card, labelled as AI; or, when no model is set, how to set one. */
function renderAiSuggestions(ai: FindingAi): string {
  if (ai.status === "not-configured") {
    return `<p class="ai-note"><span class="badge suggested">AI</span> ${escapeHtml(ai.reason)}</p>`;
  }
  if (!ai.suggestions?.length) return "";
  return `<section class="ai-suggestion"><h4><span class="badge suggested">AI suggestion</span> Review before use</h4><ul>${ai.suggestions.map(renderAiSuggestion).join("")}</ul><p class="ai-note">Suggested by ${escapeHtml(ai.providerId ?? "a model")}. An AI suggestion never passes or fails anything: the finding stands until a rerun passes.</p></section>`;
}

function renderAiContribution(ai: FindingAi): string {
  return `<p><span class="badge ${ai.used ? "suggested" : "unknown"}">${AI_STATUS_LABELS[ai.status]}</span></p><p>${escapeHtml(ai.reason)}</p>${ai.suggestions?.length ? `<ul>${ai.suggestions.map(renderAiSuggestion).join("")}</ul>` : ""}${ai.notes?.length ? `<ul class="ai-meta">${ai.notes.map((note) => `<li>${escapeHtml(note)}</li>`).join("")}</ul>` : ""}`;
}

function renderAiSuggestion(suggestion: AiSuggestion): string {
  const text = suggestion.text
    ? `“${escapeHtml(suggestion.text)}”`
    : "An empty alternative (decorative)";
  return `<li><p><strong>${text}</strong> for <code>${escapeHtml(suggestion.selector)}</code>${suggestion.classification ? ` · image role: ${escapeHtml(suggestion.classification)}` : ""}</p><p>${escapeHtml(suggestion.rationale)}</p><p class="ai-meta">Based on ${escapeHtml(citedEvidence(suggestion.citedEvidenceIds))} · confidence ${suggestion.confidence.toFixed(2)}</p></li>`;
}

function aiMarkdown(ai: FindingAi): string {
  if (!ai.suggestions?.length) {
    return [`${AI_STATUS_LABELS[ai.status]} — ${ai.reason}`, ...(ai.notes ?? [])].join(" ");
  }
  return `AI suggestion from ${ai.providerId ?? "a model"}, review before use: ${ai.suggestions
    .map(
      (suggestion) =>
        `${suggestion.text ? `“${suggestion.text}”` : "an empty alternative"} for \`${suggestion.selector}\` (based on ${citedEvidence(suggestion.citedEvidenceIds)}; confidence ${suggestion.confidence.toFixed(2)})`
    )
    .join("; ")}.`;
}

function citedEvidence(ids: string[]): string {
  const words = ids.map((id) => EVIDENCE_WORDS[id] ?? id);
  return words.length > 1
    ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
    : (words[0] ?? "");
}

function renderProposedFix(finding: FindingSynthesis): string {
  if (finding.ruleId === "color-contrast") {
    const preview = contrastFixPreview(finding.remediation.deterministic);
    if (preview) {
      return `<figure class="proposed-state contrast-preview"><div class="preview-stage"><div class="contrast-pair"><span class="color-field" style="background:${escapeAttribute(preview.background)}" role="img" aria-label="Current foreground ${escapeAttribute(preview.current)} on background ${escapeAttribute(preview.background)}"><i style="background:${escapeAttribute(preview.current)}" aria-hidden="true"></i></span><strong>Current pair</strong><small><code>${escapeHtml(preview.current)}</code> on <code>${escapeHtml(preview.background)}</code> · ${preview.currentRatio}:1</small></div><div class="contrast-pair"><span class="color-field" style="background:${escapeAttribute(preview.background)}" role="img" aria-label="Candidate foreground ${escapeAttribute(preview.candidate)} on background ${escapeAttribute(preview.background)}"><i style="background:${escapeAttribute(preview.candidate)}" aria-hidden="true"></i></span><strong>Passing candidate</strong><small><code>${escapeHtml(preview.candidate)}</code> on <code>${escapeHtml(preview.background)}</code> · ${preview.candidateRatio}:1</small></div></div><figcaption><strong>Proposed fix</strong><span>Candidate foreground <code>${escapeHtml(preview.candidate)}</code> passes against the hardest captured background; confirm it as a brand token.</span></figcaption></figure>`;
    }
  }
  return `<figure class="proposed-state"><div class="preview-stage"><p>${escapeHtml(finding.remediation.deterministic)}</p></div><figcaption><strong>Proposed fix</strong><span>Verify the implementation against the same authored journey.</span></figcaption></figure>`;
}

function contrastFixPreview(remediation: string): {
  current: string;
  candidate: string;
  background: string;
  currentRatio: string;
  candidateRatio: string;
} | null {
  const pairs = [
    ...remediation.matchAll(
      /foreground color:\s*(#[0-9a-f]{6}).*?background color:\s*(#[0-9a-f]{6})/gi
    )
  ].map((match) => ({ foreground: match[1]!.toLowerCase(), background: match[2]!.toLowerCase() }));
  if (!pairs.length) return null;
  const current = pairs[0]!.foreground;
  const backgrounds = [...new Set(pairs.map(({ background }) => background))];
  const required = requiredContrastRatio(remediation) ?? 4.5;
  const passes = (color: string) =>
    backgrounds.every((background) => contrastRatio(color, background) >= required);
  // The smallest step toward black or white that passes on every captured background.
  let candidate: string | undefined;
  for (let step = 1; step <= 100 && !candidate; step += 1) {
    candidate = [
      mixHexColor(current, "#000000", step / 100),
      mixHexColor(current, "#ffffff", step / 100)
    ].find(passes);
  }
  if (!candidate) return null;
  const background = backgrounds.reduce((hardest, value) =>
    contrastRatio(current, value) < contrastRatio(current, hardest) ? value : hardest
  );
  return {
    current,
    candidate,
    background,
    currentRatio: contrastRatio(current, background).toFixed(2),
    candidateRatio: contrastRatio(candidate, background).toFixed(2)
  };
}

/** `hex` moved `amount` (0–1) of the way toward `target`, channel by channel. */
function mixHexColor(hex: string, target: string, amount: number): string {
  const channel = (color: string, index: number) =>
    Number.parseInt(color.slice(index, index + 2), 16);
  return `#${[1, 3, 5]
    .map((index) =>
      Math.round(channel(hex, index) + (channel(target, index) - channel(hex, index)) * amount)
        .toString(16)
        .padStart(2, "0")
    )
    .join("")}`;
}

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = [1, 3, 5].map(
      (index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255
    );
    const linear = channels.map((value) =>
      value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    );
    return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!;
  };
  const foregroundLuminance = luminance(foreground);
  const backgroundLuminance = luminance(background);
  return (
    (Math.max(foregroundLuminance, backgroundLuminance) + 0.05) /
    (Math.min(foregroundLuminance, backgroundLuminance) + 0.05)
  );
}

function renderFindingDossiers(report: ScenarioIntegratedReport): string {
  if (report.synthesis.findings.length === 0) {
    return '<p class="empty">No confirmed findings were emitted.</p>';
  }
  return report.synthesis.findings
    .map((finding) => {
      const representative = finding.checkpoints[0];
      const checkpointRows = finding.checkpoints
        .map(
          (checkpoint) =>
            `<tr><th scope="row">${escapeHtml(humanActionName(checkpoint.actionId))}<div class="technical-id">${escapeHtml(checkpoint.laneId)}</div></th><td><span class="badge ${checkpoint.behaviorVerdict}">${escapeHtml(checkpoint.behaviorVerdict)}</span> <strong>${escapeHtml(behaviorLabelForDriver(checkpoint.driver))}</strong><details><summary>Read judgment</summary><p>${escapeHtml(checkpoint.behaviorSummary)}</p></details></td><td>${checkpoint.nodeCount}</td><td>${renderEvidenceLinks(checkpoint)}</td></tr>`
        )
        .join("");
      const sample = representative?.htmlSamples[0];
      return `<article class="finding-dossier" data-rule-id="${escapeAttribute(finding.ruleId)}" id="finding-${escapeAttribute(finding.ruleId)}"><header><div><h3>${escapeHtml(finding.ruleId)}</h3><p>${escapeHtml(finding.title)}</p></div>${renderFindingBadge(finding)}</header><p class="finding-summary">${escapeHtml(finding.conclusion)}</p><p><strong>Standards:</strong> ${finding.wcagCriteria.length ? finding.wcagCriteria.map(escapeHtml).join(", ") : "No WCAG tag was emitted by the rule."}</p>${renderPatternLink(finding)}<div class="evidence-preview">${representative?.screenshotPath ? `<figure><a class="image-viewer-trigger" href="${encodeURI(representative.screenshotPath)}" data-image-viewer data-view-title="${escapeAttribute(`${finding.title} representative checkpoint`)}"><img loading="lazy" src="${encodeURI(representative.screenshotPath)}" alt="Full-page evidence for ${escapeAttribute(humanActionName(representative.actionId))}"></a><figcaption>Representative full-page checkpoint · Click to enlarge · <a href="${encodeURI(representative.screenshotPath)}">open complete page capture</a></figcaption></figure>` : ""}<div><h4>Representative affected element</h4><p><strong>${representative?.nodeCount ?? 0}</strong> affected nodes at this checkpoint. ${representative && representative.nodeCount > representative.targets.length ? `${representative.targets.length} representative selectors are summarized here; every node remains in the raw Axe evidence.` : ""}</p>${representative?.targets.length ? `<p><strong>First selector:</strong> <code>${escapeHtml(representative.targets[0]!)}</code></p>` : ""}${sample ? `<details><summary>Show captured HTML</summary><pre class="technical-sample">${escapeHtml(sample)}</pre></details>` : ""}${representative ? renderEvidenceLinks(representative) : ""}</div></div><div class="table-wrap" tabindex="0"><table><caption>Every checkpoint considered in this conclusion</caption><thead><tr><th scope="col">Action and lane</th><th scope="col">Independent behavior result</th><th scope="col">Affected nodes</th><th scope="col">Correlated evidence</th></tr></thead><tbody>${checkpointRows}</tbody></table></div><div class="remediation-grid"><section><h4>Deterministic remediation</h4><p>${escapeHtml(finding.remediation.deterministic)}</p><h4>Verification after the fix</h4><ol class="verification-list">${finding.remediation.verification.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></section><section><h4>AI contribution</h4>${renderAiContribution(finding.remediation.ai)}</section></div></article>`;
    })
    .join("");
}

function renderEvidenceLinks(checkpoint: FindingCheckpointSynthesis): string {
  const links = [
    [checkpoint.domPath, "DOM"],
    [checkpoint.accessibilityTreePath, "Accessibility tree"],
    [checkpoint.screenshotPath, "Full-page visual"],
    [checkpoint.viewportPath, "Viewport visual"],
    [checkpoint.focusPath, "Focus"],
    [checkpoint.readerTranscriptPath, "Reader state"],
    [checkpoint.axePath, "Axe"],
    [checkpoint.sweepPath, "Keyboard and pointer sweep"]
  ].filter((entry): entry is [string, string] => Boolean(entry[0]));
  return links.length
    ? `<ul class="evidence-links">${links.map(([href, label]) => `<li><a href="${encodeURI(href)}">${escapeHtml(label)}</a></li>`).join("")}</ul>`
    : '<span class="empty">No linked evidence</span>';
}

function renderKeyboardOverview(
  report: ScenarioIntegratedReport,
  views: IntegratedHtmlViews
): string {
  if (views.comparisons.length === 0) {
    return '<p class="empty">No pointer/keyboard comparison was authored for this scenario.</p>';
  }
  return views.comparisons
    .map((comparison) => {
      const actions = report.actions.filter(
        ({ actionId }) =>
          comparison.pointer.actionIds.includes(actionId) ||
          comparison.keyboard.actionIds.includes(actionId)
      );
      const actionViews = actions
        .map((action) => {
          const actionView = views.actionReports.find(
            (candidate) => candidate.action.runId === action.runId
          );
          return renderInputActionEvidence(report, action, actionView);
        })
        .join("");
      return `<article class="finding-dossier"><header><div><h3>${escapeHtml(comparison.name)}</h3><p>${escapeHtml(comparison.isolation.replaceAll("-", " "))}</p></div><span class="badge ${comparison.status === "completed" ? "pass" : "unknown"}">${escapeHtml(comparison.status)}</span></header>${comparison.readError ? `<p>${escapeHtml(comparison.readError)}</p>` : `<div class="outcome-pair"><section class="outcome"><h4>Equivalent outcome <span class="badge ${comparison.equivalence.verdict}">${escapeHtml(comparison.equivalence.verdict)}</span></h4><p>${escapeHtml(comparison.equivalence.summary)}</p></section><section class="outcome"><h4>Expected outcome <span class="badge ${comparison.expectation.verdict}">${escapeHtml(comparison.expectation.verdict)}</span></h4><p>${escapeHtml(comparison.expectation.summary)}</p></section></div><div class="table-wrap" tabindex="0"><table><caption>Observed result in each isolated lane</caption><thead><tr><th scope="col">Lane</th><th scope="col">Authored actions</th><th scope="col">URL</th><th scope="col">Visible</th><th scope="col">Text</th></tr></thead><tbody>${renderComparisonLaneRow("Pointer", comparison.pointer)}${renderComparisonLaneRow("Keyboard", comparison.keyboard)}</tbody></table></div>${actionViews}`}<p><a class="raw-link" href="${encodeURI(comparison.path)}">Open complete interaction trace</a></p></article>`;
    })
    .join("");
}

function renderComparisonLaneRow(label: string, lane: InputComparisonView["keyboard"]): string {
  return `<tr><th scope="row">${escapeHtml(label)}</th><td>${lane.actionIds.map((id) => escapeHtml(humanActionName(id))).join(", ")}</td><td>${escapeHtml(lane.url ?? "Not recorded")}</td><td>${lane.visible === undefined ? "Not recorded" : lane.visible ? "Yes" : "No"}</td><td>${escapeHtml(lane.text ?? "Not recorded")}</td></tr>`;
}

function renderInputActionEvidence(
  report: ScenarioIntegratedReport,
  action: ScenarioActionReport,
  view: ActionReportView | undefined
): string {
  const screenshot = actionArtifactPath(report, action, "viewport-screenshot", "after");
  const fullPage = actionArtifactPath(report, action, "full-page-screenshot", "after");
  const links = renderActionEvidenceLinks(report, action);
  const behavior = view?.judgments.find(
    ({ judgeId }) => judgeId !== "axe" && judgeId !== "release"
  );
  return `<section class="panel"><div class="card-heading"><div><h3>${escapeHtml(humanActionName(action.actionId))}</h3><div class="technical-id">${escapeHtml(action.laneId)}</div></div><span class="badge ${behavior?.verdict ?? "unknown"}">${escapeHtml(behavior?.verdict ?? "unknown")}</span></div><p>${escapeHtml(behavior?.summary ?? "No independent behavior judgment was available.")}</p><div class="lane-visuals">${screenshot ? `<figure><a class="image-viewer-trigger" href="${encodeURI(screenshot)}" data-image-viewer data-view-title="${escapeAttribute(`Viewport after ${humanActionName(action.actionId)}`)}"><img loading="lazy" src="${encodeURI(screenshot)}" alt="Viewport after ${escapeAttribute(humanActionName(action.actionId))}"></a><figcaption>Viewport after action · Click to enlarge · <a href="${encodeURI(screenshot)}">open original capture</a></figcaption></figure>` : ""}${fullPage ? `<figure><a class="image-viewer-trigger" href="${encodeURI(fullPage)}" data-image-viewer data-view-title="${escapeAttribute(`Full page after ${humanActionName(action.actionId)}`)}"><img loading="lazy" src="${encodeURI(fullPage)}" alt="Full page after ${escapeAttribute(humanActionName(action.actionId))}"></a><figcaption>Full page after action · Click to enlarge · <a href="${encodeURI(fullPage)}">open complete page capture</a></figcaption></figure>` : ""}</div>${links}</section>`;
}

function renderActionEvidenceLinks(
  report: ScenarioIntegratedReport,
  action: ScenarioActionReport
): string {
  const links: Array<[string | undefined, string]> = [
    [actionArtifactPath(report, action, "dom-snapshot", "after"), "DOM after"],
    [actionArtifactPath(report, action, "accessibility-tree", "after"), "Accessibility tree after"],
    [actionArtifactPath(report, action, "focus-state", "after"), "Focus after"],
    [actionArtifactPath(report, action, "axe-result", "after"), "Axe after"],
    [action.reportPath, "Raw action report"]
  ];
  return `<ul class="evidence-links">${links
    .filter((entry): entry is [string, string] => Boolean(entry[0]))
    .map(([href, label]) => `<li><a href="${encodeURI(href)}">${escapeHtml(label)}</a></li>`)
    .join("")}</ul>`;
}

type PageLayerId = "issues" | "reader" | "headings" | "tab-order" | "images" | "focus";

/** One item of a layer: a list entry, and an outline on the page wherever a box was recorded. */
interface PageMarker {
  id: string;
  /** What the outline's badge and the list item's number say. */
  badge: string;
  box?: { x: number; y: number; width: number; height: number };
  title: string;
  detail: string;
  /** A result's colour: red where the item is flagged, neutral where it is only shown. */
  tone: "fail" | "advisory" | "neutral";
  flag?: string;
  /** How far a heading is indented, by its level. */
  depth?: number;
  /** A close-up to show with the item. */
  image?: string;
  /** Listed after the layer's numbered items, such as a keyboard problem where Tab never goes. */
  apart?: true;
}

/**
 * The Page view's layers, in the order the switches list them. A layer shows only what the run
 * measured, and the four added from the element map and the sweep start switched off.
 */
const PAGE_LAYERS: ReadonlyArray<{
  id: PageLayerId;
  label: string;
  heading: string;
  /** What one of its markers is, for the picture's text alternative. */
  noun: string;
  /** The heading of the items listed apart from the numbered ones. */
  apartHeading?: string;
  on: boolean;
  /** The outline's badge sits left of it or right, so two layers on one element both read. */
  badgeSide: "left" | "right";
  scope?: string;
}> = [
  {
    id: "issues",
    label: "Issues",
    heading: "Issues on this page",
    noun: "issue",
    on: true,
    badgeSide: "left"
  },
  {
    id: "reader",
    label: "Screen reader path",
    heading: "What the screen reader said",
    noun: "announcement",
    on: true,
    badgeSide: "right",
    scope:
      "Only what the scenario's reader commands reached. Add commands to cover more of the page."
  },
  {
    id: "headings",
    label: "Headings",
    heading: "Headings",
    noun: "heading",
    on: false,
    badgeSide: "left",
    scope:
      "Indented by level, as a screen reader's heading list shows them. Whether a level suits its section is for a person to judge."
  },
  {
    id: "tab-order",
    label: "Tab order",
    heading: "Tab order",
    noun: "Tab order item",
    apartHeading: "Keyboard problems where Tab never goes",
    on: false,
    badgeSide: "left",
    scope: "In the order Tab reached each stop, with what the keyboard sweep found on it."
  },
  {
    id: "images",
    label: "Images and alt text",
    heading: "Images and their text alternatives",
    noun: "image",
    on: false,
    badgeSide: "right"
  },
  {
    id: "focus",
    label: "Focus indicator",
    heading: "Focus indicator at each Tab stop",
    noun: "focus indicator",
    on: false,
    badgeSide: "right",
    scope:
      "Each stop as Tab reached it. Focus counts as visible when the stop looks different with focus than without; its contrast is not measured."
  }
];

/** One screenshot and everything located on it, layer by layer. */
interface PageState {
  screenshot?: string;
  label: string;
  pageUrl?: string;
  width?: number;
  height?: number;
  layers: Record<PageLayerId, PageMarker[]>;
  /** Why this state's headings and images could not be shown. */
  elementMapError?: string;
}

/**
 * Groups every located finding instance, reader announcement, heading, image and Tab stop by the
 * screenshot it was measured on, so each box is drawn on the page as it was when it was found and
 * never on another capture.
 */
function buildPageStates(
  report: ScenarioIntegratedReport,
  views: IntegratedHtmlViews
): PageState[] {
  const states = new Map<string, PageState>();
  const stateFor = (screenshot: string | undefined, label: string, pageUrl?: string) => {
    const key = screenshot ?? `no-screenshot:${label}`;
    let state = states.get(key);
    if (!state) {
      const screen = views.screens.find(({ path: screenPath }) => screenPath === screenshot);
      state = {
        screenshot,
        label,
        pageUrl,
        width: screen?.width,
        height: screen?.height,
        layers: { issues: [], reader: [], headings: [], "tab-order": [], images: [], focus: [] }
      };
      states.set(key, state);
    }
    return state;
  };
  for (const finding of report.synthesis.findings) {
    const checkpoint = finding.checkpoints[0];
    const action = report.actions.find(({ runId }) => runId === checkpoint?.runId);
    const state = stateFor(
      checkpoint?.screenshotPath,
      checkpoint ? pageStateLabel(checkpoint.driver, checkpoint.actionId) : "Page",
      action?.pageUrl
    );
    for (const instance of finding.instances) {
      if (instance.targetBox) {
        // Boxes are in page pixels; a screenshot at a higher pixel ratio is scaled to them.
        state.width = instance.targetBox.pageWidth;
        state.height = instance.targetBox.pageHeight;
      }
      state.layers.issues.push({
        id: "",
        badge: "",
        ...(instance.targetBox ? { box: instance.targetBox } : {}),
        title: findingFixLabel(finding),
        detail: `${instance.label} · ${finding.advisory ? "Advisory" : "Blocks release"}${instance.targetBox ? "" : " · no position was recorded"}`,
        tone: finding.advisory ? "advisory" : "fail"
      });
    }
  }
  for (const transcript of views.transcripts) {
    const laneId = path.posix.dirname(transcript.path);
    const located = transcript.entries.filter(({ visualBounds }) => visualBounds);
    if (located.length === 0) continue;
    const first = report.actions.find(
      (action) => action.laneId === laneId && action.actionId === readerActionId(located[0]!)
    );
    if (!first) continue;
    const state = stateFor(
      actionArtifactPath(report, first, "full-page-screenshot", "after"),
      pageStateLabel(first.driver, first.actionId),
      transcript.pageUrl
    );
    for (const entry of located) {
      state.layers.reader.push({
        id: "",
        badge: String(entry.sequence),
        box: entry.visualBounds!,
        title: `“${entry.announcement}”`,
        detail: [entry.role, entry.name].filter(Boolean).join(" · "),
        tone: "neutral",
        ...(entry.role && announcedWithoutName({ role: entry.role, name: entry.name })
          ? { flag: "No name" }
          : {})
      });
    }
  }
  for (const sweep of views.sweeps) {
    const document = sweep.document;
    if (!document) continue;
    const state = stateFor(
      sweep.screenshotPath,
      pageStateLabel("keyboard-pointer-sweep", document.laneId),
      document.targetUrl
    );
    addSweepLayers(state, sweep.path, document);
  }
  // Headings and images join the page state taken at the same moment. A run with no other state
  // still shows its first page this way.
  const withMaps = views.elementMaps.filter(({ screenshotPath }) => screenshotPath);
  const firstMap = withMaps[0];
  if (firstMap && !withMaps.some(({ screenshotPath }) => states.has(screenshotPath!))) {
    const action = report.actions.find(({ runId }) => runId === firstMap.runId);
    stateFor(
      firstMap.screenshotPath,
      action ? pageStateLabel(action.driver, action.actionId) : "Page",
      action?.pageUrl
    );
  }
  for (const view of withMaps) {
    const state = states.get(view.screenshotPath!);
    if (!state || state.layers.headings.length || state.layers.images.length) continue;
    if (view.readError) state.elementMapError = view.readError;
    else addElementMapLayers(state, view.map!);
  }
  return [...states.values()].map((state, stateIndex) => {
    // Issues are numbered in reading order down the page, the order a person scans the picture in.
    state.layers.issues
      .sort(
        (a, b) =>
          (a.box?.y ?? Infinity) - (b.box?.y ?? Infinity) || (a.box?.x ?? 0) - (b.box?.x ?? 0)
      )
      .forEach((marker, index) => (marker.badge = String(index + 1)));
    for (const layer of PAGE_LAYERS) {
      state.layers[layer.id].forEach(
        (marker, index) => (marker.id = `page-${stateIndex}-${layer.id}-${index + 1}`)
      );
    }
    return state;
  });
}

/**
 * Headings, indented by level and flagged where empty or where a level is skipped, and images,
 * flagged where they have no text alternative.
 */
function addElementMapLayers(state: PageState, map: ElementMap): void {
  let previousLevel = 0;
  let imageNumber = 0;
  for (const element of map.elements) {
    if (element.kind === "heading") {
      const level = element.level ?? 2;
      const flag = !element.name
        ? "Empty heading"
        : previousLevel && level > previousLevel + 1
          ? `Skips from H${previousLevel} to H${level}`
          : undefined;
      previousLevel = level;
      state.layers.headings.push({
        id: "",
        badge: `H${level}`,
        box: element.box,
        title: element.name || "No text",
        detail: `Level ${level}`,
        tone: flag ? "fail" : "neutral",
        depth: level - 1,
        ...(flag ? { flag } : {})
      });
    } else {
      imageNumber += 1;
      state.layers.images.push({
        id: "",
        badge: String(imageNumber),
        box: element.box,
        title:
          element.alt === "text"
            ? element.name
            : element.alt === "decorative"
              ? "Decorative: screen readers skip it"
              : "No text alternative",
        detail: element.selector,
        tone: element.alt === "missing" ? "fail" : "neutral",
        ...(element.alt === "missing" ? { flag: "No alt" } : {})
      });
    }
  }
}

/**
 * The Tab stops in the order Tab reached them, each with the keyboard problems the sweep found on
 * it, then the ones found where Tab never goes; and each stop's focus, as a close-up.
 */
function addSweepLayers(
  state: PageState,
  sweepPath: string,
  document: KeyboardPointerSweepLaneDocument
): void {
  const keyboardFindings = (document.findings ?? []).filter(
    ({ kind }) => SWEEP_FINDING_TEXT[kind].area === "keyboard"
  );
  const stops = document.tabStops ?? [];
  const role = (value?: string) => value?.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  stops.forEach((stop, index) => {
    const found = keyboardFindings.filter(({ selector }) => selector === stop.selector);
    const flags = [
      ...(stop.label ? [] : ["No name"]),
      ...found.map(({ kind }) => SWEEP_FINDING_TEXT[kind].title)
    ];
    const common = {
      id: "",
      badge: String(index + 1),
      ...(stop.targetBox ? { box: stop.targetBox } : {}),
      title: stop.label || stop.selector
    };
    state.layers["tab-order"].push({
      ...common,
      detail: [role(stop.role), ...found.map(({ summary }) => summary)].filter(Boolean).join(" · "),
      tone: found.length ? "fail" : "neutral",
      ...(flags.length ? { flag: flags.join(" · ") } : {})
    });
    state.layers.focus.push({
      ...common,
      detail:
        stop.focusVisible === undefined
          ? "Not measured"
          : stop.focusVisible
            ? "Focus visible"
            : "Looks the same with and without focus",
      tone: stop.focusVisible === false ? "fail" : "neutral",
      ...(stop.focusVisible === false ? { flag: "No visible focus" } : {}),
      ...(stop.focusCrop
        ? { image: path.posix.join(path.posix.dirname(sweepPath), stop.focusCrop) }
        : {})
    });
  });
  for (const finding of keyboardFindings) {
    if (stops.some(({ selector }) => selector === finding.selector)) continue;
    state.layers["tab-order"].push({
      id: "",
      badge: "!",
      ...(finding.targetBox ? { box: finding.targetBox } : {}),
      title: finding.label || finding.selector,
      detail: finding.summary,
      tone: "fail",
      flag: SWEEP_FINDING_TEXT[finding.kind].title,
      apart: true
    });
  }
}

function pageStateLabel(driver: LaneDriver, actionId: string): string {
  return driver === "keyboard-pointer-sweep"
    ? "As the keyboard and pointer sweep found it"
    : driver === "portable-virtual-screen-reader"
      ? "As the virtual screen reader read it"
      : `${humanDriverName(driver)}: ${humanActionName(actionId).toLowerCase()}`;
}

/**
 * The Page view: the page as tested with each layer drawn where it was measured. The lists carry
 * everything and the picture mirrors them, so the view works by keyboard, by screen reader and
 * with no screenshot at all. The picture stays in view beside the lists, or above them on a
 * phone, at a readable scale, and moves to the item selected.
 */
function renderPageView(report: ScenarioIntegratedReport, views: IntegratedHtmlViews): string {
  const size = (state: PageState, shown?: boolean) =>
    PAGE_LAYERS.filter(({ on }) => shown === undefined || on === shown).reduce(
      (total, { id }) => total + state.layers[id].length,
      0
    );
  // What shows before any layer is switched on comes first: usually the page as it loaded.
  const states = buildPageStates(report, views)
    .filter((state) => size(state) > 0 || state.elementMapError)
    .sort((a, b) => size(b, true) - size(a, true) || size(b) - size(a));
  if (states.length === 0) {
    return '<p class="empty">Nothing was located on the page: no finding, announcement, heading, image or Tab stop recorded a position.</p>';
  }
  const layers = PAGE_LAYERS.filter(({ id }) => states.some((state) => state.layers[id].length));
  const toggles = `<fieldset class="layer-toggles"><legend>Show on the page</legend>${layers
    .map(
      ({ id, label, on }) =>
        `<label><input type="checkbox" data-layer-toggle="${id}"${on ? " checked" : ""}> ${escapeHtml(label)}</label>`
    )
    .join("")}</fieldset>`;
  // An item is a button that outlines its element; one with no recorded position on a page with a
  // picture has nothing to outline, so it is plain text.
  const markerButton = (marker: PageMarker, drawable: boolean) => {
    const content = `<span class="marker-number ${marker.tone}" aria-hidden="true">${escapeHtml(marker.badge)}</span><span><b>${escapeHtml(marker.title)}</b>${marker.flag ? ` <span class="marker-flag">${escapeHtml(marker.flag)}</span>` : ""}<small>${escapeHtml(marker.detail)}</small>${marker.image ? `<img class="focus-crop" src="${escapeAttribute(encodeURI(marker.image))}" alt="" loading="lazy">` : ""}</span>`;
    const indent = marker.depth ? ` style="--depth:${marker.depth}"` : "";
    return drawable && !marker.box
      ? `<li class="marker-unplaced"${indent}>${content}</li>`
      : `<li${indent}><button type="button" class="marker-item"${drawable ? ` data-marker="${marker.id}"` : ""}>${content}</button></li>`;
  };
  const shape = (marker: PageMarker, side: "left" | "right") => {
    const { x, y, width, height } = marker.box!;
    const rect = `x="${(x - 4).toFixed(1)}" y="${(y - 4).toFixed(1)}" width="${(width + 8).toFixed(1)}" height="${(Math.max(height, 2) + 8).toFixed(1)}"`;
    const badgeWidth = Math.max(32, 14 + marker.badge.length * 11);
    const badgeX = side === "right" ? x + width + 6 : x - badgeWidth + 16;
    return `<g class="page-marker ${marker.tone}" data-marker-shape="${marker.id}"><rect class="halo" ${rect}/><rect class="outline" ${rect}/><g transform="translate(${badgeX.toFixed(1)} ${(y - 16).toFixed(1)})"><rect class="badge" width="${badgeWidth}" height="28" rx="${side === "right" ? 4 : 14}"/><text x="${badgeWidth / 2}" y="20">${escapeHtml(marker.badge)}</text></g></g>`;
  };
  const sections = states
    .map((state) => {
      const drawable = Boolean(state.screenshot && state.width && state.height);
      const lists = PAGE_LAYERS.filter(({ id }) => state.layers[id].length)
        .map(({ id, heading, scope, apartHeading }) => {
          const markers = state.layers[id];
          const numbered = markers.filter(({ apart }) => !apart);
          const apart = markers.filter(({ apart }) => apart);
          const list = (items: PageMarker[], tag: "ol" | "ul") =>
            `<${tag} class="marker-list">${items.map((marker) => markerButton(marker, drawable)).join("")}</${tag}>`;
          const stepper =
            id === "reader"
              ? `<p class="marker-nav"><button type="button" data-reader-step="-1">Previous</button><span data-reader-count aria-live="polite">${markers.length} announcements</span><button type="button" data-reader-step="1">Next</button></p>`
              : "";
          return `<section data-layer="${id}"${id === "reader" ? " data-reader-list" : ""}><h4>${escapeHtml(heading)} (${numbered.length})</h4>${stepper}${numbered.length ? list(numbered, "ol") : ""}${apart.length ? `<h5>${escapeHtml(apartHeading ?? heading)} (${apart.length})</h5>${list(apart, "ul")}` : ""}${scope ? `<p class="marker-scope">${escapeHtml(scope)}</p>` : ""}</section>`;
        })
        .join("");
      const mapError = state.elementMapError
        ? `<p class="empty">Headings and images could not be read: ${escapeHtml(state.elementMapError)}</p>`
        : "";
      const drawn = PAGE_LAYERS.map(
        ({ id, badgeSide }) =>
          `<g data-layer="${id}">${state.layers[id]
            .filter(({ box }) => box)
            .map((marker) => shape(marker, badgeSide))
            .join("")}</g>`
      ).join("");
      const counted = PAGE_LAYERS.map(({ id, noun }) => {
        const count = state.layers[id].filter(({ box }) => box).length;
        return count ? `${count} ${noun}${count === 1 ? "" : "s"}` : "";
      })
        .filter(Boolean)
        .join(", ");
      const picture = drawable
        ? `<div class="page-canvas" tabindex="0" role="group" aria-label="${escapeAttribute(state.label)}: the page as tested, scrollable" style="--page-width:${state.width}px"><svg viewBox="0 0 ${state.width} ${state.height}" role="img" aria-label="${escapeAttribute(`Page as tested, with markers for ${counted}; the lists name each one`)}"><g aria-hidden="true"><image href="${escapeAttribute(encodeURI(state.screenshot!))}" width="${state.width}" height="${state.height}" preserveAspectRatio="none"/>${drawn}</g></svg></div>`
        : '<p class="empty">No screenshot was captured for this page state, so only the lists are shown.</p>';
      return `<section class="page-state"><h3>${escapeHtml(state.label)}</h3>${state.pageUrl ? `<p class="technical-id">${escapeHtml(state.pageUrl)}</p>` : ""}<div class="page-view">${picture}<div class="page-lists">${lists}${mapError}</div></div></section>`;
    })
    .join("");
  return `${toggles}${sections}`;
}

function renderReaderOverview(
  report: ScenarioIntegratedReport,
  views: IntegratedHtmlViews
): string {
  if (views.transcripts.length === 0) {
    return '<p class="empty">No virtual-reader transcript was requested.</p>';
  }
  return views.transcripts
    .map((transcript) => {
      const rows = transcript.entries
        .map((entry) => {
          const action = report.actions.find(
            (candidate) => candidate.actionId === readerActionId(entry)
          );
          const judgment = readerJudgment(views.actionReports, entry);
          const links = action ? renderActionEvidenceLinks(report, action) : "—";
          const bounds = entry.visualBounds
            ? `${entry.visualBounds.width} × ${entry.visualBounds.height} at ${entry.visualBounds.x}, ${entry.visualBounds.y}`
            : "Not recorded";
          return `<tr><th scope="row">${entry.sequence}. ${escapeHtml(entry.command)}</th><td><span class="reader-announcement">${escapeHtml(entry.announcement)}</span><div class="bounds">${escapeHtml(bounds)}</div></td><td>${entry.focusMoved ? "Moved — review" : "Stayed separate — correct"}<div class="technical-id">${escapeHtml(entry.focusBefore)} → ${escapeHtml(entry.focusAfter)}</div></td><td><span class="badge ${judgment?.verdict ?? "unknown"}">${escapeHtml(judgment?.verdict ?? "unknown")}</span><br>${escapeHtml(judgment?.summary ?? "No cross-evidence judgment was emitted.")}</td><td>${links}</td></tr>`;
        })
        .join("");
      const readerActions = report.actions.filter(
        ({ driver }) => driver === "portable-virtual-screen-reader"
      );
      const visuals = readerActions
        .map((action) => {
          const screenshot = actionArtifactPath(report, action, "viewport-screenshot", "after");
          return screenshot
            ? `<figure><a class="image-viewer-trigger" href="${encodeURI(screenshot)}" data-image-viewer data-view-title="${escapeAttribute(`Rendered page after ${humanActionName(action.actionId)}`)}"><img loading="lazy" src="${encodeURI(screenshot)}" alt="Rendered page after ${escapeAttribute(humanActionName(action.actionId))}"></a><figcaption>${escapeHtml(humanActionName(action.actionId))} · Click to enlarge · <a href="${encodeURI(screenshot)}">open complete page capture</a></figcaption></figure>`
            : "";
        })
        .join("");
      return `<article class="finding-dossier"><header><div><h3>Guide-mode navigation</h3><p>${escapeHtml(transcript.pageUrl)} · ${escapeHtml(transcript.fidelity.replaceAll("-", " "))}</p></div><span class="badge ${report.synthesis.reader.failed ? "fail" : report.synthesis.reader.unknown ? "unknown" : "pass"}">${report.synthesis.reader.passed}/${report.synthesis.reader.commands} passed</span></header>${transcript.readError ? `<p>${escapeHtml(transcript.readError)}</p>` : `<div class="table-wrap" tabindex="0"><table><caption>Announcements correlated with semantic, visual, and focus evidence</caption><thead><tr><th scope="col">Command</th><th scope="col">Virtual announcement and bounds</th><th scope="col">DOM focus</th><th scope="col">Cross-evidence result</th><th scope="col">Evidence</th></tr></thead><tbody>${rows}</tbody></table></div><h4>Rendered checkpoints</h4><div class="media-grid">${visuals}</div>`}<p class="evidence-links"><a href="${encodeURI(transcript.path)}">Open transcript JSON</a>${transcript.textPath ? ` <a href="${encodeURI(transcript.textPath)}">Open readable transcript</a>` : ""}</p></article>`;
    })
    .join("");
}

function renderAxeReportViews(views: AxeReportView[]): string {
  if (views.length === 0) return '<p class="empty">No Axe reports were produced.</p>';
  const consolidated = new Map<
    string,
    AxeRuleView & { reportCount: number; resultType: "violation" | "incomplete" }
  >();
  for (const view of views) {
    for (const [resultType, rules] of [
      ["violation", view.violations],
      ["incomplete", view.incomplete]
    ] as const) {
      for (const rule of rules) {
        const key = `${resultType}:${rule.id}`;
        const current = consolidated.get(key);
        consolidated.set(key, {
          ...rule,
          nodeCount: Math.max(current?.nodeCount ?? 0, rule.nodeCount),
          reportCount: (current?.reportCount ?? 0) + 1,
          resultType
        });
      }
    }
  }
  const consolidatedRows = [...consolidated.values()]
    .sort((left, right) =>
      `${left.resultType}:${left.id}`.localeCompare(`${right.resultType}:${right.id}`)
    )
    .map(
      (rule) =>
        `<tr><td><strong>${escapeHtml(rule.id)}</strong><br>${escapeHtml(rule.help)}</td><td><span class="badge ${rule.resultType === "violation" ? "fail" : "unknown"}">${escapeHtml(rule.resultType)}</span></td><td>${rule.reportCount} of ${views.length}</td><td>${rule.nodeCount}</td><td>${safeHttpUrl(rule.helpUrl) ? `<a href="${escapeAttribute(safeHttpUrl(rule.helpUrl)!)}">Rule guidance</a>` : "—"}</td></tr>`
    )
    .join("");
  const individualReports = views
    .map((view) => {
      const renderRules = (rules: AxeRuleView[], label: string) =>
        rules.length
          ? `<section><h4>${escapeHtml(label)}</h4>${rules.map(renderAxeRule).join("")}</section>`
          : `<p class="empty">No ${escapeHtml(label.toLowerCase())}.</p>`;
      return `<details class="result-card"><summary><span>${escapeHtml(humanActionName(view.actionId))}</span> <span class="badge ${view.violations.length ? "fail" : view.incomplete.length ? "unknown" : "pass"}">${view.violations.length} violations</span></summary><div class="technical-id">${escapeHtml(view.actionId)}</div>${view.readError ? `<p><strong>Axe JSON could not be summarized:</strong> ${escapeHtml(view.readError)}</p>` : `<p class="metrics"><span><strong>${view.violations.length}</strong> violations</span><span><strong>${view.incomplete.length}</strong> incomplete</span><span><strong>${view.passes}</strong> passed rules</span><span><strong>${view.inapplicable}</strong> not applicable</span></p>${renderRules(view.violations, "Violations")}${renderRules(view.incomplete, "Incomplete checks")}`}<p><a class="raw-link" href="${encodeURI(view.path)}">View raw Axe JSON</a></p></details>`;
    })
    .join("");
  return `<section class="panel"><h3>Unique rules across checkpoints</h3><p>Repeated page-level results are consolidated here. “Reports” shows how many after-action Axe runs contained the rule; “Nodes” is the largest affected-node count in one run.</p><div class="table-wrap" tabindex="0"><table><caption>Consolidated Axe rules</caption><thead><tr><th scope="col">Rule</th><th scope="col">Result</th><th scope="col">Reports</th><th scope="col">Nodes</th><th scope="col">Guidance</th></tr></thead><tbody>${consolidatedRows}</tbody></table></div></section><section aria-labelledby="individual-axe-heading"><h3 id="individual-axe-heading">Individual Axe reports</h3><p>Expand a checkpoint to review its full rule summary.</p>${individualReports}</section>`;
}

function renderAxeRule(rule: AxeRuleView): string {
  const visibleTargets = rule.targets.slice(0, 8);
  const remaining = Math.max(0, rule.targets.length - visibleTargets.length);
  const helpUrl = safeHttpUrl(rule.helpUrl);
  return `<article class="rule ${escapeAttribute(rule.impact)}"><div class="card-heading"><h5>${escapeHtml(rule.id)}</h5><span class="badge ${rule.impact === "critical" || rule.impact === "serious" ? "fail" : "unknown"}">${escapeHtml(rule.impact)}</span></div><p><strong>${escapeHtml(rule.help)}</strong></p><p>${escapeHtml(rule.description)}</p><p><strong>Affected nodes:</strong> ${rule.nodeCount}</p>${rule.failureSummary ? `<p><strong>How to resolve:</strong> ${escapeHtml(rule.failureSummary.replace(/^Fix any of the following:\s*/i, ""))}</p>` : ""}${visibleTargets.length ? `<details><summary>Show ${visibleTargets.length}${remaining ? ` of ${rule.targets.length}` : ""} affected selectors</summary><ul>${visibleTargets.map((target) => `<li><code>${escapeHtml(target)}</code></li>`).join("")}</ul>${remaining ? `<p>${remaining} more selectors are preserved in the raw Axe report.</p>` : ""}</details>` : ""}${helpUrl ? `<p><a href="${escapeAttribute(helpUrl)}">Open rule guidance</a></p>` : ""}</article>`;
}

function renderEvidenceGroups(artifacts: Array<Record<string, unknown>>): string {
  const groups = new Map<string, Array<Record<string, unknown>>>();
  for (const artifact of artifacts) {
    const kind = stringField(artifact, "kind", "other");
    const group = groups.get(kind) ?? [];
    group.push(artifact);
    groups.set(kind, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => artifactKindLabel(left).localeCompare(artifactKindLabel(right)))
    .map(
      ([kind, entries]) =>
        `<section class="panel"><h3>${escapeHtml(artifactKindLabel(kind))} <span class="badge">${entries.length}</span></h3><p>${escapeHtml(artifactKindDescription(kind))}</p><details><summary>Show ${entries.length} file${entries.length === 1 ? "" : "s"}</summary><ul class="file-list">${entries
          .map((artifact) => {
            const artifactPath = stringField(artifact, "path", "");
            const phase = optionalStringField(artifact, "phase");
            return `<li><a href="${encodeURI(artifactPath)}">${escapeHtml(humanFileName(artifactPath))}</a>${phase ? ` — ${escapeHtml(phase)}` : ""} <span class="badge ${artifact.status === "available" ? "pass" : "unknown"}">${escapeHtml(String(artifact.status ?? "indexed"))}</span></li>`;
          })
          .join("")}</ul></details></section>`
    )
    .join("");
}

function artifactLabel(artifact: Record<string, unknown>, fallback: string): string {
  const provenance = isRecord(artifact.provenance) ? artifact.provenance : {};
  return stringField(provenance, "actionId", stringField(provenance, "laneId", fallback));
}

function humanFileName(filePath: string): string {
  return path.posix
    .basename(filePath)
    .replaceAll("-", " ")
    .replace(/\.[^.]+$/, "");
}

/** What the report is called: the scenario's own name, or its id in words. */
function reportName(report: ScenarioIntegratedReport): string {
  return report.name ?? humanActionName(report.scenarioId);
}

function humanActionName(actionId: string): string {
  const words = actionId.replace(/^(command|checkpoint)-\d+-/, "").replaceAll("-", " ");
  return words.length > 0 ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Action";
}

function humanDriverName(driver: LaneDriver): string {
  if (driver === "portable-virtual-screen-reader") return "Portable virtual screen reader";
  if (driver === "keyboard-pointer-sweep") return "Keyboard and pointer sweep";
  if (driver === "playwright-test") return "Playwright test";
  return driver === "keyboard" ? "Keyboard" : "Pointer";
}

function behaviorLabelForDriver(driver: LaneDriver): string {
  if (driver === "portable-virtual-screen-reader") return "Reader semantic agreement";
  if (driver === "keyboard-pointer-sweep") return "Keyboard and pointer sweep";
  if (driver === "playwright-test") return "Page checkpoint";
  return "Focus management";
}

function artifactKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    "accessibility-tree": "Accessibility trees",
    "axe-result": "Axe results",
    "dom-snapshot": "DOM snapshots",
    "element-map": "Element maps",
    "evidence-bundle": "Evidence bundles",
    "focus-crop": "Focus close-ups",
    "focus-state": "Focus states",
    "full-page-screenshot": "Full-page screenshots",
    "interaction-trace": "Interaction traces",
    "interaction-video": "Interaction videos",
    "json-report": "Action JSON reports",
    "lane-metadata": "Lane metadata",
    "markdown-report": "Action Markdown reports",
    "run-metadata": "Run metadata",
    "screen-reader-transcript": "Screen-reader transcripts",
    "video-captions": "Video descriptions",
    "video-sidecar": "Video timelines",
    "viewport-screenshot": "Viewport screenshots"
  };
  return labels[kind] ?? kind.replaceAll("-", " ");
}

function artifactKindDescription(kind: string): string {
  const descriptions: Record<string, string> = {
    "accessibility-tree": "Machine-readable accessibility roles, names, states, and relationships.",
    "axe-result": "Complete Axe output; use the Axe tab for a readable summary.",
    "dom-snapshot": "Full HTML captured at the interaction checkpoint.",
    "element-map":
      "Headings and images with their accessibility-tree roles, names and levels, and their boxes on the page.",
    "evidence-bundle": "Correlated records, artifacts, interactions, and judgments for one action.",
    "focus-crop": "Each Tab stop with keyboard focus, as the keyboard sweep reached it.",
    "focus-state": "Deep active element, focus chain, focus-visible styles, and composite context.",
    "full-page-screenshot": "Rendered page context captured after or before an action.",
    "interaction-trace": "The declared pointer and keyboard action sequence and outcomes.",
    "interaction-video": "A recording of an isolated active interaction lane.",
    "json-report": "Canonical machine-readable judgment report for one action.",
    "screen-reader-transcript":
      "Portable virtual-reader commands, speech text, targets, and focus separation.",
    "video-captions": "WebVTT descriptions for the action recording.",
    "video-sidecar": "Machine-readable action timing and recording metadata."
  };
  return (
    descriptions[kind] ?? "Supporting evidence retained for traceability and independent review."
  );
}

function reportSupplementalFiles(reportFiles: ReportFiles, planFile: string) {
  return [
    { path: reportFiles.html, kind: "html-report" as const, phase: "assessment" as const },
    { path: reportFiles.json, kind: "json-report" as const, phase: "assessment" as const },
    { path: reportFiles.markdown, kind: "markdown-report" as const, phase: "assessment" as const },
    { path: reportFiles.prComment, kind: "markdown-report" as const, phase: "assessment" as const },
    { path: planFile, kind: "custom" as const, phase: "assessment" as const },
    {
      path: path.join(path.dirname(reportFiles.html), "aee-report-display.woff2"),
      kind: "custom" as const,
      phase: "assessment" as const
    }
  ];
}

function relativePath(rootDir: string, filePath: string): string {
  const relative = path.relative(path.resolve(rootDir), path.resolve(filePath));
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Scenario artifact must stay inside ${path.resolve(rootDir)}.`);
  }
  return relative.split(path.sep).join("/");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}

function describeExecutionError(scope: string, error: unknown): string {
  return `${scope}: ${error instanceof Error ? error.message : String(error)}`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

function escapeMarkdown(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function markdownEvidenceLink(value: string | undefined): string {
  return value ? `[open](${encodeURI(value)})` : "—";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalStringField(value: Record<string, unknown>, field: string): string | undefined {
  return typeof value[field] === "string" ? value[field] : undefined;
}

function stringField(value: Record<string, unknown>, field: string, fallback: string): string {
  return optionalStringField(value, field) ?? fallback;
}

function numberField(value: Record<string, unknown>, field: string, fallback = 0): number {
  return typeof value[field] === "number" ? value[field] : fallback;
}

function optionalNumberField(value: Record<string, unknown>, field: string): number | undefined {
  return typeof value[field] === "number" ? value[field] : undefined;
}

function verdictField(value: unknown): "pass" | "fail" | "unknown" {
  return value === "pass" || value === "fail" || value === "unknown" ? value : "unknown";
}

function safeHttpUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}
