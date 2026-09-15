import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  aggregateEvidenceManifests,
  runInputComparison,
  runVirtualScreenReaderLane,
  type EvidenceManifest,
  type InputComparisonResult,
  type InteractionComparisonBrowser,
  type VirtualScreenReaderLaneBrowser,
  type VirtualScreenReaderLaneResult
} from "@aee/playwright";
import { assertValidSchema, CURRENT_SCHEMA_VERSION } from "@aee/schemas";
import { chromium, type Browser, type Page } from "playwright";

import { compileScenarioPlan, loadScenario, type AeeScenario, type ScenarioPlan } from "./scenario";

export interface ExecuteScenarioOptions {
  outputDir?: string;
  browser?: Browser;
}

export interface ScenarioActionReport {
  journeyId: string;
  laneId: string;
  driver: "pointer" | "keyboard" | "portable-virtual-screen-reader";
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
  scenarioDigest: string;
  planDigest: string;
  profile: "core" | "at-fidelity";
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
  };
  summary: {
    actions: number;
    passed: number;
    failed: number;
    unknown: number;
    findings: number;
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
    manifest: string;
    plan: string;
  };
  privacy: {
    classification: "sensitive";
    reviewedForSharing: false;
    remoteUploadAuthorized: false;
  };
  ai: { present: false; label: string };
}

export interface ExecuteScenarioResult {
  assessmentId: string;
  outputDir: string;
  verdict: ScenarioIntegratedReport["verdict"];
  completeness: ScenarioIntegratedReport["completeness"]["status"];
  reportFiles: { html: string; json: string; markdown: string };
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

interface FindingCheckpointSynthesis {
  actionId: string;
  laneId: string;
  runId: string;
  driver: ScenarioActionReport["driver"];
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
}

interface FindingSynthesis {
  ruleId: string;
  title: string;
  severity: string;
  wcagCriteria: string[];
  conclusion: string;
  occurrenceCount: number;
  checkpointCount: number;
  maximumAffectedNodes: number;
  checkpoints: FindingCheckpointSynthesis[];
  remediation: {
    deterministic: string;
    ai: { used: false; status: "not-applicable" | "available-if-needed"; reason: string };
    verification: string[];
  };
}

export interface ScenarioSynthesis {
  conclusion: string;
  directJudgments: { passed: number; failed: number; unknown: number };
  releaseGates: { passed: number; failed: number; unknown: number };
  findingOccurrences: number;
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
  findings: FindingSynthesis[];
}

interface IntegratedHtmlViews {
  transcripts: ReaderTranscriptView[];
  actionReports: ActionReportView[];
  axeReports: AxeReportView[];
  comparisons: InputComparisonView[];
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
  if (plannedLanes === 0) {
    throw new Error(
      `Scenario “${scenario.id}” has no executable virtual-reader commands or pointer/keyboard comparisons.`
    );
  }

  const assessmentId = `${scenario.id}-${Date.now()}`;
  const assessmentDir = path.resolve(options.outputDir ?? "aee-output", assessmentId);
  const planFile = path.join(assessmentDir, "scenario-plan.json");
  const manifestFile = path.join(assessmentDir, "manifest.json");
  const reportFiles = {
    html: path.join(assessmentDir, "aee-report.html"),
    json: path.join(assessmentDir, "aee-report.json"),
    markdown: path.join(assessmentDir, "aee-report.md")
  };
  const startedAt = new Date().toISOString();
  const childManifestFiles: string[] = [];
  const actions: ScenarioActionReport[] = [];
  const findings: Array<Record<string, unknown>> = [];
  const diagnostics: string[] = [];
  await mkdir(assessmentDir, { recursive: true });
  await writeFile(planFile, JSON.stringify(plan, null, 2), "utf8");

  const browser = options.browser ?? (await chromium.launch({ headless: true }));
  const ownsBrowser = !options.browser;
  try {
    for (const journey of scenario.journeys) {
      const startUrl = new URL(journey.startPath ?? "/", scenario.target.url).href;
      const allowedOrigins = plan.safety.allowedOrigins;
      if (journey.virtualScreenReaderCommands?.length) {
        const laneId = `${journey.id}-virtual-reader`;
        const expectedManifest = path.join(assessmentDir, laneId, "manifest.json");
        try {
          const lane = await runVirtualScreenReaderLane({
            browser: browser as unknown as VirtualScreenReaderLaneBrowser<Page>,
            projectRoot: process.cwd(),
            outputDir: assessmentDir,
            laneId,
            targetUrl: startUrl,
            allowedOrigins,
            commands: journey.virtualScreenReaderCommands
          });
          childManifestFiles.push(lane.manifestFile!);
          await collectVirtualReaderActions(assessmentDir, journey.id, lane, actions, findings);
        } catch (error) {
          diagnostics.push(describeExecutionError(laneId, error));
          if (await fileExists(expectedManifest)) childManifestFiles.push(expectedManifest);
        }
      }

      for (const comparison of journey.interactionComparisons ?? []) {
        const comparisonId = `${journey.id}-${comparison.id}`;
        const expectedManifest = path.join(assessmentDir, comparisonId, "manifest.json");
        try {
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
          childManifestFiles.push(result.manifestFile);
          await collectInputActions(assessmentDir, journey.id, result, actions, findings);
        } catch (error) {
          diagnostics.push(describeExecutionError(comparisonId, error));
          if (await fileExists(expectedManifest)) childManifestFiles.push(expectedManifest);
        }
      }
    }
  } finally {
    if (ownsBrowser) await browser.close();
  }

  const childEvidence = await loadChildEvidence(assessmentDir, childManifestFiles);
  const consolidatedFindings = deduplicateFindings(findings);
  const report = createIntegratedReport({
    assessmentId,
    scenario,
    plan,
    startedAt,
    finishedAt: new Date().toISOString(),
    plannedLanes,
    actions,
    findings: consolidatedFindings,
    artifacts: childEvidence.artifacts,
    completedLanes: childEvidence.completedLanes,
    missingArtifacts: childEvidence.missingArtifacts,
    failedArtifacts: childEvidence.failedArtifacts,
    diagnostics,
    assessmentDir,
    reportFiles,
    manifestFile,
    planFile
  });
  await writeIntegratedReport(report, reportFiles, assessmentDir);
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
  await writeIntegratedReport(report, reportFiles, assessmentDir);
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

function countPlannedLanes(scenario: AeeScenario): number {
  return scenario.journeys.reduce(
    (count, journey) =>
      count +
      (journey.virtualScreenReaderCommands?.length ? 1 : 0) +
      (journey.interactionComparisons?.length ?? 0) * 2,
    0
  );
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
  reportFiles: { html: string; json: string; markdown: string };
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
  const verdict = failed > 0 ? "fail" : !complete || unknown > 0 ? "unknown" : "pass";
  const report: ScenarioIntegratedReport = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    assessmentId: input.assessmentId,
    scenarioId: input.scenario.id,
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
      failedArtifacts: input.failedArtifacts
    },
    summary: {
      actions: input.actions.length,
      passed,
      failed,
      unknown,
      findings: input.findings.length,
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

function emptyScenarioSynthesis(): ScenarioSynthesis {
  return {
    conclusion: "Synthesis is generated from the completed evidence set.",
    directJudgments: { passed: 0, failed: 0, unknown: 0 },
    releaseGates: { passed: 0, failed: 0, unknown: 0 },
    findingOccurrences: 0,
    incompleteRuleResults: 0,
    uniqueIncompleteRules: [],
    lanes: [],
    comparisons: [],
    reader: { commands: 0, passed: 0, failed: 0, unknown: 0 },
    findings: []
  };
}

async function writeIntegratedReport(
  report: ScenarioIntegratedReport,
  files: { html: string; json: string; markdown: string },
  rootDir: string
): Promise<void> {
  const [transcripts, actionReports, axeReports, comparisons] = await Promise.all([
    loadReaderTranscriptViews(report, rootDir),
    loadActionReportViews(report, rootDir),
    loadAxeReportViews(report, rootDir),
    loadInputComparisonViews(report, rootDir)
  ]);
  const views = { transcripts, actionReports, axeReports, comparisons };
  report.synthesis = buildScenarioSynthesis(report, views);
  assertValidSchema("scenarioReport", report, "integrated scenario report");
  await Promise.all([
    writeFile(files.json, JSON.stringify(report, null, 2), "utf8"),
    writeFile(files.markdown, renderIntegratedMarkdown(report), "utf8"),
    writeFile(files.html, renderIntegratedHtml(report, views), "utf8")
  ]);
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
    const nodes = Array.isArray(rule.nodes) ? rule.nodes.filter(isRecord) : [];
    const targets = nodes.flatMap((node) =>
      Array.isArray(node.target) ? node.target.map(String) : []
    );
    const htmlSamples = nodes
      .map((node) => optionalStringField(node, "html"))
      .filter((sample): sample is string => Boolean(sample));
    const failureSummaries = [
      ...new Set(
        nodes
          .map((node) => optionalStringField(node, "failureSummary"))
          .filter((summary): summary is string => Boolean(summary))
      )
    ];
    return {
      id: stringField(rule, "id", "unknown-rule"),
      impact: optionalStringField(rule, "impact") ?? "review",
      help: stringField(rule, "help", "No help text was provided."),
      description: stringField(rule, "description", "No description was provided."),
      helpUrl: optionalStringField(rule, "helpUrl"),
      nodeCount: nodes.length,
      targets,
      htmlSamples,
      tags: Array.isArray(rule.tags) ? rule.tags.map(String) : [],
      failureSummary:
        nodes.length > 0 ? optionalStringField(nodes[0]!, "failureSummary") : undefined,
      failureSummaries
    };
  });
}

function buildScenarioSynthesis(
  report: ScenarioIntegratedReport,
  views: IntegratedHtmlViews
): ScenarioSynthesis {
  const direct = views.actionReports.flatMap(({ judgments }) =>
    judgments.filter(({ judgeId }) => judgeId !== "release")
  );
  const directJudgments = countVerdicts(direct.map(({ verdict }) => verdict));
  const incompleteRules = views.axeReports.flatMap(({ incomplete }) => incomplete);
  const uniqueIncompleteRules = [...new Set(incompleteRules.map(({ id }) => id))].sort();
  const findingOccurrences = report.findings.reduce((count, finding) => {
    return count + (Array.isArray(finding.occurrences) ? finding.occurrences.length : 0);
  }, 0);
  const readerJudgments = views.actionReports.flatMap(({ judgments }) =>
    judgments.filter(({ judgeId }) => judgeId === "screen-reader")
  );
  const readerCounts = countVerdicts(readerJudgments.map(({ verdict }) => verdict));
  const lanes = (["keyboard", "pointer", "portable-virtual-screen-reader"] as const)
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
  const findings = report.findings.map((finding) => buildFindingSynthesis(report, views, finding));
  const passedComparisons = views.comparisons.filter(
    ({ equivalence, expectation }) =>
      equivalence.verdict === "pass" && expectation.verdict === "pass"
  ).length;
  const positive = [
    readerJudgments.length
      ? `${readerCounts.passed} of ${readerJudgments.length} virtual-reader commands passed cross-evidence validation`
      : undefined,
    views.comparisons.length
      ? `${passedComparisons} of ${views.comparisons.length} pointer/keyboard comparisons matched both equivalence and the expected outcome`
      : undefined
  ].filter((item): item is string => Boolean(item));
  const negative = findings.length
    ? `${findings.length} unique confirmed issue${findings.length === 1 ? "" : "s"} produced ${findingOccurrences} finding occurrence${findingOccurrences === 1 ? "" : "s"} across ${report.actions.length} action checkpoint${report.actions.length === 1 ? "" : "s"}`
    : "no confirmed issues were emitted";
  const unresolved = uniqueIncompleteRules.length
    ? ` ${uniqueIncompleteRules.length} distinct Axe rule${uniqueIncompleteRules.length === 1 ? " remains" : "s remain"} unresolved and require review.`
    : "";
  return {
    conclusion: `${positive.length ? `${positive.join("; ")}. ` : ""}Within the user-authored scope, ${negative}.${unresolved}`,
    directJudgments,
    releaseGates: {
      passed: report.summary.passed,
      failed: report.summary.failed,
      unknown: report.summary.unknown
    },
    findingOccurrences,
    incompleteRuleResults: incompleteRules.length,
    uniqueIncompleteRules,
    lanes,
    comparisons: views.comparisons,
    reader: { commands: readerJudgments.length, ...readerCounts },
    findings
  };
}

/** Pure synthesis entry point used to verify cross-evidence reporting without launching a browser. */
export function buildScenarioSynthesisForTest(
  report: ScenarioIntegratedReport,
  views: unknown
): ScenarioSynthesis {
  return buildScenarioSynthesis(report, views as IntegratedHtmlViews);
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
  return `${label} ran ${reports.length} authored action${reports.length === 1 ? "" : "s"}: ${counts.passed} direct checks passed, ${counts.failed} failed, and ${counts.unknown} were unresolved.${failingJudges.length ? ` Failing judges: ${failingJudges.join(", ")}.` : ""}`;
}

function buildFindingSynthesis(
  report: ScenarioIntegratedReport,
  views: IntegratedHtmlViews,
  finding: Record<string, unknown>
): FindingSynthesis {
  const ruleId = String(finding.ruleId ?? finding.id ?? "unknown-finding");
  const matchingReports = views.axeReports
    .map((axeReport) => ({
      axeReport,
      rule: axeReport.violations.find(({ id }) => id === ruleId)
    }))
    .filter((entry): entry is { axeReport: AxeReportView; rule: AxeRuleView } =>
      Boolean(entry.rule)
    );
  const allRules = matchingReports.map(({ rule }) => rule);
  const representative = allRules[0];
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
  const remediation = findingRemediation(ruleId, representative);
  return {
    ruleId,
    title: representative?.help ?? String(finding.message ?? ruleId),
    severity: String(finding.severity ?? representative?.impact ?? "review"),
    wcagCriteria,
    conclusion: `${representative?.description ?? String(finding.message ?? "A confirmed issue was emitted.")} The same rule was observed at ${checkpoints.length} of ${views.axeReports.length} after-action checkpoints; the largest checkpoint affected ${maximumAffectedNodes} node${maximumAffectedNodes === 1 ? "" : "s"}. Independent behavior results remain shown separately and do not cancel this rule failure.`,
    occurrenceCount,
    checkpointCount: checkpoints.length,
    maximumAffectedNodes,
    checkpoints,
    remediation
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

function driverFromLaneId(laneId: string): ScenarioActionReport["driver"] {
  if (laneId.endsWith("-keyboard")) return "keyboard";
  if (laneId.endsWith("-pointer")) return "pointer";
  return "portable-virtual-screen-reader";
}

function wcagCriterionFromTag(tag: string): string | undefined {
  const match = /^wcag(\d)(\d)(\d+)$/.exec(tag);
  return match ? `WCAG ${match[1]}.${match[2]}.${match[3]}` : undefined;
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
        'For ordinary footer navigation, remove role="menuitem" and keep native link semantics. If these controls intentionally form an application-style menu, place each menuitem inside an element with role="menu", role="menubar", or role="group" and implement the complete keyboard pattern. ' +
        (measured ?? "Rerun the ARIA parent relationship check after changing the structure."),
      ai: {
        used: false,
        status: "not-applicable",
        reason:
          "The required parent-role relationship is deterministic. A language or vision model should not choose whether invalid ARIA passes."
      },
      verification: [
        "Rerun axe at the same five checkpoints and require aria-required-parent to pass.",
        "Confirm the footer remains navigable with Tab and that link names and destinations are unchanged.",
        "Confirm DOM roles match the accessibility tree after the fix."
      ]
    };
  }
  if (ruleId === "color-contrast") {
    return {
      deterministic:
        (measured ? `${measured} ` : "") +
        "Choose a brand-approved foreground/background token pair that computes to at least 4.5:1 for this normal-sized text, then verify every applicable default, hover, focus, and active state.",
      ai: {
        used: false,
        status: "available-if-needed",
        reason:
          "A visual specialist may locate complex foreground/background regions or explain brand intent when deterministic extraction is inconclusive. The final contrast ratio and token selection must still be calculated deterministically."
      },
      verification: [
        "Recompute the exact contrast ratio from final rendered colors and require at least 4.5:1.",
        "Compare the corrected state with the full-page visual and DOM computed styles.",
        "Rerun the same keyboard, pointer, and virtual-reader checkpoints."
      ]
    };
  }
  return {
    deterministic:
      measured ??
      "Apply the rule guidance to the affected nodes, then rerun the same authored journey.",
    ai: {
      used: false,
      status: "not-applicable",
      reason:
        "No allowlisted contextual AI task is defined for this finding; deterministic evidence remains authoritative."
    },
    verification: [
      "Rerun the same action and require the rule to pass.",
      "Confirm DOM, accessibility tree, focus, visual, and screen-reader evidence still agree."
    ]
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
    `# Accessibility evidence report: ${report.scenarioId}`,
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
    `- ${report.summary.findings} unique findings across ${report.synthesis.findingOccurrences} checkpoint occurrences`,
    `- ${report.synthesis.uniqueIncompleteRules.length} unique incomplete Axe rules across ${report.synthesis.incompleteRuleResults} checkpoint results`,
    `- ${report.summary.artifacts} indexed artifacts`,
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
      `### ${escapeMarkdown(finding.ruleId)} — ${escapeMarkdown(finding.title)}`,
      "",
      finding.conclusion,
      "",
      `**WCAG:** ${finding.wcagCriteria.length ? finding.wcagCriteria.join(", ") : "Mapping not emitted"}`,
      "",
      `**Deterministic remediation:** ${finding.remediation.deterministic}`,
      "",
      `**AI:** Not used — ${finding.remediation.ai.reason}`,
      "",
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
    ["overview", "Overview"],
    ["findings", `Findings (${report.summary.findings})`],
    ["keyboard", "Keyboard"],
    ["reader", "Screen reader"],
    ["axe", `Axe (${views.axeReports.length})`],
    ["media", `Media (${videos.length + screenshots.length})`],
    ["evidence", `Evidence files (${report.summary.artifacts})`]
  ] as const;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accessibility evidence report: ${escapeHtml(report.scenarioId)}</title>
<style>
:root{color-scheme:light;--ink:#17221e;--muted:#5b6963;--paper:#fbfaf6;--surface:#fff;--wash:#edf2ee;--line:#c8d1cc;--line-strong:#87978f;--forest:#123d31;--forest-deep:#092a22;--mint:#a8e6ce;--pass:#087443;--fail:#a51d32;--fail-wash:#fff1f3;--unknown:#745900;--unknown-wash:#fff8df;--focus:#f6b73c;--serif:Charter,"Bitstream Charter","Sitka Text",Cambria,serif;--sans:"Avenir Next",Avenir,"Segoe UI",system-ui,sans-serif;--mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace}
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
.badge{display:inline-block;border:1px solid currentColor;border-radius:999px;padding:.12rem .55rem;font-size:.75rem;line-height:1.4;font-weight:800;letter-spacing:.035em;text-transform:uppercase}
.badge.fail{color:var(--fail);background:var(--fail-wash)}.badge.pass{color:var(--pass);background:#eaf8f1}.badge.unknown{color:var(--unknown);background:var(--unknown-wash)}
.card-heading{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:.75rem}
.card-heading h3{margin:.1rem 0;font:700 clamp(1.3rem,3vw,1.75rem)/1.15 var(--serif)}
.technical-id{color:var(--muted);font:400 .78rem/1.4 var(--mono)}
.metrics{display:flex;flex-wrap:wrap;gap:.4rem 1.5rem;color:var(--muted)}
dl.meta{display:grid;grid-template-columns:max-content minmax(0,1fr);gap:.5rem 1.5rem;max-width:58rem}
dt{font-weight:750}dd{margin:0;overflow-wrap:anywhere}
.table-wrap{overflow-x:auto;border:1px solid var(--line);border-radius:8px}
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
@media(max-width:900px){.header-inner,.scoreboard{grid-template-columns:1fr}.header-meta{align-self:auto}.score-facts{grid-template-columns:repeat(2,minmax(0,1fr));padding:1.5rem}.score-facts div{padding:1rem;border-left:0;border-top:1px solid rgb(255 255 255/.2)}.score-facts div:nth-child(odd){border-right:1px solid rgb(255 255 255/.2)}.evidence-preview{grid-template-columns:1fr}.coverage-table td:last-child{min-width:18rem}}
@media(max-width:680px){.notice-grid,.remediation-grid,.outcome-pair,.lane-visuals{grid-template-columns:1fr;gap:0}.remediation-grid section+section{border-left:0;border-top:1px solid var(--line-strong);padding:1.25rem 0 0}.finding-dossier>header{grid-template-columns:1fr}.coverage-table td:last-child{min-width:14rem}}
@media(max-width:560px){.header-inner{padding:2.5rem 1rem 2rem}.report-header h1{font-size:clamp(2.7rem,14vw,4rem)}.header-links{padding-inline:1rem}.page-shell{padding:1.5rem 1rem 4rem}.score-facts{grid-template-columns:1fr;padding:0 1.5rem 1.5rem}.score-facts div,.score-facts div:first-child,.score-facts div:nth-child(odd){padding:1rem 0;border-left:0;border-right:0;border-top:1px solid rgb(255 255 255/.2)}dl.meta{grid-template-columns:1fr;gap:.1rem}dl.meta dd{margin-bottom:.7rem}.report-tabs{gap:1.2rem}}
@media print{.report-tabs{display:none}.tab-panel[hidden]{display:block!important}.report-header{background:#fff;color:#000}.header-inner{display:block;padding:1rem 0}.header-links{padding-inline:0}.page-shell{max-width:none;padding-inline:0}.scoreboard{border:1px solid #000;color:#000;background:#fff}.score-primary{background:#fff}.score-primary strong,.score-primary p,.score-primary .score-label,.score-facts dt,.score-facts small{color:#000!important}.panel,.result-card,.scoreboard{break-inside:avoid}}
</style></head>
<body><a class="skip-link" href="#report-content">Skip to report content</a><header class="report-header"><div class="header-inner"><div><h1>Accessibility evidence report</h1><p class="lede">${escapeHtml(report.goal)}</p></div><dl class="header-meta"><dt>Target</dt><dd><a href="${escapeAttribute(report.target)}">${escapeHtml(report.target)}</a></dd><dt>Standard</dt><dd>${escapeHtml(report.standard)}</dd><dt>Scenario</dt><dd>${escapeHtml(report.scenarioId)}</dd></dl></div><nav class="header-links" aria-label="Report downloads"><a href="${encodeURI(report.files.manifest)}">Checksummed manifest</a><a href="${encodeURI(report.files.json)}">Raw JSON report</a><a href="${encodeURI(report.files.markdown)}">Markdown report</a></nav></header>
<main id="report-content" class="page-shell"><section class="scoreboard" aria-labelledby="score-heading"><div class="score-primary ${report.verdict}"><h2 class="score-label" id="score-heading">Overall result</h2><strong>${escapeHtml(report.verdict.toUpperCase())}</strong><p>${report.synthesis.directJudgments.passed} direct checks passed; ${report.synthesis.directJudgments.failed} failed</p></div><dl class="score-facts"><div><dt>Direct checks</dt><dd>${report.synthesis.directJudgments.passed}/${report.synthesis.directJudgments.passed + report.synthesis.directJudgments.failed + report.synthesis.directJudgments.unknown}<small>passed across all lanes</small></dd></div><div><dt>Confirmed issues</dt><dd>${report.summary.findings}<small>${report.synthesis.findingOccurrences} checkpoint occurrences</small></dd></div><div><dt>Needs review</dt><dd>${report.synthesis.uniqueIncompleteRules.length}<small>${report.synthesis.incompleteRuleResults} incomplete rule results</small></dd></div><div><dt>Evidence</dt><dd>${availableArtifacts}/${report.summary.artifacts}<small>${escapeHtml(report.completeness.status)}</small></dd></div></dl></section><p class="score-note">This is a scoped release-policy verdict, not an automated WCAG conformance percentage. ${report.synthesis.releaseGates.passed} of ${report.summary.actions} action release gates passed. Passed behavior remains visible even when a repeated rule failure blocks release.</p>
<nav class="report-tabs" data-tab-list aria-label="Report sections">${tabLinks.map(([id, label]) => `<a href="#panel-${id}" data-tab>${escapeHtml(label)}</a>`).join("")}</nav>
<section id="panel-overview" class="tab-panel" data-tab-panel><h2>What the evidence says</h2><p class="conclusion">${escapeHtml(report.synthesis.conclusion)}</p>${renderLaneCoverage(report)}<section class="panel"><h3>Confirmed issues and unresolved checks</h3>${renderFindingIndex(report)}${report.synthesis.uniqueIncompleteRules.length ? `<p><strong>Still requiring review:</strong> ${report.synthesis.uniqueIncompleteRules.map(escapeHtml).join(", ")}. Incomplete Axe checks are not passes and are not included in the confirmed-issue count.</p>` : ""}</section><section class="panel"><h3>Assessment scope</h3><dl class="meta"><dt>Scenario</dt><dd>${escapeHtml(report.scenarioId)}</dd><dt>Profile</dt><dd>${escapeHtml(report.profile)}</dd><dt>Target</dt><dd><a href="${escapeAttribute(report.target)}">${escapeHtml(report.target)}</a></dd><dt>Standard</dt><dd>${escapeHtml(report.standard)}</dd><dt>Actions tested</dt><dd>${report.summary.actions} user-authored actions</dd><dt>Completed lanes</dt><dd>${report.completeness.completedLanes} of ${report.completeness.plannedLanes}</dd></dl></section>
<div class="notice-grid"><section class="panel notice"><h3>Privacy</h3><p>Evidence is sensitive, unreviewed, and not authorized for remote upload or sharing.</p></section><section class="panel ai"><h3>AI-generated output</h3><p>${escapeHtml(report.ai.label)}</p></section></div></section>
<section id="panel-findings" class="tab-panel" data-tab-panel><h2>Consolidated finding dossiers</h2><p>Each conclusion joins every occurrence with its after-state DOM, accessibility tree, focus record, rendered page, Axe nodes, and any relevant keyboard or virtual-reader judgment. A passing behavior check does not erase an independent rule failure.</p>${renderFindingDossiers(report)}</section>
<section id="panel-keyboard" class="tab-panel" data-tab-panel><h2>Keyboard and pointer overview</h2><p>Keyboard results are compared with the equivalent pointer path from isolated browser contexts, then checked against the user-declared expected outcome.</p>${renderKeyboardOverview(report, views)}</section>
<section id="panel-reader" class="tab-panel" data-tab-panel><h2>Virtual screen-reader report</h2><p>The portable reader is evaluated against the same-checkpoint DOM, full accessibility tree, rendered bounds, full-page visual, and DOM focus. It is a semantic simulation, not VoiceOver or NVDA.</p>${renderReaderOverview(report, views)}</section>
<section id="panel-axe" class="tab-panel" data-tab-panel><h2>Axe reports</h2><p>Axe results are shown per authored action. Violations and incomplete checks are separate; incomplete results require review and are not passes.</p>${renderAxeReportViews(views.axeReports)}</section>
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
            return `<figure><a href="${encodeURI(artifactPath)}"><img loading="lazy" src="${encodeURI(artifactPath)}" alt="Full-page view after ${escapeAttribute(label)}"></a><figcaption>${escapeHtml(label)} · <a href="${encodeURI(artifactPath)}">Open full-size image</a></figcaption></figure>`;
          })
          .join("")
      : '<p class="empty">No screenshots were captured.</p>'
  }</div></section></section>
<section id="panel-evidence" class="tab-panel" data-tab-panel><h2>Evidence files</h2><p>Files are grouped by evidence type and given readable labels. JSON remains the canonical machine-readable source, while this report is the review surface.</p>${renderEvidenceGroups(report.artifacts)}</section>
</main><script>
(() => { const list=document.querySelector('[data-tab-list]'); if(!list)return; const tabs=[...list.querySelectorAll('[data-tab]')]; const panels=tabs.map(tab=>document.querySelector(tab.getAttribute('href'))); list.setAttribute('role','tablist'); const activate=(index,focus=false)=>{tabs.forEach((tab,i)=>{tab.setAttribute('role','tab');tab.setAttribute('aria-selected',String(i===index));tab.setAttribute('tabindex',i===index?'0':'-1');tab.setAttribute('aria-controls',panels[i].id);panels[i].setAttribute('role','tabpanel');panels[i].setAttribute('aria-labelledby',tab.id||(tab.id='report-tab-'+i));panels[i].hidden=i!==index;});if(focus)tabs[index].focus();}; tabs.forEach((tab,index)=>{tab.addEventListener('click',event=>{event.preventDefault();activate(index);history.replaceState(null,'',tab.getAttribute('href'));});tab.addEventListener('keydown',event=>{let next=index;if(event.key==='ArrowRight'||event.key==='ArrowDown')next=(index+1)%tabs.length;else if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=(index-1+tabs.length)%tabs.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=tabs.length-1;else return;event.preventDefault();activate(next,true);});}); const requested=tabs.findIndex(tab=>tab.getAttribute('href')===location.hash);activate(requested>=0?requested:0);document.body.classList.add('tabs-ready'); })();
</script></body></html>`;
}

function renderLaneCoverage(report: ScenarioIntegratedReport): string {
  const rows = report.synthesis.lanes
    .map(
      (lane) =>
        `<tr><th scope="row">${escapeHtml(humanDriverName(lane.driver))}</th><td>${lane.actions}</td><td>${lane.passed}</td><td>${lane.failed}</td><td>${lane.unknown}</td><td>${escapeHtml(lane.summary)}</td></tr>`
    )
    .join("");
  return `<section class="panel"><h3>Coverage by active lane</h3><p>These counts exclude the derived release decision so successful behavior is not hidden by the final gate.</p><div class="table-wrap"><table class="coverage-table"><caption>Direct judgments across the user-authored actions</caption><thead><tr><th scope="col">Lane</th><th scope="col">Actions</th><th scope="col">Passed</th><th scope="col">Failed</th><th scope="col">Unresolved</th><th scope="col">Interpretation</th></tr></thead><tbody>${rows}</tbody></table></div></section>`;
}

function renderFindingIndex(report: ScenarioIntegratedReport): string {
  if (report.synthesis.findings.length === 0) {
    return '<p class="empty">No confirmed findings were emitted in this authored scope.</p>';
  }
  return `<ol class="finding-index">${report.synthesis.findings
    .map(
      (finding) =>
        `<li><a href="#finding-${escapeAttribute(finding.ruleId)}">${escapeHtml(finding.ruleId)}</a><p>${finding.checkpointCount} of ${report.actions.length} checkpoints · up to ${finding.maximumAffectedNodes} affected nodes</p><p>${escapeHtml(finding.title)}</p></li>`
    )
    .join(
      ""
    )}</ol><p><a href="#panel-findings">Review the evidence and remediation for every finding</a></p>`;
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
      return `<article class="finding-dossier" data-rule-id="${escapeAttribute(finding.ruleId)}" id="finding-${escapeAttribute(finding.ruleId)}"><header><div><h3>${escapeHtml(finding.ruleId)}</h3><p>${escapeHtml(finding.title)}</p></div><span class="badge fail">${escapeHtml(finding.severity)}</span></header><p class="finding-summary">${escapeHtml(finding.conclusion)}</p><p><strong>Standards:</strong> ${finding.wcagCriteria.length ? finding.wcagCriteria.map(escapeHtml).join(", ") : "No WCAG tag was emitted by the rule."}</p><div class="evidence-preview">${representative?.screenshotPath ? `<figure><a href="${encodeURI(representative.screenshotPath)}"><img loading="lazy" src="${encodeURI(representative.screenshotPath)}" alt="Full-page evidence for ${escapeAttribute(humanActionName(representative.actionId))}"></a><figcaption>Representative full-page checkpoint · <a href="${encodeURI(representative.screenshotPath)}">open full-size visual</a></figcaption></figure>` : ""}<div><h4>Representative affected element</h4><p><strong>${representative?.nodeCount ?? 0}</strong> affected nodes at this checkpoint. ${representative && representative.nodeCount > representative.targets.length ? `${representative.targets.length} representative selectors are summarized here; every node remains in the raw Axe evidence.` : ""}</p>${representative?.targets.length ? `<p><strong>First selector:</strong> <code>${escapeHtml(representative.targets[0]!)}</code></p>` : ""}${sample ? `<details><summary>Show captured HTML</summary><pre class="technical-sample">${escapeHtml(sample)}</pre></details>` : ""}${representative ? renderEvidenceLinks(representative) : ""}</div></div><div class="table-wrap"><table><caption>Every checkpoint considered in this conclusion</caption><thead><tr><th scope="col">Action and lane</th><th scope="col">Independent behavior result</th><th scope="col">Affected nodes</th><th scope="col">Correlated evidence</th></tr></thead><tbody>${checkpointRows}</tbody></table></div><div class="remediation-grid"><section><h4>Deterministic remediation</h4><p>${escapeHtml(finding.remediation.deterministic)}</p><h4>Verification after the fix</h4><ol class="verification-list">${finding.remediation.verification.map((step) => `<li>${escapeHtml(step)}</li>`).join("")}</ol></section><section><h4>AI contribution</h4><p><span class="badge unknown">Not used</span></p><p>${escapeHtml(finding.remediation.ai.reason)}</p><p><strong>Status:</strong> ${finding.remediation.ai.status === "available-if-needed" ? "Available only if deterministic evidence is inconclusive" : "Not appropriate for this deterministic decision"}.</p></section></div></article>`;
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
    [checkpoint.axePath, "Axe"]
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
    return '<p class="empty">No pointer/keyboard comparison was authored for this scenario. Permissions do not create tests.</p>';
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
      return `<article class="finding-dossier"><header><div><h3>${escapeHtml(comparison.name)}</h3><p>${escapeHtml(comparison.isolation.replaceAll("-", " "))}</p></div><span class="badge ${comparison.status === "completed" ? "pass" : "unknown"}">${escapeHtml(comparison.status)}</span></header>${comparison.readError ? `<p>${escapeHtml(comparison.readError)}</p>` : `<div class="outcome-pair"><section class="outcome"><h4>Equivalent outcome <span class="badge ${comparison.equivalence.verdict}">${escapeHtml(comparison.equivalence.verdict)}</span></h4><p>${escapeHtml(comparison.equivalence.summary)}</p></section><section class="outcome"><h4>Expected outcome <span class="badge ${comparison.expectation.verdict}">${escapeHtml(comparison.expectation.verdict)}</span></h4><p>${escapeHtml(comparison.expectation.summary)}</p></section></div><div class="table-wrap"><table><caption>Observed result in each isolated lane</caption><thead><tr><th scope="col">Lane</th><th scope="col">Authored actions</th><th scope="col">URL</th><th scope="col">Visible</th><th scope="col">Text</th></tr></thead><tbody>${renderComparisonLaneRow("Pointer", comparison.pointer)}${renderComparisonLaneRow("Keyboard", comparison.keyboard)}</tbody></table></div>${actionViews}`}<p><a class="raw-link" href="${encodeURI(comparison.path)}">Open complete interaction trace</a></p></article>`;
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
  return `<section class="panel"><div class="card-heading"><div><h3>${escapeHtml(humanActionName(action.actionId))}</h3><div class="technical-id">${escapeHtml(action.laneId)}</div></div><span class="badge ${behavior?.verdict ?? "unknown"}">${escapeHtml(behavior?.verdict ?? "unknown")}</span></div><p>${escapeHtml(behavior?.summary ?? "No independent behavior judgment was available.")}</p><div class="lane-visuals">${screenshot ? `<figure><a href="${encodeURI(screenshot)}"><img loading="lazy" src="${encodeURI(screenshot)}" alt="Viewport after ${escapeAttribute(humanActionName(action.actionId))}"></a><figcaption>Viewport after action</figcaption></figure>` : ""}${fullPage ? `<figure><a href="${encodeURI(fullPage)}"><img loading="lazy" src="${encodeURI(fullPage)}" alt="Full page after ${escapeAttribute(humanActionName(action.actionId))}"></a><figcaption>Full page after action</figcaption></figure>` : ""}</div>${links}</section>`;
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
          const actionId = `command-${entry.sequence}-${entry.command}`;
          const action = report.actions.find((candidate) => candidate.actionId === actionId);
          const actionView = views.actionReports.find(
            (candidate) => candidate.action.actionId === actionId
          );
          const judgment = actionView?.judgments.find(({ judgeId }) => judgeId === "screen-reader");
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
            ? `<figure><a href="${encodeURI(screenshot)}"><img loading="lazy" src="${encodeURI(screenshot)}" alt="Rendered page after ${escapeAttribute(humanActionName(action.actionId))}"></a><figcaption>${escapeHtml(humanActionName(action.actionId))}</figcaption></figure>`
            : "";
        })
        .join("");
      return `<article class="finding-dossier"><header><div><h3>Guide-mode navigation</h3><p>${escapeHtml(transcript.pageUrl)} · ${escapeHtml(transcript.fidelity.replaceAll("-", " "))}</p></div><span class="badge ${report.synthesis.reader.failed ? "fail" : report.synthesis.reader.unknown ? "unknown" : "pass"}">${report.synthesis.reader.passed}/${report.synthesis.reader.commands} passed</span></header>${transcript.readError ? `<p>${escapeHtml(transcript.readError)}</p>` : `<div class="table-wrap"><table><caption>Announcements correlated with semantic, visual, and focus evidence</caption><thead><tr><th scope="col">Command</th><th scope="col">Virtual announcement and bounds</th><th scope="col">DOM focus</th><th scope="col">Cross-evidence result</th><th scope="col">Evidence</th></tr></thead><tbody>${rows}</tbody></table></div><h4>Rendered checkpoints</h4><div class="media-grid">${visuals}</div>`}<p class="evidence-links"><a href="${encodeURI(transcript.path)}">Open transcript JSON</a>${transcript.textPath ? ` <a href="${encodeURI(transcript.textPath)}">Open readable transcript</a>` : ""}</p></article>`;
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
  return `<section class="panel"><h3>Unique rules across checkpoints</h3><p>Repeated page-level results are consolidated here. “Reports” shows how many after-action Axe runs contained the rule; “Nodes” is the largest affected-node count in one run.</p><div class="table-wrap"><table><caption>Consolidated Axe rules</caption><thead><tr><th scope="col">Rule</th><th scope="col">Result</th><th scope="col">Reports</th><th scope="col">Nodes</th><th scope="col">Guidance</th></tr></thead><tbody>${consolidatedRows}</tbody></table></div></section><section aria-labelledby="individual-axe-heading"><h3 id="individual-axe-heading">Individual Axe reports</h3><p>Expand a checkpoint to review its full rule summary.</p>${individualReports}</section>`;
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

function humanActionName(actionId: string): string {
  const words = actionId.replace(/^command-\d+-/, "").replaceAll("-", " ");
  return words.length > 0 ? `${words[0]!.toUpperCase()}${words.slice(1)}` : "Action";
}

function humanDriverName(driver: ScenarioActionReport["driver"]): string {
  if (driver === "portable-virtual-screen-reader") return "Portable virtual screen reader";
  return driver === "keyboard" ? "Keyboard" : "Pointer";
}

function behaviorLabelForDriver(driver: ScenarioActionReport["driver"]): string {
  return driver === "portable-virtual-screen-reader"
    ? "Reader semantic agreement"
    : "Focus management";
}

function artifactKindLabel(kind: string): string {
  const labels: Record<string, string> = {
    "accessibility-tree": "Accessibility trees",
    "axe-result": "Axe results",
    "dom-snapshot": "DOM snapshots",
    "evidence-bundle": "Evidence bundles",
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
    "evidence-bundle": "Correlated records, artifacts, interactions, and judgments for one action.",
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

function reportSupplementalFiles(
  reportFiles: { html: string; json: string; markdown: string },
  planFile: string
) {
  return [
    { path: reportFiles.html, kind: "html-report" as const, phase: "assessment" as const },
    { path: reportFiles.json, kind: "json-report" as const, phase: "assessment" as const },
    { path: reportFiles.markdown, kind: "markdown-report" as const, phase: "assessment" as const },
    { path: planFile, kind: "custom" as const, phase: "assessment" as const }
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
