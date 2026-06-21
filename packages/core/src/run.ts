import type { JudgePlugin, ObserverContext, ObserverPlugin } from "./plugins";
import type { ReleasePolicy } from "./policy";
import { buildEvidenceBundle, createRunShell, summarizeJudgments } from "./engine";
import type { AeeRun, Checkpoint, EvidenceBundle, EvidenceRecord, Finding, Interaction, Judgment } from "./types";

export interface InteractionExecutionContext {
  runId: string;
  checkpoint: Checkpoint;
  interaction: Interaction;
  observerContext: ObserverContext;
}

export interface RunExecutionInput {
  runId?: string;
  version?: string;
  startedAt?: string;
  environment?: Record<string, unknown>;
  config?: Record<string, unknown>;
  checkpoint: Checkpoint;
  interaction: Interaction;
  observerContext: ObserverContext;
  observerPlugins: ObserverPlugin[];
  judgePlugins: JudgePlugin[];
  policyName?: string;
  releasePolicy?: ReleasePolicy;
  executeInteraction?: (context: InteractionExecutionContext) => Promise<void>;
}

export interface RunExecutionResult {
  run: AeeRun;
  bundles: EvidenceBundle[];
  records: EvidenceRecord[];
  judgments: Judgment[];
  findings: Finding[];
  artifacts: EvidenceBundle["artifacts"];
}

export async function executeRun(input: RunExecutionInput): Promise<RunExecutionResult> {
  const runId = input.runId ?? input.checkpoint.runId;
  const startedAt = input.startedAt ?? new Date().toISOString();
  const run = createRunShell({
    id: runId,
    version: input.version,
    startedAt,
    environment: input.environment,
    config: input.config
  });

  run.status = "running";
  run.checkpoints?.push(input.checkpoint);
  run.interactions?.push(input.interaction);

  try {
    await runObserverLifecycle(input.observerPlugins, "setup", input.observerContext);

    const beforeRecords = await capturePhase(input.observerPlugins, "before", input.observerContext);

    if (input.executeInteraction) {
      await input.executeInteraction({
        runId,
        checkpoint: input.checkpoint,
        interaction: input.interaction,
        observerContext: input.observerContext
      });
    }

    const afterRecords = await capturePhase(input.observerPlugins, "after", input.observerContext);
    const records = [...beforeRecords, ...afterRecords];

    const bundle = buildEvidenceBundle({
      runId,
      interaction: input.interaction,
      checkpoint: input.checkpoint,
      records
    });

    const judgments = await runJudges(input.judgePlugins, bundle, input.policyName, input.releasePolicy);
    const findings = judgments.flatMap((judgment) => judgment.findings ?? []);

    run.status = "completed";
    run.finishedAt = new Date().toISOString();
    run.results = summarizeJudgments(judgments);

    return {
      run,
      bundles: [bundle],
      records,
      judgments,
      findings,
      artifacts: bundle.artifacts
    };
  } catch (error) {
    run.status = "failed";
    run.finishedAt = new Date().toISOString();
    throw error;
  } finally {
    await runObserverLifecycle(input.observerPlugins, "teardown", input.observerContext);
  }
}

async function capturePhase(
  observerPlugins: ObserverPlugin[],
  phase: "before" | "after",
  context: ObserverContext
): Promise<EvidenceRecord[]> {
  const batches = await Promise.all(
    observerPlugins.map((plugin) => {
      if (phase === "before") {
        return plugin.captureBefore ? plugin.captureBefore(context) : Promise.resolve([]);
      }

      return plugin.captureAfter ? plugin.captureAfter(context) : Promise.resolve([]);
    })
  );

  return batches.flat();
}

async function runJudges(
  judgePlugins: JudgePlugin[],
  bundle: EvidenceBundle,
  policyName?: string,
  releasePolicy?: ReleasePolicy
): Promise<Judgment[]> {
  const standardJudges = judgePlugins.filter((judge) => judge.manifest.id !== "release");
  const releaseJudges = judgePlugins.filter((judge) => judge.manifest.id === "release");

  const primaryBatches = await Promise.all(
    standardJudges.map((judge) =>
      judge.judge(bundle, {
        runId: bundle.runId,
        policyName,
        releasePolicy,
        priorJudgments: []
      })
    )
  );

  const primaryJudgments = primaryBatches.flat();

  const releaseBatches = await Promise.all(
    releaseJudges.map((judge) =>
      judge.judge(bundle, {
        runId: bundle.runId,
        policyName,
        releasePolicy,
        priorJudgments: primaryJudgments
      })
    )
  );

  return [...primaryJudgments, ...releaseBatches.flat()];
}

async function runObserverLifecycle(
  observerPlugins: ObserverPlugin[],
  phase: "setup" | "teardown",
  context: ObserverContext
): Promise<void> {
  await Promise.all(
    observerPlugins.map((plugin) => {
      if (phase === "setup") {
        return plugin.setup ? plugin.setup(context) : Promise.resolve();
      }

      return plugin.teardown ? plugin.teardown(context) : Promise.resolve();
    })
  );
}
