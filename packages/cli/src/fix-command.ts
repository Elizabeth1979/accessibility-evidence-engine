import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { applyFix, fixAttributeForRule, type FixAttribute } from "./fix";
import { loadScenario } from "./scenario";
import {
  executeScenario,
  overallVerdict,
  verifyAppliedFixes,
  type AppliedFix,
  type ExecuteScenarioOptions,
  type ExecuteScenarioResult,
  type FixVerification,
  type ScenarioIntegratedReport
} from "./scenario-runner";

/** How long the app has to answer at the scenario's target once `--start` runs. */
const START_TIMEOUT_MS = 120_000;

/** A proposal a person accepted: the element, and the name when they reworded the suggestion. */
export interface AcceptedFix {
  selector: string;
  name?: string;
}

export interface VerifiedFixOptions extends Pick<ExecuteScenarioOptions, "browser" | "aiProvider"> {
  /** The approved scenario that found the problem; it is rerun unchanged. */
  scenarioPath: string;
  /** The assessment folder holding the proposals, as `aee run` wrote it. */
  assessmentDir: string;
  accept: AcceptedFix[];
  /** The file, tracked in git, that renders the elements. */
  sourceFile: string;
  /** The command that serves the app at the scenario's target, run in the fix's worktree. */
  startCommand: string;
  /** Where the rerun writes its assessment; defaults to `aee run`'s own. */
  outputDir?: string;
}

export interface VerifiedFix extends AppliedFix {
  attribute: FixAttribute;
  /** Who worded the name: the AI specialist, accepted as it was, or the reviewer. */
  wordedBy: "ai" | "reviewer";
}

export interface VerifiedFixResult {
  verdict: "pass" | "fail" | "unknown";
  branch: string;
  commit: string;
  fixes: VerifiedFix[];
  verifications: FixVerification[];
  rerun: ExecuteScenarioResult;
}

/**
 * Applies reviewed name proposals on a new branch and proves them: the branch is checked out in its
 * own git worktree, so the working copy is never touched; the app is started from there; the same
 * approved scenario is run again; and each fix passes only when the rerun's evidence confirms it.
 * The branch and its commit stay for a person to review and push. Nothing is merged or pushed.
 */
export async function runVerifiedFix(options: VerifiedFixOptions): Promise<VerifiedFixResult> {
  const sourceFile = path.resolve(options.sourceFile);
  const report = JSON.parse(
    await readFile(path.join(options.assessmentDir, "aee-report.json"), "utf8")
  ) as ScenarioIntegratedReport;
  const fixes = options.accept.map((accepted) => resolveAccepted(report, accepted));

  const repoRoot = git(path.dirname(sourceFile), ["rev-parse", "--show-toplevel"]);
  const relativeSource = path.relative(repoRoot, sourceFile);
  if (git(repoRoot, ["status", "--porcelain", "--", relativeSource])) {
    throw new Error(
      `${relativeSource} has uncommitted changes. Commit or stash them, so the fix starts from a known version.`
    );
  }
  let source = await readFile(sourceFile, "utf8");
  for (const fix of fixes) {
    const result = applyFix(
      { selector: fix.selector, attribute: fix.attribute, value: fix.name },
      source,
      sourceFile
    );
    if (!result.applied) throw new Error(result.detail);
    source = result.source;
  }

  const targetUrl = (await loadScenario(path.resolve(options.scenarioPath))).target.url;
  if (await answers(targetUrl)) {
    throw new Error(
      `Something already serves ${targetUrl}. Stop it, so the rerun sees the fix and nothing else.`
    );
  }

  const branch = `aee/fix-${path.basename(options.assessmentDir)}`;
  const worktree = path.join(os.tmpdir(), `aee-fix-${randomUUID()}`);
  git(repoRoot, ["worktree", "add", "--quiet", "-b", branch, worktree, "HEAD"]);
  let app: ChildProcess | undefined;
  let finished = false;
  try {
    await writeFile(path.join(worktree, relativeSource), source, "utf8");
    git(worktree, ["add", "--", relativeSource]);
    git(
      worktree,
      ["commit", "--quiet", "--file", "-"],
      commitMessage(fixes, report, path.basename(options.assessmentDir))
    );
    const commit = git(worktree, ["rev-parse", "HEAD"]);

    app = spawn(options.startCommand, {
      cwd: worktree,
      shell: true,
      detached: process.platform !== "win32",
      // Its output goes to stderr, so stdout stays the one JSON result.
      stdio: ["ignore", 2, 2]
    });
    await waitUntilAnswering(targetUrl, app);
    const rerun = await executeScenario(path.resolve(options.scenarioPath), {
      browser: options.browser,
      aiProvider: options.aiProvider,
      outputDir: options.outputDir
    });
    const verifications = await verifyAppliedFixes(rerun.reportFiles.json, fixes);
    finished = true;
    return {
      verdict: overallVerdict(verifications),
      branch,
      commit,
      fixes,
      verifications,
      rerun
    };
  } finally {
    if (app) await stop(app);
    git(repoRoot, ["worktree", "remove", "--force", worktree]);
    // A run that never reached a verdict leaves no branch behind, so it can simply be run again.
    if (!finished) git(repoRoot, ["branch", "-D", branch]);
  }
}

/** The finding and suggestion behind one accepted selector, and the name to apply. */
function resolveAccepted(report: ScenarioIntegratedReport, accepted: AcceptedFix): VerifiedFix {
  const finding = report.synthesis.findings.find(
    ({ ruleId, instances }) =>
      fixAttributeForRule(ruleId) &&
      instances.some(({ selector }) => selector === accepted.selector)
  );
  if (!finding) {
    throw new Error(
      `The assessment has no missing name or text alternative at ${accepted.selector} to fix.`
    );
  }
  const suggested = finding.remediation.ai.suggestions?.find(
    ({ selector }) => selector === accepted.selector
  )?.text;
  const name = accepted.name ?? suggested;
  if (!name?.trim()) {
    throw new Error(
      `No name was suggested for ${accepted.selector}. Give the one to use: --accept "${accepted.selector}=<name>".`
    );
  }
  return {
    ruleId: finding.ruleId,
    selector: accepted.selector,
    name,
    attribute: fixAttributeForRule(finding.ruleId)!,
    wordedBy: accepted.name === undefined || accepted.name === suggested ? "ai" : "reviewer"
  };
}

function commitMessage(
  fixes: VerifiedFix[],
  report: ScenarioIntegratedReport,
  assessmentId: string
): string {
  const ai = (ruleId: string) =>
    report.synthesis.findings.find((finding) => finding.ruleId === ruleId)?.remediation.ai;
  const lines = fixes.map((fix) => {
    const specialist = ai(fix.ruleId);
    const wording =
      fix.wordedBy === "ai"
        ? `worded by AI (${specialist?.specialistId ?? "specialist"} on ${specialist?.providerId ?? "a model"}), accepted by a reviewer`
        : "worded by a reviewer";
    return `- ${fix.ruleId} at ${fix.selector}: ${fix.attribute}="${fix.name}", ${wording}`;
  });
  const subject =
    fixes.length === 1
      ? `fix(a11y): name ${fixes[0]!.selector} "${fixes[0]!.name}"`
      : `fix(a11y): name ${fixes.length} elements`;
  return `${subject}\n\nApplied by aee fix from assessment ${assessmentId}:\n\n${lines.join("\n")}\n`;
}

function git(cwd: string, args: string[], input?: string): string {
  const result = spawnSync("git", args, { cwd, input, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

async function answers(url: string): Promise<boolean> {
  return fetch(url, { signal: AbortSignal.timeout(2_000) }).then(
    () => true,
    () => false
  );
}

async function waitUntilAnswering(url: string, app: ChildProcess): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (!(await answers(url))) {
    if (app.exitCode !== null) {
      throw new Error(`The start command exited with code ${app.exitCode} before ${url} answered.`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${url} did not answer within ${START_TIMEOUT_MS / 1000}s of the start command.`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/** Stops the start command and everything it started, such as a dev server under npm. */
async function stop(app: ChildProcess): Promise<void> {
  if (app.exitCode !== null || app.pid === undefined) return;
  const exited = new Promise((resolve) => app.once("exit", resolve));
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(app.pid), "/T", "/F"]);
  else process.kill(-app.pid, "SIGTERM");
  await exited;
}
