import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { expect, test } from "@playwright/test";

import type { ModelProvider, ModelRequest } from "@aee/ai-fixes";
import { runVerifiedFix } from "@aee/cli";

import { runApprovedScenario, serveDirectory, startHtmlServer } from "./scenario-helpers";
import type { ScenarioReport } from "./test-lab-helpers";

/** A small app with one icon-only button and nothing to name it. */
const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Weekly digest</title>
  </head>
  <body>
    <main>
      <h1>Weekly digest</h1>
      <section aria-labelledby="signup-heading">
        <h2 id="signup-heading">Get the digest by email</h2>
        <p>One short email every Friday with the week's changes.</p>
        <button id="dismiss-signup" type="button">
          <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16">
            <path d="M3 3l10 10M13 3 3 13" stroke="currentColor" stroke-width="2" />
          </svg>
        </button>
      </section>
    </main>
  </body>
</html>
`;

/** The app's own server, as a project's start command would be: it serves the page on a port. */
const SERVER = `import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

createServer(async (request, response) => {
  const page = await readFile(new URL("index.html", import.meta.url));
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
}).listen(Number(process.argv[2]), "127.0.0.1");
`;

const NAME = "Dismiss the email sign-up";

/** A stand-in for the name specialist's model: it answers with a fixed name and records the ask. */
function nameModel(): { provider: ModelProvider; requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  return {
    requests,
    provider: {
      id: "fix-fixture",
      async ask(request) {
        requests.push(request);
        return {
          suggestedName: NAME,
          rationale: "The button closes the sign-up section it sits in.",
          confidence: 0.9,
          citedEvidenceIds: ["nearbyHeading"]
        };
      }
    }
  };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

test("Milestone 3 exit test: a missing button name found by axe, worded by a specialist, applied on its own branch and verified by a rerun", async ({
  browser
}, testInfo) => {
  test.setTimeout(240_000);
  const repo = testInfo.outputPath("app");
  await mkdir(repo, { recursive: true });
  await writeFile(path.join(repo, "index.html"), PAGE);
  await writeFile(path.join(repo, "serve.mjs"), SERVER);
  git(repo, "init", "--quiet", "--initial-branch=main");
  git(repo, "config", "user.name", "AEE test");
  git(repo, "config", "user.email", "aee-test@example.com");
  git(repo, "add", ".");
  git(repo, "commit", "--quiet", "-m", "Weekly digest page");
  const before = git(repo, "rev-parse", "HEAD");

  // Found by axe, and worded by the name specialist from the evidence around the button.
  const model = nameModel();
  const server = await startHtmlServer(serveDirectory(repo));
  const scenarioYaml = `schemaVersion: 0.1.0
id: digest
target:
  url: ${server.origin}/
standard:
  name: WCAG
  version: "2.2"
  levels: [A, AA]
profile: core
goal: Check the weekly digest page.
journeys:
  - id: digest-page
    name: Weekly digest
    goal: Read the page and reach its controls.
    startPath: /index.html
    allowedActions: [focus]
    forbiddenActions: [submit-forms]
    virtualScreenReaderCommands: [start, next-control]
approval:
  required: true
`;
  const found = await runApprovedScenario(browser, scenarioYaml, testInfo, {
    aiProvider: model.provider
  });
  const report = JSON.parse(await readFile(found.reportFiles.json, "utf8")) as ScenarioReport;
  const buttonName = report.synthesis.findings.find(({ ruleId }) => ruleId === "button-name");
  expect(buttonName?.remediation.ai).toMatchObject({
    status: "suggested",
    suggestions: [{ selector: "#dismiss-signup", text: NAME }]
  });
  expect(model.requests[0]?.input).toMatchObject({ nearbyHeading: "Get the digest by email" });

  const fix = {
    scenarioPath: testInfo.outputPath("scenario.yml"),
    assessmentDir: found.outputDir,
    accept: [{ selector: "#dismiss-signup" }],
    sourceFile: path.join(repo, "index.html"),
    startCommand: `node serve.mjs ${new URL(server.origin).port}`,
    outputDir: testInfo.outputPath("rerun"),
    browser,
    aiProvider: model.provider
  };
  // With the old page still served, a rerun could not tell the fix from the original.
  await expect(runVerifiedFix(fix)).rejects.toThrow(`Something already serves ${server.origin}/`);
  await server.close();

  const result = await runVerifiedFix(fix);
  expect(result.fixes).toEqual([
    {
      ruleId: "button-name",
      selector: "#dismiss-signup",
      name: NAME,
      attribute: "aria-label",
      wordedBy: "ai"
    }
  ]);
  // Verified by the rerun's own evidence: axe (DOM), the reader, and the reader's agreement with
  // the accessibility tree and the rendered page.
  expect(result.verifications).toEqual([
    {
      selector: "#dismiss-signup",
      verdict: "pass",
      checks: [
        {
          id: "axe",
          verdict: "pass",
          detail: "axe no longer reports button-name on #dismiss-signup."
        },
        { id: "reader", verdict: "pass", detail: expect.stringContaining(NAME) },
        { id: "cross-evidence", verdict: "pass", detail: expect.any(String) }
      ]
    }
  ]);
  expect(result.verdict).toBe("pass");

  // In isolation: the fix is one commit on its own branch; the working copy and main are as they were.
  expect(git(repo, "rev-parse", "HEAD")).toBe(before);
  expect(await readFile(path.join(repo, "index.html"), "utf8")).toBe(PAGE);
  expect(git(repo, "status", "--porcelain")).toBe("");
  expect(git(repo, "rev-list", "--count", `main..${result.branch}`)).toBe("1");
  expect(git(repo, "diff", "main", result.branch)).toContain(
    `+        <button id="dismiss-signup" type="button" aria-label="${NAME}">`
  );
  expect(git(repo, "log", "-1", "--format=%B", result.branch)).toContain(
    "worded by AI (accessible-name-specialist on fix-fixture), accepted by a reviewer"
  );
  expect(git(repo, "worktree", "list")).not.toContain("aee-fix-");

  // The verdict comes from the rerun, not from the edit: with the app started from the unchanged
  // checkout instead of the fix's branch, the same fix fails.
  git(repo, "branch", "-D", result.branch);
  const unfixed = await runVerifiedFix({
    ...fix,
    startCommand: `node ${JSON.stringify(path.join(repo, "serve.mjs"))} ${new URL(server.origin).port}`,
    outputDir: testInfo.outputPath("rerun-unfixed")
  });
  expect(unfixed.verdict).toBe("fail");
  expect(unfixed.verifications[0]?.checks).toMatchObject([
    { id: "axe", verdict: "fail", detail: "axe still reports button-name on #dismiss-signup." },
    { id: "reader", verdict: "fail", detail: expect.stringContaining(`not the name “${NAME}”`) },
    { id: "cross-evidence" }
  ]);
});
