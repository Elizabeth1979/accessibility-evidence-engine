#!/usr/bin/env node

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  DEFAULT_POLICY,
  executeRun,
  type AeePolicyConfig,
  type Interaction,
  type ReporterInput,
  type ReporterArtifact
} from "@aee/core";
import { createDefaultJudgePlugins, defaultJudgeManifests } from "@aee/judges";
import {
  createDefaultObserverPlugins,
  type RuntimeObserverContext
} from "@aee/observers";
import { buildCheckpoint, buildInteraction, createVirtualPage, type PlaywrightPageLike, type VirtualPageFixture } from "@aee/playwright";
import { createJsonReporter, createMarkdownReporter } from "@aee/reporter";
import { CURRENT_SCHEMA_VERSION, schemaCatalog } from "@aee/schemas";

export interface AeeCliConfig {
  version?: string;
  projectRoot: string;
  outputDir?: string;
  fixturePath?: string;
  policy?: Partial<AeePolicyConfig>;
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

const VALID_INTERACTION_KINDS = new Set<Interaction["kind"]>([
  "tab",
  "shift-tab",
  "click",
  "hover",
  "focus",
  "enter",
  "space",
  "escape",
  "arrow-key",
  "type",
  "submit",
  "custom"
]);

export interface RunCommandResult {
  runId: string;
  outputDir: string;
  reporterFiles: string[];
  artifactFiles: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(config: unknown): asserts config is AeeCliConfig {
  if (!isRecord(config)) {
    throw new Error("Config must be a JSON object.");
  }

  if (typeof config.projectRoot !== "string" || config.projectRoot.length === 0) {
    throw new Error(`Config must include a non-empty "projectRoot". Expected shape aligned with ${schemaCatalog.run}.`);
  }

  if (config.fixturePath !== undefined && typeof config.fixturePath !== "string") {
    throw new Error('"fixturePath" must be a string when provided.');
  }

  if (config.outputDir !== undefined && typeof config.outputDir !== "string") {
    throw new Error('"outputDir" must be a string when provided.');
  }

  if (config.observers !== undefined && !Array.isArray(config.observers)) {
    throw new Error('"observers" must be an array of observer ids.');
  }

  if (config.judges !== undefined && !Array.isArray(config.judges)) {
    throw new Error('"judges" must be an array of judge ids.');
  }

  if (config.interaction !== undefined) {
    if (!isRecord(config.interaction)) {
      throw new Error('"interaction" must be an object when provided.');
    }

    if (
      config.interaction.kind !== undefined &&
      (typeof config.interaction.kind !== "string" ||
        !VALID_INTERACTION_KINDS.has(config.interaction.kind as Interaction["kind"]))
    ) {
      throw new Error(`"interaction.kind" must be one of: ${Array.from(VALID_INTERACTION_KINDS).join(", ")}.`);
    }
  }
}

function validateFixture(fixture: unknown): asserts fixture is VirtualPageFixture {
  if (!isRecord(fixture)) {
    throw new Error("Fixture must be a JSON object.");
  }

  if (typeof fixture.url !== "string" || typeof fixture.html !== "string") {
    throw new Error('Fixture must include string "url" and "html" properties.');
  }
}

async function loadJsonFile<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw) as T;
}

export async function loadConfig(configPath: string): Promise<AeeCliConfig> {
  const config = await loadJsonFile<AeeCliConfig>(configPath);
  validateConfig(config);
  return config;
}

export async function loadFixture(fixturePath: string): Promise<VirtualPageFixture> {
  const fixture = await loadJsonFile<VirtualPageFixture>(fixturePath);
  validateFixture(fixture);
  return fixture;
}

export function createBootstrapPlan(config: AeeCliConfig) {
  return {
    projectRoot: config.projectRoot,
    selectedObservers: config.observers ?? ["dom", "accessibility-tree"],
    selectedJudges: config.judges ?? defaultJudgeManifests.map((manifest) => manifest.id),
    policyName: config.policy?.name ?? DEFAULT_POLICY.name
  };
}

export async function runWithPage(
  config: AeeCliConfig,
  page: PlaywrightPageLike,
  configPathForResolution: string
): Promise<RunCommandResult> {
  const resolvedProjectRoot = path.resolve(path.dirname(configPathForResolution), config.projectRoot);
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
      policyName: config.policy?.name ?? DEFAULT_POLICY.name
    },
    checkpoint,
    interaction,
    observerContext,
    observerPlugins: createDefaultObserverPlugins(config.observers),
    judgePlugins: createDefaultJudgePlugins(config.judges ?? defaultJudgeManifests.map((manifest) => manifest.id)),
    policyName: config.policy?.name ?? DEFAULT_POLICY.name
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

  await writeFile(path.join(outputDir, "run.json"), JSON.stringify(execution.run, null, 2), "utf8");
  await writeFile(path.join(outputDir, "bundle.json"), JSON.stringify(execution.bundles[0], null, 2), "utf8");

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

async function writeReporterArtifacts(outputDir: string, artifacts: ReporterArtifact[]): Promise<string[]> {
  await mkdir(outputDir, { recursive: true });

  const writes = artifacts.map(async (artifact) => {
    const targetPath = path.join(outputDir, artifact.label);
    await writeFile(targetPath, artifact.content, "utf8");
    return targetPath;
  });

  return Promise.all(writes);
}

export async function main(argv: string[]): Promise<void> {
  const configPath = argv[0];

  if (!configPath) {
    throw new Error("Usage: aee <config-path>");
  }

  const result = await executeConfig(path.resolve(configPath));
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

if (require.main === module) {
  void main(process.argv.slice(2)).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
