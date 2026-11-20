import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

import {
  checkModelServer,
  DEFAULT_LOCAL_BASE_URL,
  parseModelProviderName,
  type CheckModelServerOptions,
  type ModelServerCheck,
  type ModelServerProviderName
} from "@aee/ai-fixes";
import semver from "semver";

/**
 * One line of `aee doctor`. A failing check always says how to fix it; information never fails,
 * and may say how to turn something optional on.
 */
export type DoctorCheck = { id: DoctorCheckId; title: string; detail: string } & (
  { status: "ok" } | { status: "fail"; fix: string } | { status: "info"; optional?: string }
);

export type DoctorCheckId = "node" | "playwright" | "browser" | "output" | "git" | "ai" | "reader";

export interface DoctorReport {
  /** True when no check failed; information does not count against it. */
  ready: boolean;
  checks: DoctorCheck[];
}

/** What `aee` needs, from `@aee/cli`'s own package.json, so the doctor and npm read one range. */
export interface AeeRequirements {
  node: string;
  playwright: string;
}

export function aeeRequirements(): AeeRequirements {
  const manifest = JSON.parse(readFileSync(path.join(__dirname, "..", "package.json"), "utf8")) as {
    engines: { node: string };
    peerDependencies: { "@playwright/test": string };
  };
  return { node: manifest.engines.node, playwright: manifest.peerDependencies["@playwright/test"] };
}

/** How to set or clear an environment variable in the shell people use on this platform. */
function setVariable(name: string, value: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `$env:${name}="${value}"` : `export ${name}=${value}`;
}

function unsetVariable(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? `Remove-Item Env:${name}` : `unset ${name}`;
}

function firstLine(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).split("\n")[0]!.trim();
}

/** Node.js against `engines.node`, compared by `semver`, the parser npm itself checks engines with. */
export function checkNode(version: string, range: string): DoctorCheck {
  const title = "Node.js";
  if (semver.satisfies(version, range)) {
    return { id: "node", title, status: "ok", detail: `${version}, within AEE's range ${range}.` };
  }
  return {
    id: "node",
    title,
    status: "fail",
    detail: `${version} is outside AEE's range ${range}.`,
    fix: "Install the current Node.js LTS: nvm install --lts && nvm use --lts (or download it from https://nodejs.org/en/download)"
  };
}

/** The installed `@playwright/test` version, resolved from here, as `aee run` imports it. */
export function installedPlaywrightVersion(): string | undefined {
  let manifestPath: string;
  try {
    manifestPath = require.resolve("@playwright/test/package.json");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return undefined;
    throw error;
  }
  return (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version;
}

function installPlaywright(range: string): string {
  return `npm install --save-dev "@playwright/test@${range}"`;
}

/** `@playwright/test`, AEE's peer dependency, against the range AEE is tested with. */
export function checkPlaywright(version: string | undefined, range: string): DoctorCheck {
  const title = "Playwright";
  if (version && semver.satisfies(version, range)) {
    return {
      id: "playwright",
      title,
      status: "ok",
      detail: `@playwright/test ${version}, within AEE's range ${range}.`
    };
  }
  return {
    id: "playwright",
    title,
    status: "fail",
    detail: version
      ? `@playwright/test ${version} is outside AEE's range ${range}.`
      : "@playwright/test is not installed, so aee run cannot drive a browser.",
    fix: installPlaywright(range)
  };
}

/** A browser that was started, as much of Playwright's `Browser` as the check uses. */
export interface StartedBrowser {
  version(): string;
  close(): Promise<void>;
}

function installBrowser(platform: NodeJS.Platform): string {
  // Playwright's own guide: on Linux, --with-deps also installs the system libraries Chromium needs.
  return platform === "linux"
    ? "npx playwright install --with-deps chromium"
    : "npx playwright install chromium";
}

/**
 * Starts Chromium exactly as `aee run` does and closes it again. Without Playwright there is
 * nothing to start it with, so the fix installs both.
 */
export async function checkBrowser(
  launch: (() => Promise<StartedBrowser>) | undefined,
  platform: NodeJS.Platform,
  playwrightRange: string
): Promise<DoctorCheck> {
  const title = "Browser";
  if (!launch) {
    return {
      id: "browser",
      title,
      status: "fail",
      detail: "Chromium cannot be started without Playwright.",
      fix: `${installPlaywright(playwrightRange)} && ${installBrowser(platform)}`
    };
  }
  let browser: StartedBrowser;
  try {
    browser = await launch();
  } catch (error) {
    return {
      id: "browser",
      title,
      status: "fail",
      detail: `Chromium did not start: ${firstLine(error)}`,
      fix: installBrowser(platform)
    };
  }
  const version = browser.version();
  await browser.close();
  return {
    id: "browser",
    title,
    status: "ok",
    detail: `Chromium ${version} starts headless, as aee run starts it.`
  };
}

/** The file system calls the output check makes, so a test can stand in for a read-only disk. */
export interface OutputFolderFs {
  stat: typeof stat;
  access: typeof access;
}

/**
 * The folder `aee run` writes to: a folder it can write in, or, before the first run, the nearest
 * existing folder above it, where `aee run` will create it. Nothing is created or changed here.
 */
export async function checkOutputFolder(
  outputDir: string,
  platform: NodeJS.Platform,
  fs: OutputFolderFs = { stat, access }
): Promise<DoctorCheck> {
  const title = "Output folder";
  const otherFolder = "or give aee run a folder you can write to: --output <folder>";
  let existing = outputDir;
  for (;;) {
    try {
      const found = await fs.stat(existing);
      if (!found.isDirectory()) {
        return {
          id: "output",
          title,
          status: "fail",
          detail: `${existing} is a file, so aee run cannot write ${outputDir}.`,
          fix: `${platform === "win32" ? "Rename-Item" : "mv"} "${existing}" "${existing}.old", ${otherFolder}`
        };
      }
      break;
    } catch (error) {
      // ENOTDIR: a file is on the way down, which the next folder up finds and reports.
      const { code } = error as NodeJS.ErrnoException;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  try {
    await fs.access(existing, constants.W_OK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EACCES") throw error;
    return {
      id: "output",
      title,
      status: "fail",
      detail: `${existing} cannot be written to, so aee run cannot write ${outputDir}.`,
      fix:
        platform === "win32"
          ? `icacls "${existing}" /grant "$($env:USERNAME):(OI)(CI)M", ${otherFolder}`
          : `chmod u+w "${existing}", ${otherFolder}`
    };
  }
  return {
    id: "output",
    title,
    status: "ok",
    detail:
      existing === outputDir
        ? `${outputDir} can be written to.`
        : `${outputDir} does not exist yet; aee run will create it in ${existing}.`
  };
}

const execFileAsync = promisify(execFile);

/**
 * Whether git would leave the reports out of a commit, asked of git itself (`git check-ignore`).
 * Reports can hold the page's content, so a folder git would commit is worth knowing about; it is
 * information, since a run works either way.
 */
export async function checkOutputIgnored(outputDir: string, cwd: string): Promise<DoctorCheck> {
  const title = "Reports in git";
  const git = async (...args: string[]) =>
    (await execFileAsync("git", args, { cwd: root ?? cwd })).stdout.trim();
  let root: string | undefined;
  let prefix: string;
  try {
    // git says where the working folder is in the repository, so a symlinked path cannot mislead.
    [root, prefix = ""] = (await git("rev-parse", "--show-toplevel", "--show-prefix")).split("\n");
  } catch (error) {
    // 128 is git's own "not a repository"; ENOENT is no git at all. Either way nothing is committed.
    const { code } = error as { code?: number | string };
    if (code !== 128 && code !== "ENOENT") throw error;
    return {
      id: "git",
      title,
      status: "ok",
      detail: "Not in a git repository, so reports cannot be committed by accident."
    };
  }
  const inRepository = path.posix.normalize(
    `${prefix}${path.relative(cwd, outputDir).split(path.sep).join("/")}`
  );
  if (inRepository === ".." || inRepository.startsWith("../")) {
    return {
      id: "git",
      title,
      status: "ok",
      detail: `${outputDir} is outside the git repository, so reports cannot be committed by accident.`
    };
  }
  try {
    // A file inside the folder: git matches a pattern such as `aee-output/` only to a folder it knows.
    await git("check-ignore", "--quiet", "--", `${inRepository}/report.json`);
    return {
      id: "git",
      title,
      status: "ok",
      detail: `git ignores ${inRepository}, so reports stay out of commits.`
    };
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
    return {
      id: "git",
      title,
      status: "info",
      detail: `git would commit ${outputDir}; reports can hold the page's content.`,
      optional: `Add it to .gitignore: echo "/${inRepository}/" >> "${path.join(root, ".gitignore")}"`
    };
  }
}

/** Where the evidence goes when a provider answers. */
function destination(provider: ModelServerProviderName, env: Record<string, string | undefined>) {
  if (provider === "claude") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  return env.AEE_LLM_BASE_URL ? env.AEE_LLM_BASE_URL : "this machine (Ollama)";
}

function aiFix(
  provider: ModelServerProviderName,
  check: Exclude<ModelServerCheck, { status: "ready" }>,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform
): string {
  const set = (name: string, value: string) => setVariable(name, value, platform);
  const ownServer = env.AEE_LLM_BASE_URL ?? DEFAULT_LOCAL_BASE_URL;
  const api = provider === "claude" ? "https://api.anthropic.com" : "https://api.openai.com";
  const someOf = (models: string[]) =>
    models.length
      ? ` (it has ${models.slice(0, 5).join(", ")}${models.length > 5 ? ", …" : ""})`
      : "";
  switch (check.status) {
    case "unreachable":
      if (provider === "local") {
        return env.AEE_LLM_BASE_URL
          ? `Start the model server at ${ownServer}, or correct AEE_LLM_BASE_URL`
          : "ollama serve (install Ollama first from https://ollama.com/download)";
      }
      return `Check this machine can reach ${api}: curl -sI ${api}`;
    case "model-missing":
      if (provider === "local" && !env.AEE_LLM_BASE_URL) return `ollama pull ${check.model}`;
      if (!check.model) return `${set("AEE_LLM_MODEL", "<model>")}${someOf(check.available)}`;
      return provider === "claude"
        ? `${set("AEE_LLM_MODEL", "<model>")}${someOf(check.available)}, or ${unsetVariable("AEE_LLM_MODEL", platform)} for the newest Opus`
        : `${set("AEE_LLM_MODEL", "<model>")}${someOf(check.available)}, or load ${check.model} in ${ownServer}`;
    case "failed":
      if (provider === "claude") {
        return `${set("ANTHROPIC_API_KEY", "<your key>")} (create one at https://console.anthropic.com/settings/keys)`;
      }
      if (provider === "openai") {
        return `${set("OPENAI_API_KEY", "<your key>")} (create one at https://platform.openai.com/api-keys)`;
      }
      return `${set("AEE_LLM_API_KEY", "<the server's key>")}, or check the server at ${ownServer}`;
  }
}

/**
 * What `aee run` would do with page evidence, by the rule `aeeRunModelProvider` follows: nothing is
 * sent unless AEE_LLM_PROVIDER names a model. With one named, its server is asked for its model
 * list (no evidence is sent), so a missing key or model shows here rather than in a report. AI is
 * optional, so AI that is off is information; AI that was asked for and cannot answer fails.
 */
export async function checkAiPolicy(
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  checkServer: (
    provider: ModelServerProviderName,
    options: CheckModelServerOptions
  ) => Promise<ModelServerCheck> = checkModelServer
): Promise<DoctorCheck> {
  const title = "AI suggestions";
  const turnOn = `${setVariable("AEE_LLM_PROVIDER", "local", platform)} for a model on this machine (Ollama with gemma4:e4b), or ${setVariable("AEE_LLM_PROVIDER", "claude", platform)} with ANTHROPIC_API_KEY`;
  const turnOff = `${unsetVariable("AEE_LLM_PROVIDER", platform)} to keep AI off`;
  let name: ReturnType<typeof parseModelProviderName>;
  try {
    name = parseModelProviderName(env.AEE_LLM_PROVIDER);
  } catch (error) {
    return {
      id: "ai",
      title,
      status: "fail",
      detail: firstLine(error),
      fix: `${setVariable("AEE_LLM_PROVIDER", "local", platform)} (or claude, openai), or ${turnOff}`
    };
  }
  const hasClaudeKey = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN);
  const provider = name === "auto" && hasClaudeKey ? "claude" : name;
  if (provider === undefined || provider === "stub" || provider === "auto") {
    return {
      id: "ai",
      title,
      status: "info",
      detail:
        "Off: aee run sends no page evidence to any model, and its reports say where AI could suggest wording.",
      optional: turnOn
    };
  }
  const check = await checkServer(provider, { env });
  if (check.status === "ready") {
    return {
      id: "ai",
      title,
      status: "ok",
      detail: `On: aee run asks ${check.model}, and the evidence of allowlisted findings goes to ${destination(provider, env)}. Every suggestion is labelled AI, needs review, and never passes or fails anything.`
    };
  }
  const detail =
    check.status === "model-missing"
      ? check.model
        ? `AEE_LLM_PROVIDER=${env.AEE_LLM_PROVIDER} asks for ${check.model}, which the server does not have.`
        : `AEE_LLM_PROVIDER=${env.AEE_LLM_PROVIDER} needs AEE_LLM_MODEL to name a model.`
      : `AEE_LLM_PROVIDER=${env.AEE_LLM_PROVIDER}, but the model server ${check.status === "unreachable" ? "did not answer" : "refused"}: ${firstLine(check.message)}`;
  return {
    id: "ai",
    title,
    status: "fail",
    detail,
    fix: `${aiFix(provider, check, env, platform)}; or ${turnOff}`
  };
}

/** The real reader Guidepup drives on each platform (README, "Screen readers on video, and real ones"). */
const REAL_READERS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "VoiceOver",
  win32: "NVDA",
  linux: "Orca"
};

/** Where the project's Guidepup is, if it has one: the real reader is the project's, not `aee`'s. */
export function installedGuidepupVersion(cwd: string): string | undefined {
  try {
    const manifestPath = require.resolve("@guidepup/guidepup/package.json", { paths: [cwd] });
    return (JSON.parse(readFileSync(manifestPath, "utf8")) as { version: string }).version;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "MODULE_NOT_FOUND") return undefined;
    throw error;
  }
}

/**
 * A real screen reader is optional: AEE's virtual reader runs everywhere, and a real one only
 * compares with it. So this is always information, never a failure.
 */
export function checkRealReader(
  platform: NodeJS.Platform,
  guidepupVersion: string | undefined
): DoctorCheck {
  const title = "Real screen reader";
  const reader = REAL_READERS[platform];
  if (!reader) {
    return {
      id: "reader",
      title,
      status: "info",
      detail: `Guidepup drives no screen reader on ${platform}; AEE's virtual reader runs here.`
    };
  }
  const setup =
    platform === "darwin"
      ? 'npx @guidepup/setup setup, then the steps in the README\'s "Screen readers on video, and real ones"'
      : platform === "win32"
        ? "npx guidepup install (from @guidepup/setup), which downloads the portable NVDA"
        : "install Orca with your distribution's package manager";
  if (!guidepupVersion) {
    return {
      id: "reader",
      title,
      status: "info",
      detail: `Not set up, and not needed: AEE's virtual reader runs here. Guidepup can compare it with ${reader} (npm run readers:compare in the AEE repository).`,
      optional: `npm install --save-dev @guidepup/guidepup @guidepup/setup, then ${setup}`
    };
  }
  return {
    id: "reader",
    title,
    status: "info",
    detail: `Guidepup ${guidepupVersion} can drive ${reader} here; the operating system asks for permission on its first run.`,
    optional: setup
  };
}

export interface DoctorOptions {
  /** The folder `aee run` would write to, resolved. */
  outputDir: string;
  cwd: string;
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  nodeVersion: string;
  /** Starts the browser as `aee run` does; undefined when Playwright is not installed. */
  launchBrowser: (() => Promise<StartedBrowser>) | undefined;
  playwrightVersion: string | undefined;
  guidepupVersion: string | undefined;
  requirements: AeeRequirements;
}

/** Every check, in the order a setup is fixed: Node, Playwright, the browser, then what is optional. */
export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const { platform, requirements } = options;
  const checks = [
    checkNode(options.nodeVersion, requirements.node),
    checkPlaywright(options.playwrightVersion, requirements.playwright),
    ...(await Promise.all([
      checkBrowser(options.launchBrowser, platform, requirements.playwright),
      checkOutputFolder(options.outputDir, platform),
      checkOutputIgnored(options.outputDir, options.cwd),
      checkAiPolicy(options.env, platform)
    ])),
    checkRealReader(platform, options.guidepupVersion)
  ];
  return { ready: checks.every(({ status }) => status !== "fail"), checks };
}

const STATUS_WORDS = { ok: "ok", fail: "FAIL", info: "info" } as const;

/**
 * The report as words, one check a line: the status is a word, not a colour or a symbol, so it
 * reads the same in a screen reader, a log and a monochrome terminal.
 */
export function renderDoctorReport({ ready, checks }: DoctorReport): string {
  const width = Math.max(...checks.map(({ title }) => title.length));
  const indent = " ".repeat(6 + width + 2);
  const lines = ["aee doctor", ""];
  for (const check of checks) {
    lines.push(
      `${STATUS_WORDS[check.status].padEnd(6)}${check.title.padEnd(width)}  ${check.detail}`
    );
    if (check.status === "fail") lines.push(`${indent}Fix: ${check.fix}`);
    if (check.status === "info" && check.optional)
      lines.push(`${indent}Optional: ${check.optional}`);
  }
  const failed = checks.filter(({ status }) => status === "fail").length;
  const notes = checks.filter(({ status }) => status === "info").length;
  const noteText = notes ? ` ${notes} note${notes === 1 ? "" : "s"} for what is optional.` : "";
  lines.push(
    "",
    ready
      ? `Ready: every check passed.${noteText}`
      : `Not ready: ${failed} check${failed === 1 ? "" : "s"} failed. Run each Fix, then aee doctor again.`
  );
  return `${lines.join("\n")}\n`;
}
