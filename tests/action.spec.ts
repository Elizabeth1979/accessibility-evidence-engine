import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";
import { parse } from "yaml";

import { startHtmlServer } from "./scenario-helpers";
import { contract, runOnLabPage } from "./test-lab-helpers";

const cli = path.resolve("packages/cli/dist/index.js");

test("the Action's inputs and their defaults", async () => {
  const action = parse(await readFile("action.yml", "utf8")) as {
    inputs: Record<string, { required?: boolean; default?: string }>;
  };

  expect(action.inputs.run?.required).toBe(true);
  expect(action.inputs["fail-on"]?.default).toBe("blocking");
  expect(action.inputs["ai-provider"]?.default).toBe("stub");
});

test("the Action's comment step, run twice on a pull request, leaves exactly one comment", async ({
  browser
}, testInfo) => {
  const { outputDir } = await runOnLabPage(
    browser,
    contract.pages.issues,
    ["focus", "hover"],
    testInfo
  );
  // A stand-in for GitHub's issue comments API, as the Action's token sees it.
  const comments: Array<{ id: number; body: string; html_url: string }> = [];
  const requests: string[] = [];
  const github = await startHtmlServer((request, response) => {
    let payload = "";
    request.on("data", (chunk: Buffer) => (payload += chunk.toString()));
    request.on("end", () => {
      const route = new URL(request.url!, "http://github.test").pathname;
      requests.push(`${request.method} ${route} ${request.headers.authorization}`);
      response.setHeader("content-type", "application/json");
      if (request.method === "GET") {
        response.end(JSON.stringify(comments));
        return;
      }
      const { body } = JSON.parse(payload) as { body: string };
      const comment =
        request.method === "POST"
          ? {
              id: comments.length + 1,
              body,
              html_url: `https://github.test/${comments.length + 1}`
            }
          : Object.assign(
              comments.find(({ id }) => id === Number(route.split("/").pop()))!,
              {
                body
              }
            );
      if (request.method === "POST") comments.push(comment);
      response.end(JSON.stringify(comment));
    });
  });
  const eventFile = testInfo.outputPath("event.json");
  const summaryFile = testInfo.outputPath("summary.md");
  await writeFile(eventFile, JSON.stringify({ pull_request: { number: 7 } }), "utf8");
  const env = {
    ...process.env,
    GITHUB_API_URL: github.origin,
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: "owner/app",
    GITHUB_EVENT_PATH: eventFile,
    GITHUB_STEP_SUMMARY: summaryFile
  };
  const comment = (failOn: string) =>
    promisify(execFile)(
      process.execPath,
      [cli, "comment", outputDir, "--post", "--fail-on", failOn],
      { env }
    ).then(
      () => 0,
      (error: { code: number }) => error.code
    );

  try {
    // The demo page has blocking findings, so only fail-on decides the exit code.
    expect(await comment("blocking")).toBe(1);
    expect(await comment("never")).toBe(0);
  } finally {
    await github.close();
  }

  expect(comments).toHaveLength(1);
  expect(comments[0]!.body).toMatch(/^<!-- aee-pr-comment -->\n## Accessibility: release blocked/);
  expect(requests).toEqual([
    "GET /repos/owner/app/issues/7/comments Bearer test-token",
    "POST /repos/owner/app/issues/7/comments Bearer test-token",
    "GET /repos/owner/app/issues/7/comments Bearer test-token",
    "PATCH /repos/owner/app/issues/comments/1 Bearer test-token"
  ]);
  // The job summary shows the comment too, for pull requests whose token cannot post.
  expect(await readFile(summaryFile, "utf8")).toContain(comments[0]!.body);
});
