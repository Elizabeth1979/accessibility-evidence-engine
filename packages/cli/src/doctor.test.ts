import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { ModelServerCheck, ModelServerProviderName } from "@aee/ai-fixes";

import {
  aeeRequirements,
  checkAiPolicy,
  checkBrowser,
  checkNode,
  checkOutputFolder,
  checkOutputIgnored,
  checkPlaywright,
  checkRealReader,
  renderDoctorReport,
  runDoctor,
  type DoctorCheck,
  type StartedBrowser
} from "./doctor";

const requirements = { node: "^22.18.0 || >=24.11.0", playwright: "^1.65.1" };

/** The fix a failing check prints; a check that did not fail has none to give. */
function fixOf(check: DoctorCheck): string {
  assert.equal(check.status, "fail", check.detail);
  return check.status === "fail" ? check.fix : "";
}

const startedBrowser: StartedBrowser = { version: () => "140.0.7339.16", close: async () => {} };

test("the ranges come from @aee/cli's package.json, the ones npm checks", () => {
  const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "../package.json"), "utf8")) as {
    engines: { node: string };
    peerDependencies: Record<string, string>;
  };
  assert.deepEqual(aeeRequirements(), {
    node: manifest.engines.node,
    playwright: manifest.peerDependencies["@playwright/test"]
  });
});

test("Node.js inside the engines range passes; outside it fails with the install command", () => {
  for (const version of ["22.18.0", "24.11.0", "26.7.0"]) {
    assert.equal(checkNode(version, requirements.node).status, "ok", version);
  }
  for (const version of ["22.17.1", "23.11.0", "24.10.0", "20.19.0"]) {
    const check = checkNode(version, requirements.node);
    assert.match(check.detail, new RegExp(`${version.replaceAll(".", "\\.")} is outside`));
    assert.equal(
      fixOf(check),
      "Install the current Node.js LTS: nvm install --lts && nvm use --lts (or download it from https://nodejs.org/en/download)"
    );
  }
});

test("Playwright in range passes; missing or out of range fails with the npm install command", () => {
  assert.equal(checkPlaywright("1.65.1", requirements.playwright).status, "ok");
  assert.equal(checkPlaywright("1.70.0", requirements.playwright).status, "ok");

  const missing = checkPlaywright(undefined, requirements.playwright);
  assert.match(missing.detail, /not installed/);
  assert.equal(fixOf(missing), 'npm install --save-dev "@playwright/test@^1.65.1"');

  const old = checkPlaywright("1.50.0", requirements.playwright);
  assert.match(old.detail, /1\.50\.0 is outside AEE's range \^1\.65\.1/);
  assert.equal(fixOf(old), 'npm install --save-dev "@playwright/test@^1.65.1"');
});

test("a browser that starts passes and is closed again", async () => {
  let closed = false;
  const check = await checkBrowser(
    async () => ({ ...startedBrowser, close: async () => void (closed = true) }),
    "darwin",
    requirements.playwright
  );
  assert.equal(check.status, "ok");
  assert.match(check.detail, /Chromium 140\.0\.7339\.16 starts headless/);
  assert.equal(closed, true);
});

test("a browser that cannot start fails with Playwright's reason and its install command", async () => {
  const launch = async (): Promise<StartedBrowser> => {
    throw new Error(
      "browserType.launch: Executable doesn't exist at /cache/chrome-headless-shell\n╔═══ Looks like Playwright was just installed"
    );
  };
  const mac = await checkBrowser(launch, "darwin", requirements.playwright);
  assert.equal(
    mac.detail,
    "Chromium did not start: browserType.launch: Executable doesn't exist at /cache/chrome-headless-shell"
  );
  assert.equal(fixOf(mac), "npx playwright install chromium");
  // On Linux the system libraries Chromium needs come with it, as Playwright's guide says.
  assert.equal(
    fixOf(await checkBrowser(launch, "linux", requirements.playwright)),
    "npx playwright install --with-deps chromium"
  );
});

test("without Playwright the browser check fails with both install commands", async () => {
  const check = await checkBrowser(undefined, "darwin", requirements.playwright);
  assert.equal(
    fixOf(check),
    'npm install --save-dev "@playwright/test@^1.65.1" && npx playwright install chromium'
  );
});

test("an output folder that exists, or can be created, passes; nothing is created to check", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aee-doctor-"));
  const existing = path.join(workspace, "aee-output");
  await mkdir(existing);
  const ready = await checkOutputFolder(existing, "darwin");
  assert.equal(ready.status, "ok");
  assert.equal(ready.detail, `${existing} can be written to.`);

  const later = path.join(workspace, "reports", "scenarios");
  const created = await checkOutputFolder(later, "darwin");
  assert.equal(created.status, "ok");
  assert.equal(
    created.detail,
    `${later} does not exist yet; aee run will create it in ${workspace}.`
  );
  await assert.rejects(stat(path.join(workspace, "reports")), { code: "ENOENT" });
});

test("an output folder in the way of a file, or that cannot be written, fails with the command", async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "aee-doctor-"));
  const file = path.join(workspace, "aee-output");
  await writeFile(file, "not a folder");
  const blocked = await checkOutputFolder(path.join(file, "scenarios"), "darwin");
  assert.match(blocked.detail, /is a file/);
  assert.equal(
    fixOf(blocked),
    `mv "${file}" "${file}.old", or give aee run a folder you can write to: --output <folder>`
  );

  const readOnly = {
    stat,
    access: async () => {
      throw Object.assign(new Error("permission denied"), { code: "EACCES" });
    }
  };
  const denied = await checkOutputFolder(workspace, "linux", readOnly);
  assert.match(denied.detail, /cannot be written to/);
  assert.equal(
    fixOf(denied),
    `chmod u+w "${workspace}", or give aee run a folder you can write to: --output <folder>`
  );
  assert.match(
    fixOf(await checkOutputFolder(workspace, "win32", readOnly)),
    /^icacls ".+" \/grant "\$\(\$env:USERNAME\):\(OI\)\(CI\)M", or give aee run/
  );
});

test("git is asked whether reports would be committed; a folder it would commit is information", async () => {
  const run = promisify(execFile);
  const repository = await mkdtemp(path.join(os.tmpdir(), "aee-doctor-git-"));
  await run("git", ["init", "--quiet"], { cwd: repository });
  const outputDir = path.join(repository, "aee-output");

  const committed = await checkOutputIgnored(outputDir, repository);
  assert.equal(committed.status, "info");
  assert.equal(
    committed.status === "info" ? committed.optional : undefined,
    `Add it to .gitignore: echo "/aee-output/" >> "${path.join(await realRoot(repository), ".gitignore")}"`
  );

  await writeFile(path.join(repository, ".gitignore"), "aee-output/\n");
  const ignored = await checkOutputIgnored(outputDir, repository);
  assert.equal(ignored.status, "ok");
  assert.match(ignored.detail, /git ignores aee-output/);

  const loose = await mkdtemp(path.join(os.tmpdir(), "aee-doctor-no-git-"));
  const outside = await checkOutputIgnored(path.join(loose, "aee-output"), loose);
  assert.equal(outside.status, "ok");
  assert.match(outside.detail, /Not in a git repository/);
});

/** The repository root as git prints it: on macOS the temporary folder is under a symlink. */
async function realRoot(repository: string): Promise<string> {
  const { stdout } = await promisify(execFile)("git", ["rev-parse", "--show-toplevel"], {
    cwd: repository
  });
  return stdout.trim();
}

/** A model server that answers as told, recording what it was asked. */
function fakeServer(answer: ModelServerCheck) {
  const asked: ModelServerProviderName[] = [];
  return {
    asked,
    check: async (provider: ModelServerProviderName) => {
      asked.push(provider);
      return answer;
    }
  };
}

test("with no model named, AI is off: information on how to turn it on, and no server is asked", async () => {
  const server = fakeServer({ status: "ready", model: "never-asked" });
  for (const env of [
    {},
    { AEE_LLM_PROVIDER: "stub" },
    // "auto" with no Anthropic key is the stub too.
    { AEE_LLM_PROVIDER: "auto" },
    // A key that happens to be set is not consent: aee run names no model without AEE_LLM_PROVIDER.
    { ANTHROPIC_API_KEY: "a-key" }
  ]) {
    const check = await checkAiPolicy(env, "darwin", server.check);
    assert.equal(check.status, "info", JSON.stringify(env));
    assert.match(check.detail, /^Off: aee run sends no page evidence to any model/);
    assert.equal(
      check.status === "info" ? check.optional : undefined,
      "export AEE_LLM_PROVIDER=local for a model on this machine (Ollama with gemma4:e4b), or export AEE_LLM_PROVIDER=claude with ANTHROPIC_API_KEY"
    );
  }
  assert.deepEqual(server.asked, []);
});

test("a provider name AEE does not know fails, naming the ones it does", async () => {
  const check = await checkAiPolicy({ AEE_LLM_PROVIDER: "gemini" }, "darwin");
  assert.match(check.detail, /AEE_LLM_PROVIDER must be one of auto, claude, openai, local, stub/);
  assert.equal(
    fixOf(check),
    "export AEE_LLM_PROVIDER=local (or claude, openai), or unset AEE_LLM_PROVIDER to keep AI off"
  );
});

test("a named model that answers passes, and says where the evidence goes", async () => {
  const local = await checkAiPolicy(
    { AEE_LLM_PROVIDER: "local" },
    "darwin",
    fakeServer({ status: "ready", model: "gemma4:e4b" }).check
  );
  assert.equal(local.status, "ok");
  assert.match(
    local.detail,
    /asks gemma4:e4b, and the evidence .* goes to this machine \(Ollama\)/
  );
  assert.match(local.detail, /labelled AI, needs review, and never passes or fails anything/);

  // "auto" with an Anthropic key is Claude, as createModelProvider chooses.
  const server = fakeServer({ status: "ready", model: "claude-opus-newer" });
  const claude = await checkAiPolicy(
    { AEE_LLM_PROVIDER: "auto", ANTHROPIC_API_KEY: "a-key" },
    "darwin",
    server.check
  );
  assert.deepEqual(server.asked, ["claude"]);
  assert.match(claude.detail, /asks claude-opus-newer, and the evidence .* goes to Anthropic/);
});

test("a named model that cannot answer fails with the command for its cause", async () => {
  const cases: Array<[Record<string, string>, ModelServerCheck, string]> = [
    [
      { AEE_LLM_PROVIDER: "local" },
      { status: "unreachable", message: "Connection error." },
      "ollama serve (install Ollama first from https://ollama.com/download)"
    ],
    [
      { AEE_LLM_PROVIDER: "local" },
      { status: "model-missing", model: "gemma4:e4b", available: ["llama3.2:latest"] },
      "ollama pull gemma4:e4b"
    ],
    [
      { AEE_LLM_PROVIDER: "local", AEE_LLM_BASE_URL: "http://127.0.0.1:1234/v1" },
      { status: "unreachable", message: "Connection error." },
      "Start the model server at http://127.0.0.1:1234/v1, or correct AEE_LLM_BASE_URL"
    ],
    [
      { AEE_LLM_PROVIDER: "claude" },
      { status: "failed", message: "Could not resolve authentication method." },
      "export ANTHROPIC_API_KEY=<your key> (create one at https://console.anthropic.com/settings/keys)"
    ],
    [
      { AEE_LLM_PROVIDER: "claude", AEE_LLM_MODEL: "claude-opus-typo" },
      { status: "model-missing", model: "claude-opus-typo", available: ["claude-opus-newer"] },
      "export AEE_LLM_MODEL=<model> (it has claude-opus-newer), or unset AEE_LLM_MODEL for the newest Opus"
    ],
    [
      { AEE_LLM_PROVIDER: "openai", OPENAI_API_KEY: "a-key" },
      { status: "model-missing", model: undefined, available: ["gpt-a", "gpt-b"] },
      "export AEE_LLM_MODEL=<model> (it has gpt-a, gpt-b)"
    ],
    [
      { AEE_LLM_PROVIDER: "openai" },
      { status: "failed", message: "OPENAI_API_KEY is not set." },
      "export OPENAI_API_KEY=<your key> (create one at https://platform.openai.com/api-keys)"
    ]
  ];
  for (const [env, answer, fix] of cases) {
    const check = await checkAiPolicy(env, "darwin", fakeServer(answer).check);
    // AI stays optional: every fix also says how to turn it off instead.
    assert.equal(fixOf(check), `${fix}; or unset AEE_LLM_PROVIDER to keep AI off`, fix);
  }
});

test("on Windows the fixes are PowerShell commands", async () => {
  const check = await checkAiPolicy(
    { AEE_LLM_PROVIDER: "claude" },
    "win32",
    fakeServer({ status: "failed", message: "401" }).check
  );
  assert.equal(
    fixOf(check),
    '$env:ANTHROPIC_API_KEY="<your key>" (create one at https://console.anthropic.com/settings/keys); or Remove-Item Env:AEE_LLM_PROVIDER to keep AI off'
  );
});

test("a real screen reader is information on every platform, never a failure", () => {
  const missing = checkRealReader("darwin", undefined);
  assert.equal(missing.status, "info");
  assert.match(missing.detail, /Not set up, and not needed: AEE's virtual reader runs here/);
  assert.match(missing.detail, /with VoiceOver/);

  const ready = checkRealReader("win32", "0.36.4");
  assert.equal(ready.status, "info");
  assert.match(ready.detail, /Guidepup 0\.36\.4 can drive NVDA here/);
  assert.equal(checkRealReader("linux", "0.36.4").detail.includes("Orca"), true);
  assert.equal(checkRealReader("freebsd", undefined).status, "info");
});

const readyOptions = {
  cwd: os.tmpdir(),
  env: {},
  platform: "darwin" as const,
  nodeVersion: "24.11.0",
  launchBrowser: async () => startedBrowser,
  playwrightVersion: "1.65.1",
  guidepupVersion: undefined,
  requirements
};

test("a machine is ready when nothing fails; optional AI and readers are notes, not failures", async () => {
  const outputDir = path.join(await mkdtemp(path.join(os.tmpdir(), "aee-doctor-")), "aee-output");
  const report = await runDoctor({ ...readyOptions, outputDir });
  assert.equal(report.ready, true);
  assert.deepEqual(
    report.checks.map(({ id }) => id),
    ["node", "playwright", "browser", "output", "git", "ai", "reader"]
  );
  const text = renderDoctorReport(report);
  assert.match(text, /^ok {4}Node\.js {13}24\.11\.0, within AEE's range/m);
  assert.match(text, /^info {2}AI suggestions/m);
  assert.match(text, /Ready: every check passed\. 2 notes for what is optional\.\n$/);
  assert.doesNotMatch(text, /FAIL|Fix:/);
});

test("one failing check makes the machine not ready, and its fix is printed under it", async () => {
  const outputDir = path.join(await mkdtemp(path.join(os.tmpdir(), "aee-doctor-")), "aee-output");
  const report = await runDoctor({
    ...readyOptions,
    outputDir,
    launchBrowser: undefined,
    playwrightVersion: undefined
  });
  assert.equal(report.ready, false);
  const text = renderDoctorReport(report);
  assert.match(
    text,
    /^FAIL {2}Playwright {10}@playwright\/test is not installed.*\n {26}Fix: npm install --save-dev "@playwright\/test@\^1\.65\.1"$/m
  );
  assert.match(text, /Not ready: 2 checks failed\. Run each Fix, then aee doctor again\.\n$/);
  // The JSON is the same report, for scripts and CI.
  const json = JSON.parse(JSON.stringify(report)) as { ready: boolean; checks: DoctorCheck[] };
  assert.equal(json.checks.filter(({ status }) => status === "fail").length, 2);
});

test("starting aee loads no Playwright, so aee doctor can still say it is missing", async () => {
  const probe = `
    require(${JSON.stringify(path.join(__dirname, "index.js"))});
    const playwright = /[\\\\/]node_modules[\\\\/](@playwright[\\\\/]test|playwright(-core)?)[\\\\/]/;
    process.stdout.write(String(Object.keys(require.cache).some((file) => playwright.test(file))));
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", probe]);
  assert.equal(stdout, "false");
});
