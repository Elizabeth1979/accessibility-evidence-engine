#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  executeRun,
  resolvePolicyConfig,
  type AeePolicyOverrides,
  type Interaction,
  type ReporterInput,
  type ReporterArtifact
} from "@aee/core";
import { createDefaultJudgePlugins, defaultJudgeManifests } from "@aee/judges";
import { createDefaultObserverPlugins, type RuntimeObserverContext } from "@aee/observers";
import {
  buildCheckpoint,
  buildInteraction,
  createVirtualPage,
  resolveObserverIdsForCapturePolicy,
  type PlaywrightPageLike,
  type VirtualPageFixture
} from "@aee/playwright";
import { createJsonReporter, createMarkdownReporter } from "@aee/reporter";
import {
  assertValidSchema,
  CURRENT_SCHEMA_VERSION,
  schemaCatalog,
  type SchemaName
} from "@aee/schemas";

import {
  buildPullRequestComment,
  FAIL_ON_VALUES,
  failsOn,
  postStickyComment,
  type FailOn
} from "./pr-comment";
import { compileScenarioPlan, loadScenario, renderScenarioPlan } from "./scenario";
import { executeScenario, openScenarioReport } from "./scenario-runner";

export {
  aeeRunModelProvider,
  executeScenario,
  openScenarioReport,
  type ExecuteScenarioOptions,
  type ExecuteScenarioResult,
  type ScenarioIntegratedReport
} from "./scenario-runner";

export {
  compileScenarioPlan,
  loadScenario,
  renderScenarioPlan,
  type AeeScenario,
  type ScenarioCapability,
  type ScenarioPlan,
  type ScenarioProfile
} from "./scenario";

export interface AeeCliConfig {
  version?: string;
  projectRoot: string;
  outputDir?: string;
  fixturePath?: string;
  policy?: AeePolicyOverrides;
  observers?: string[];
  judges?: string[];
  checkpointName?: string;
  interaction?: {
    kind?: Interaction["kind"];
    actor?: "test" | "engine" | "user-script";
    target?: {
      role?: string;
      name?: string;
      selector?: string;
      locator?: string;
      nodePath?: string;
    };
    input?: string;
    meta?: Record<string, unknown>;
  };
}

export interface RunCommandResult {
  runId: string;
  outputDir: string;
  reporterFiles: string[];
  artifactFiles: string[];
}

async function loadJsonFile<T>(
  filePath: string,
  schemaName: SchemaName,
  label: string
): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON in ${label} at ${filePath}: ${message}`, { cause: error });
  }

  assertValidSchema(schemaName, parsed, `${label} at ${filePath} (${schemaCatalog[schemaName]})`);
  return parsed as T;
}

export async function loadConfig(configPath: string): Promise<AeeCliConfig> {
  return loadJsonFile<AeeCliConfig>(configPath, "cliConfig", "AEE CLI config");
}

export async function loadFixture(fixturePath: string): Promise<VirtualPageFixture> {
  return loadJsonFile<VirtualPageFixture>(
    fixturePath,
    "virtualPageFixture",
    "AEE virtual page fixture"
  );
}

export function createBootstrapPlan(config: AeeCliConfig) {
  const resolvedPolicy = resolvePolicyConfig(config.policy);
  const selectedObservers = resolveObserverIdsForCapturePolicy(
    config.observers,
    resolvedPolicy.capture
  );

  return {
    projectRoot: config.projectRoot,
    selectedObservers,
    selectedJudges: config.judges ?? defaultJudgeManifests.map((manifest) => manifest.id),
    policyName: resolvedPolicy.name
  };
}

export async function runWithPage(
  config: AeeCliConfig,
  page: PlaywrightPageLike,
  configPathForResolution: string
): Promise<RunCommandResult> {
  const resolvedProjectRoot = path.resolve(
    path.dirname(configPathForResolution),
    config.projectRoot
  );
  const resolvedPolicy = resolvePolicyConfig(config.policy);
  const selectedObservers = resolveObserverIdsForCapturePolicy(
    config.observers,
    resolvedPolicy.capture
  );
  const runId = `run-${Date.now()}`;
  const outputBaseDir = config.outputDir ?? "aee-output";
  const outputDir = path.join(resolvedProjectRoot, outputBaseDir, runId);
  const artifactDir = path.join(outputDir, "artifacts");
  await mkdir(artifactDir, { recursive: true });

  const checkpoint = buildCheckpoint(
    { runId },
    {
      page,
      trigger: "manual",
      name: config.checkpointName ?? "initial"
    }
  );

  const interaction = buildInteraction(
    { runId },
    {
      timestamp: new Date().toISOString(),
      actor: config.interaction?.actor ?? "engine",
      kind: config.interaction?.kind ?? "custom",
      target: config.interaction?.target,
      input: config.interaction?.input,
      meta: config.interaction?.meta
    }
  );

  const observerContext: RuntimeObserverContext = {
    runId,
    checkpointId: checkpoint.id,
    interactionId: interaction.id,
    url: page.url(),
    page,
    artifactDir
  };

  const execution = await executeRun({
    runId,
    version: config.version ?? CURRENT_SCHEMA_VERSION,
    environment: {
      mode: "fixture-runner"
    },
    config: {
      policyName: resolvedPolicy.name,
      capturePolicy: resolvedPolicy.capture,
      selectedObservers
    },
    checkpoint,
    interaction,
    observerContext,
    observerPlugins: createDefaultObserverPlugins(selectedObservers),
    judgePlugins: createDefaultJudgePlugins(
      config.judges ?? defaultJudgeManifests.map((manifest) => manifest.id)
    ),
    policyName: resolvedPolicy.name,
    releasePolicy: resolvedPolicy.release
  });

  const reporterInput = {
    run: execution.run,
    bundles: execution.bundles,
    records: execution.records,
    judgments: execution.judgments,
    findings: execution.findings,
    artifacts: execution.artifacts
  };

  const reporterArtifacts = await renderReports(reporterInput);
  const reporterFiles = await writeReporterArtifacts(outputDir, reporterArtifacts);
  const artifactFiles = execution.artifacts.map((artifact) => artifact.path);

  assertValidSchema("run", execution.run, "AEE run output");
  assertValidSchema("evidenceBundle", execution.bundles[0], "AEE evidence bundle output");
  await writeFile(path.join(outputDir, "run.json"), JSON.stringify(execution.run, null, 2), "utf8");
  await writeFile(
    path.join(outputDir, "bundle.json"),
    JSON.stringify(execution.bundles[0], null, 2),
    "utf8"
  );

  return {
    runId,
    outputDir,
    reporterFiles,
    artifactFiles
  };
}

export async function executeConfig(configPath: string): Promise<RunCommandResult> {
  const config = await loadConfig(configPath);

  if (!config.fixturePath) {
    throw new Error('This bootstrap runner currently requires "fixturePath" in the config.');
  }

  const fixturePath = path.resolve(path.dirname(configPath), config.fixturePath);
  const fixture = await loadFixture(fixturePath);
  const page = createVirtualPage(fixture);

  return runWithPage(config, page, configPath);
}

async function renderReports(input: ReporterInput) {
  const reporters = [createJsonReporter(), createMarkdownReporter()];
  const batches = await Promise.all(reporters.map((reporter) => reporter.render(input)));
  return batches.flat();
}

async function writeReporterArtifacts(
  outputDir: string,
  artifacts: ReporterArtifact[]
): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });

  const writes = artifacts.map(async (artifact) => {
    const targetPath = path.join(outputDir, artifact.label);
    await writeFile(targetPath, artifact.content, "utf8");
    return targetPath;
  });

  return Promise.all(writes);
}

export async function main(argv: string[]): Promise<void> {
  const command = argv[0];

  if (!command) {
    throw new Error(
      "Usage: aee plan <scenario.yml> [--json] | aee run <scenario.yml> [--open] [--ci] [--output <dir>] | aee run <config.json> | aee comment <folder>... [--fail-on blocking|incomplete|never] [--post]"
    );
  }

  if (command === "comment") {
    await runCommentCommand(argv.slice(1));
    return;
  }

  if (command === "plan") {
    const scenarioPath = argv[1];

    if (!scenarioPath || scenarioPath.startsWith("--")) {
      throw new Error("Usage: aee plan <scenario.yml> [--json]");
    }

    const scenario = await loadScenario(path.resolve(scenarioPath));
    const plan = compileScenarioPlan(scenario);
    process.stdout.write(
      argv.includes("--json") ? `${JSON.stringify(plan, null, 2)}\n` : renderScenarioPlan(plan)
    );
    return;
  }

  const configPath = command === "run" ? argv[1] : command;

  if (!configPath || configPath.startsWith("--")) {
    throw new Error("Usage: aee run <config.json>");
  }

  if (/\.ya?ml$/i.test(configPath)) {
    const scenarioOptions = parseScenarioRunOptions(argv.slice(2));
    const result = await executeScenario(path.resolve(configPath), {
      outputDir: scenarioOptions.outputDir
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (scenarioOptions.open) openScenarioReport(result.reportFiles.html);
    if (scenarioOptions.ci && (result.verdict !== "pass" || result.completeness !== "complete")) {
      process.exitCode = 1;
    }
    return;
  }

  const result = await executeConfig(path.resolve(configPath));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function parseScenarioRunOptions(argv: string[]): {
  open: boolean;
  ci: boolean;
  outputDir?: string;
} {
  let outputDir: string | undefined;
  const allowedFlags = new Set(["--open", "--ci", "--output"]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!allowedFlags.has(argument)) throw new Error(`Unknown scenario run option: ${argument}`);
    if (argument === "--output") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--output requires a directory path.");
      }
      outputDir = value;
      index += 1;
    }
  }
  return {
    open: argv.includes("--open"),
    ci: argv.includes("--ci"),
    ...(outputDir ? { outputDir } : {})
  };
}

/**
 * `aee comment <folder>...`: renders every assessment under the folders as one PR comment, prints
 * it, adds it to the GitHub job summary, and with `--post` keeps it as the pull request's one AEE
 * comment. The exit code follows `--fail-on` (default blocking).
 */
async function runCommentCommand(argv: string[]): Promise<void> {
  const folders: string[] = [];
  let failOn: FailOn = "blocking";
  let post = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--post") post = true;
    else if (argument === "--fail-on") {
      const value = argv[index + 1] as FailOn;
      if (!FAIL_ON_VALUES.includes(value)) {
        throw new Error(`--fail-on must be one of ${FAIL_ON_VALUES.join(", ")}.`);
      }
      failOn = value;
      index += 1;
    } else if (argument.startsWith("--")) throw new Error(`Unknown comment option: ${argument}`);
    else folders.push(argument);
  }
  if (folders.length === 0) {
    throw new Error(
      "Usage: aee comment <folder>... [--fail-on blocking|incomplete|never] [--post]"
    );
  }

  const env = process.env;
  const runUrl =
    env.GITHUB_SERVER_URL && env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`
      : undefined;
  const comment = await buildPullRequestComment(
    folders.map((folder) => path.resolve(folder)),
    runUrl
  );
  process.stdout.write(`${comment.body}\n`);
  if (env.GITHUB_STEP_SUMMARY)
    await writeFile(env.GITHUB_STEP_SUMMARY, `${comment.body}\n`, { flag: "a" });

  if (post) {
    const event = env.GITHUB_EVENT_PATH
      ? (JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8")) as {
          pull_request?: { number?: number };
        })
      : {};
    const pullNumber = event.pull_request?.number;
    if (!pullNumber || !env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) {
      process.stderr.write(
        "Not posted: posting needs a pull_request event, GITHUB_REPOSITORY and GITHUB_TOKEN.\n"
      );
    } else {
      // A comment that cannot be posted, such as from a fork's read-only token, does not decide
      // the job: the verdict does, and the comment is still in the log and the job summary.
      await postStickyComment(comment.body, {
        repository: env.GITHUB_REPOSITORY,
        pullNumber,
        token: env.GITHUB_TOKEN,
        apiUrl: env.GITHUB_API_URL
      }).then(
        ({ action, url }) => process.stderr.write(`PR comment ${action}: ${url}\n`),
        (error: unknown) =>
          process.stderr.write(
            `::warning::The PR comment was not posted: ${error instanceof Error ? error.message : String(error)}\n`
          )
      );
    }
  }

  process.stderr.write(
    `${comment.reports} assessment${comment.reports === 1 ? "" : "s"}, verdict ${comment.verdict}, fail-on ${failOn}.\n`
  );
  if (failsOn(comment.verdict, failOn)) process.exitCode = 1;
}

if (require.main === module) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
