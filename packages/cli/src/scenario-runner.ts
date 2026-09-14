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

async function writeIntegratedReport(
  report: ScenarioIntegratedReport,
  files: { html: string; json: string; markdown: string },
  rootDir: string
): Promise<void> {
  assertValidSchema("scenarioReport", report, "integrated scenario report");
  const transcriptArtifacts = report.artifacts.filter(
    (artifact) =>
      artifact.kind === "screen-reader-transcript" &&
      /(^|\/)transcript\.txt$/.test(String(artifact.path))
  );
  const transcripts = await Promise.all(
    transcriptArtifacts.map(async (artifact) => ({
      path: String(artifact.path),
      content: await readFile(path.resolve(rootDir, String(artifact.path)), "utf8")
    }))
  );
  await Promise.all([
    writeFile(files.json, JSON.stringify(report, null, 2), "utf8"),
    writeFile(files.markdown, renderIntegratedMarkdown(report), "utf8"),
    writeFile(files.html, renderIntegratedHtml(report, transcripts), "utf8")
  ]);
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
    `- ${report.summary.actions} user-authored actions evaluated`,
    `- ${report.summary.failed} failed, ${report.summary.unknown} unknown, ${report.summary.passed} passed`,
    `- ${report.summary.findings} findings`,
    `- ${report.summary.artifacts} indexed artifacts`,
    "",
    "## Actions",
    "",
    "| Lane | Action | Verdict | Raw report |",
    "| --- | --- | --- | --- |",
    ...report.actions.map(
      (action) =>
        `| ${escapeMarkdown(action.driver)} | ${escapeMarkdown(action.actionId)} | ${action.releaseVerdict} | [JSON](${encodeURI(action.reportPath)}) |`
    ),
    "",
    "## Findings",
    ""
  ];
  if (report.findings.length === 0) lines.push("No findings were emitted.");
  for (const finding of report.findings) {
    lines.push(
      `- **${escapeMarkdown(String(finding.ruleId ?? finding.id ?? "finding"))}:** ${escapeMarkdown(String(finding.message ?? "No message."))}`
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
  transcripts: Array<{ path: string; content: string }>
): string {
  const screenshots = report.artifacts.filter(
    (artifact) => artifact.kind === "full-page-screenshot" && artifact.phase === "after"
  );
  const videos = report.artifacts.filter((artifact) => artifact.kind === "interaction-video");
  const captions = report.artifacts.filter((artifact) => artifact.kind === "video-captions");
  const axeArtifacts = report.artifacts.filter((artifact) => artifact.kind === "axe-result");
  const captionFor = (videoPath: string) => {
    const parent = path.posix.dirname(videoPath);
    return captions.find((artifact) => path.posix.dirname(String(artifact.path)) === parent);
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Accessibility evidence report: ${escapeHtml(report.scenarioId)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:1120px;margin:auto;padding:2rem;color:#17211d;background:#f8fbf9}a{color:#075b42}header,.panel{background:#fff;border:1px solid #bfd0c8;border-radius:12px;padding:1.25rem;margin:1rem 0}.verdict{font-size:1.4rem;font-weight:750}.fail{color:#9b1c1c}.pass{color:#087443}.unknown{color:#765900}table{border-collapse:collapse;width:100%}th,td{padding:.65rem;border:1px solid #c9d5d0;text-align:left;vertical-align:top}img,video{max-width:100%;height:auto;border:1px solid #8da49a}figure{margin:1.5rem 0}code,pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#eef4f1;padding:.25rem}details{margin:.75rem 0}.warning{border-left:5px solid #b36b00}.ai{border-left:5px solid #5367d8}</style></head>
<body><header><h1>Accessibility evidence report</h1><p>${escapeHtml(report.goal)}</p><p class="verdict ${report.verdict}">Overall verdict: ${report.verdict.toUpperCase()}</p><p>Evidence completeness: <strong>${report.completeness.status}</strong>. Missing evidence never becomes a pass.</p><p><a href="${encodeURI(report.files.manifest)}">Checksummed manifest</a> · <a href="${encodeURI(report.files.json)}">JSON report</a> · <a href="${encodeURI(report.files.markdown)}">Markdown report</a></p></header>
<section class="panel warning" aria-labelledby="privacy"><h2 id="privacy">Privacy</h2><p>Evidence is sensitive, unreviewed, and not authorized for remote upload or sharing.</p></section>
<section class="panel ai" aria-labelledby="ai"><h2 id="ai">AI-generated output</h2><p>${escapeHtml(report.ai.label)}</p></section>
<main><section class="panel"><h2>Summary</h2><dl><dt>Target</dt><dd><a href="${escapeAttribute(report.target)}">${escapeHtml(report.target)}</a></dd><dt>Standard</dt><dd>${escapeHtml(report.standard)}</dd><dt>Actions</dt><dd>${report.summary.actions}</dd><dt>Findings</dt><dd>${report.summary.findings}</dd><dt>Artifacts</dt><dd>${report.summary.artifacts}</dd></dl></section>
<section class="panel"><h2>Action results</h2><table><caption>Every user-authored action and its release verdict</caption><thead><tr><th scope="col">Lane</th><th scope="col">Action</th><th scope="col">Verdict</th><th scope="col">Evidence</th></tr></thead><tbody>${report.actions.map((action) => `<tr><td>${escapeHtml(action.driver)}</td><td>${escapeHtml(action.actionId)}</td><td>${escapeHtml(action.releaseVerdict)}</td><td><a href="${encodeURI(action.reportPath)}">JSON report</a></td></tr>`).join("")}</tbody></table></section>
<section class="panel"><h2>Findings</h2>${report.findings.length ? `<ul>${report.findings.map((finding) => `<li><strong>${escapeHtml(String(finding.ruleId ?? finding.id ?? "Finding"))}</strong>: ${escapeHtml(String(finding.message ?? "No message."))}</li>`).join("")}</ul>` : "<p>No findings were emitted.</p>"}</section>
<section class="panel"><h2>Videos and action descriptions</h2>${videos
    .map((artifact) => {
      const videoPath = String(artifact.path);
      const caption = captionFor(videoPath);
      return `<figure><video controls preload="metadata"><source src="${encodeURI(videoPath)}" type="video/webm">${caption ? `<track kind="descriptions" src="${encodeURI(String(caption.path))}" srclang="en" label="Action descriptions">` : ""}<a href="${encodeURI(videoPath)}">Download the WebM recording</a></video><figcaption>${escapeHtml(String(artifact.provenance && typeof artifact.provenance === "object" ? ((artifact.provenance as Record<string, unknown>).laneId ?? "Interaction lane") : "Interaction lane"))}</figcaption></figure>`;
    })
    .join("")}</section>
<section class="panel"><h2>Virtual screen-reader transcript</h2>${transcripts.length ? transcripts.map((transcript) => `<details><summary>${escapeHtml(transcript.path)}</summary><pre>${escapeHtml(transcript.content)}</pre></details>`).join("") : "<p>No virtual-reader transcript was requested.</p>"}</section>
<section class="panel"><h2>Visual evidence</h2>${screenshots.map((artifact) => `<figure><a href="${encodeURI(String(artifact.path))}"><img loading="lazy" src="${encodeURI(String(artifact.path))}" alt="Full-page view after ${escapeAttribute(String(artifact.provenance && typeof artifact.provenance === "object" ? ((artifact.provenance as Record<string, unknown>).actionId ?? "an action") : "an action"))}"></a><figcaption>${escapeHtml(String(artifact.path))}</figcaption></figure>`).join("")}</section>
<section class="panel"><h2>Axe reports</h2><ul>${axeArtifacts.map((artifact) => `<li><a href="${encodeURI(String(artifact.path))}">${escapeHtml(String(artifact.path))}</a></li>`).join("")}</ul></section>
<section class="panel"><h2>All raw evidence</h2><details><summary>${report.artifacts.length} indexed child artifacts</summary><ul>${report.artifacts.map((artifact) => `<li>${escapeHtml(String(artifact.kind))}: <a href="${encodeURI(String(artifact.path))}">${escapeHtml(String(artifact.path))}</a> — ${escapeHtml(String(artifact.status))}</li>`).join("")}</ul></details></section></main></body></html>`;
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
