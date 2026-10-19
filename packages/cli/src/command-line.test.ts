import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { after, before } from "node:test";

import { COMMANDS, parseCommandLine, usage, type CommandLine } from "./command-line";

const cliPath = path.resolve(__dirname, "index.js");
const examples = path.resolve(__dirname, "../../../examples");
const approvedScenario = path.join(examples, "public-site/scenario.yml");

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs the built `aee` as a person would, without the GitHub Actions variables, so `aee comment`
 * never writes to a real job summary or pull request.
 */
async function aee(args: string[], cwd = workspace): Promise<CliResult> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GITHUB_"))
  );
  return promisify(execFile)(process.execPath, [cliPath, ...args], { cwd, env }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error: unknown) => {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return { code: failed.code ?? 1, stdout: failed.stdout ?? "", stderr: failed.stderr ?? "" };
    }
  );
}

let workspace = "";
let reports = "";
let moreReports = "";
/** The public-site example without its approval, so `aee run` stops before opening a browser. */
let unapprovedScenario = "";
/** A copy of the JSON fixture config, so its run writes evidence into the temporary folder. */
let fixtureConfig = "";

before(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "aee-command-line-"));
  reports = path.join(workspace, "reports");
  moreReports = path.join(workspace, "more-reports");
  await mkdir(reports);
  await mkdir(moreReports);
  unapprovedScenario = path.join(workspace, "scenario.yml");
  await writeFile(
    unapprovedScenario,
    (await readFile(approvedScenario, "utf8")).replace(/^\s{2}approvedPlanDigest:.*\n/m, ""),
    "utf8"
  );
  fixtureConfig = path.join(workspace, "config.json");
  const config = JSON.parse(
    await readFile(path.join(examples, "basic-run-config.json"), "utf8")
  ) as Record<string, unknown>;
  await writeFile(fixtureConfig, JSON.stringify({ ...config, projectRoot: "." }), "utf8");
  await copyFile(
    path.join(examples, "basic-fixture.json"),
    path.join(workspace, "basic-fixture.json")
  );
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

/** `aee run` read every option: it went on to check the plan's approval. */
const refusedOnlyForApproval = /Cannot run scenario “public-site-homepage”/;

// Command lines that work today keep working exactly as before.

test("aee with no command lists every command", async () => {
  const { code, stderr } = await aee([]);
  assert.equal(code, 1);
  for (const command of ["plan", "run", "comment", "fix"]) {
    assert.match(stderr, new RegExp(`aee ${command} `));
  }
});

test("aee plan prints the plan, or its JSON with --json, given once or twice", async () => {
  const text = await aee(["plan", approvedScenario]);
  assert.equal(text.code, 0);
  assert.match(text.stdout, /Readiness: READY/);

  for (const args of [
    ["plan", approvedScenario, "--json"],
    ["plan", approvedScenario, "--json", "--json"]
  ]) {
    const json = await aee(args);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(
      (JSON.parse(json.stdout) as { scenarioId: string }).scenarioId,
      "public-site-homepage"
    );
  }

  const missing = await aee(["plan"]);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /Usage: aee plan <scenario\.yml> \[--json\]/);
});

test("aee run reads --open, --ci and --output in any order, and the scenario path alone", async () => {
  for (const args of [
    ["run", unapprovedScenario],
    ["run", unapprovedScenario, "--ci"],
    ["run", unapprovedScenario, "--open", "--ci", "--output", "out"],
    ["run", unapprovedScenario, "--output", "first", "--output", "second", "--ci"],
    [unapprovedScenario, "--ci", "--output", "out"]
  ]) {
    const { code, stderr } = await aee(args);
    assert.equal(code, 1, args.join(" "));
    assert.match(stderr, refusedOnlyForApproval, args.join(" "));
  }
});

test("aee run refuses --output without a directory, and a misspelt option", async () => {
  for (const args of [
    ["run", unapprovedScenario, "--output"],
    ["run", unapprovedScenario, "--output", "--ci"]
  ]) {
    const { code, stderr } = await aee(args);
    assert.equal(code, 1);
    assert.match(stderr, /--output/);
    assert.doesNotMatch(stderr, refusedOnlyForApproval);
  }
  const misspelt = await aee(["run", unapprovedScenario, "--outptu", "out"]);
  assert.equal(misspelt.code, 1);
  assert.match(misspelt.stderr, /--outptu/);
});

test("aee run <config.json> runs the JSON fixture config, with or without the word run", async () => {
  for (const args of [["run", fixtureConfig], [fixtureConfig]]) {
    const { code, stdout, stderr } = await aee(args);
    assert.equal(code, 0, stderr);
    assert.match((JSON.parse(stdout) as { runId: string }).runId, /^run-\d+$/);
  }
});

test("aee comment reads its folders and options in any order", async () => {
  // With no assessment the verdict is unknown: that passes --fail-on blocking and never, and fails
  // --fail-on incomplete.
  const cases: [string[], RegExp, number][] = [
    [["comment", reports], /0 assessments, verdict unknown, fail-on blocking\.\n$/, 0],
    [["comment", reports, "--fail-on", "never"], /fail-on never\.\n$/, 0],
    [["comment", "--fail-on", "incomplete", reports, moreReports], /fail-on incomplete\.\n$/, 1],
    [["comment", reports, "--fail-on", "incomplete", "--fail-on", "never"], /fail-on never/, 0],
    [["comment", reports, "--post"], /Not posted: posting needs a pull_request event/, 0],
    [["comment", "--post", "--images", reports, moreReports], /Not posted/, 0],
    // The Action passes its `reports` input even when it is empty: that reads the working folder.
    [["comment", reports, ""], /0 assessments/, 0]
  ];
  for (const [args, expected, exitCode] of cases) {
    const { code, stdout, stderr } = await aee(args);
    assert.equal(code, exitCode, `${args.join(" ")}: ${stderr}`);
    assert.match(stdout, /^<!-- aee-pr-comment -->/);
    assert.match(stderr, expected, args.join(" "));
  }
});

test("aee comment refuses a missing folder, a wrong --fail-on and --images without --post", async () => {
  const cases: [string[], RegExp][] = [
    [["comment"], /Usage: aee comment <folder>\.\.\./],
    [
      ["comment", reports, "--fail-on", "sometimes"],
      /--fail-on must be one of blocking, incomplete, never\./
    ],
    [["comment", reports, "--fail-on"], /--fail-on/],
    [["comment", reports, "--images"], /--images needs --post/],
    [["comment", reports, "--pots"], /--pots/]
  ];
  for (const [args, expected] of cases) {
    const { code, stdout, stderr } = await aee(args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(stdout, "");
    assert.match(stderr, expected, args.join(" "));
  }
});

/** An assessment with one unnamed button at #close, so `aee fix` gets as far as reading it. */
async function fixAssessment(): Promise<string> {
  const assessment = path.join(workspace, "assessment");
  await mkdir(assessment, { recursive: true });
  const finding = {
    ruleId: "button-name",
    instances: [{ selector: "#close" }],
    remediation: { ai: { suggestions: [] } }
  };
  await writeFile(
    path.join(assessment, "aee-report.json"),
    JSON.stringify({ synthesis: { findings: [finding] } })
  );
  return assessment;
}

/** `aee fix` read every argument: it went on to look for the fix in the assessment. */
const fixReadTheAssessment =
  /The assessment has no missing name or text alternative at #open to fix\./;

test("aee fix reads its two paths and options in any order, --accept more than once", async () => {
  const assessment = await fixAssessment();
  for (const args of [
    ["fix", "scenario.yml", assessment, "--accept", "#open", "--source", "a.html", "--start", "x"],
    [
      "fix",
      "--source",
      "a.html",
      "scenario.yml",
      "--start",
      "npm run dev",
      assessment,
      "--accept",
      "#open=Open menu"
    ],
    [
      "fix",
      "scenario.yml",
      assessment,
      "--accept",
      "#open",
      "--accept",
      "#open=a=b",
      "--source",
      "a.html",
      "--start",
      "x",
      "--output",
      "out"
    ]
  ]) {
    const { code, stderr } = await aee(args);
    assert.equal(code, 1, args.join(" "));
    assert.match(stderr, fixReadTheAssessment, args.join(" "));
  }
});

test("aee fix refuses a missing path, option or value", async () => {
  const assessment = await fixAssessment();
  const usage = /Usage: aee fix <scenario\.yml> <assessment-folder> --accept/;
  const cases: [string[], RegExp][] = [
    [["fix", "scenario.yml"], usage],
    [["fix", "scenario.yml", assessment, "--source", "a.html", "--start", "x"], usage],
    [["fix", "scenario.yml", assessment, "--accept", "#open", "--start", "x"], usage],
    [["fix", "scenario.yml", assessment, "--accept", "#open", "--source", "a.html"], usage],
    [["fix", "scenario.yml", assessment, "--accept"], /--accept/],
    [["fix", "scenario.yml", assessment, "--bogus", "x"], /--bogus/]
  ];
  for (const [args, expected] of cases) {
    const { code, stderr } = await aee(args);
    assert.equal(code, 1, args.join(" "));
    assert.doesNotMatch(stderr, fixReadTheAssessment, args.join(" "));
    assert.match(stderr, expected, args.join(" "));
  }
});

// What the hand-written parsers got wrong.

test("an option the command does not know is an error that names it, never silently ignored", async () => {
  const cases: [string[], RegExp][] = [
    // A misspelt --json printed the text plan as if it were not there.
    [["plan", approvedScenario, "--jsno"], /aee plan: Unknown option '--jsno'/],
    // --ci on a JSON fixture config was ignored, so the run could never fail the job.
    [["run", fixtureConfig, "--ci"], /aee run: Unknown option '--ci'/],
    // A misspelt -p for --post was read as a folder, so the comment was never posted.
    [["comment", reports, "-p"], /aee comment: Unknown option '-p'/],
    // A second scenario was ignored, so only the first was planned.
    [["plan", approvedScenario, "second.yml"], /aee plan: Unexpected argument "second\.yml"/]
  ];
  for (const [args, expected] of cases) {
    const { code, stdout, stderr } = await aee(args);
    assert.equal(code, 1, args.join(" "));
    assert.equal(stdout, "", args.join(" "));
    assert.match(stderr, expected);
    assert.match(stderr, /\nUsage: aee /);
  }
});

test("--option=value, -- and an option before the path work as in any command-line tool", async () => {
  const comment = await aee(["comment", reports, "--fail-on=never"]);
  assert.equal(comment.code, 0, comment.stderr);
  assert.match(comment.stderr, /fail-on never\.\n$/);

  const endOfOptions = await aee(["comment", "--post", "--", reports]);
  assert.equal(endOfOptions.code, 0, endOfOptions.stderr);
  assert.match(endOfOptions.stderr, /Not posted/);

  const run = await aee(["run", unapprovedScenario, "--output=out"]);
  assert.match(run.stderr, refusedOnlyForApproval);

  const plan = await aee(["plan", "--json", approvedScenario]);
  assert.equal(plan.code, 0, plan.stderr);
  assert.equal(
    (JSON.parse(plan.stdout) as { scenarioId: string }).scenarioId,
    "public-site-homepage"
  );
});

test("a value that starts with a dash is given with =, and a bare one is refused as ambiguous", async () => {
  const assessment = await fixAssessment();
  const fix = ["fix", "scenario.yml", assessment, "--accept", "#open", "--source", "a.html"];

  // A start command beginning with -- could not be given at all.
  const dashed = await aee([...fix, "--start=--watch"]);
  assert.match(dashed.stderr, fixReadTheAssessment);

  // `--output -out` was read as the folder "-out", which is more often a slip than a folder name.
  const ambiguous = await aee([...fix, "--start", "x", "--output", "-out"]);
  assert.equal(ambiguous.code, 1);
  assert.match(ambiguous.stderr, /aee fix: Option '--output' argument is ambiguous/);
  assert.match(ambiguous.stderr, /--output=-XYZ/);
});

// What each command line is read as.

test("every command line that worked before is read as before", () => {
  const cases: [string[], CommandLine][] = [
    [["plan", "s.yml"], { command: "plan", scenarioPath: "s.yml", json: false }],
    [["plan", "s.yml", "--json"], { command: "plan", scenarioPath: "s.yml", json: true }],
    [["run", "s.yml"], { command: "run", scenarioPath: "s.yml", open: false, ci: false }],
    [
      ["run", "s.yaml", "--ci", "--open", "--output", "a", "--output", "b"],
      { command: "run", scenarioPath: "s.yaml", open: true, ci: true, outputDir: "b" }
    ],
    [["S.YML", "--ci"], { command: "run", scenarioPath: "S.YML", open: false, ci: true }],
    [["run", "c.json"], { command: "run-config", configPath: "c.json" }],
    [["c.json"], { command: "run-config", configPath: "c.json" }],
    [
      ["comment", "a"],
      { command: "comment", folders: ["a"], failOn: "blocking", post: false, images: false }
    ],
    [
      ["comment", "a", "--post", "b", "--fail-on", "never", "--images", ""],
      { command: "comment", folders: ["a", "b", ""], failOn: "never", post: true, images: true }
    ],
    [
      [
        "fix",
        "--accept",
        "#a",
        "s.yml",
        "--source",
        "a.tsx",
        "dir",
        "--accept",
        "#b=Save = keep",
        "--start",
        "npm run dev"
      ],
      {
        command: "fix",
        scenarioPath: "s.yml",
        assessmentDir: "dir",
        accept: [{ selector: "#a" }, { selector: "#b", name: "Save = keep" }],
        sourceFile: "a.tsx",
        startCommand: "npm run dev"
      }
    ]
  ];
  for (const [argv, expected] of cases) {
    assert.deepEqual(parseCommandLine(argv), expected, argv.join(" "));
  }
});

test("the usage lines are written from the same options the commands read", () => {
  assert.equal(usage(COMMANDS.plan), "aee plan <scenario.yml> [--json]");
  assert.equal(usage(COMMANDS.run), "aee run <scenario.yml> [--open] [--ci] [--output <dir>]");
  assert.equal(usage(COMMANDS.runConfig), "aee run <config.json>");
  assert.equal(
    usage(COMMANDS.comment),
    "aee comment <folder>... [--fail-on blocking|incomplete|never] [--post] [--images]"
  );
  assert.equal(
    usage(COMMANDS.fix),
    'aee fix <scenario.yml> <assessment-folder> --accept "<#id>[=<name>]"... --source <file> --start <command> [--output <dir>]'
  );
  assert.throws(() => parseCommandLine([]), {
    message: `Usage: ${Object.values(COMMANDS).map(usage).join(" | ")}`
  });
  assert.throws(
    () => parseCommandLine(["run", "s.yml", "--output", ""]),
    /--output needs a value\./
  );
});
