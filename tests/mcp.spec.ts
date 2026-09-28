import { writeFile } from "node:fs/promises";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, test } from "@playwright/test";

import { compileScenarioPlan, loadScenario } from "@aee/cli";

import { serveDirectory, startHtmlServer } from "./scenario-helpers";
import { contract } from "./test-lab-helpers";

const textOf = (result: unknown) =>
  (result as { content: Array<{ text?: string }> }).content.map(({ text }) => text).join("\n");

test("a coding agent runs an approved scenario through aee-mcp, reads its fixes and gets the pattern for one", async () => {
  const testInfo = test.info();
  test.setTimeout(180_000);
  const server = await startHtmlServer(serveDirectory("site"));
  const client = new Client({ name: "coding-agent", version: "1.0.0" });
  try {
    const scenarioPath = testInfo.outputPath("scenario.yml");
    const scenario = `schemaVersion: 0.1.0
id: lab-issues
target:
  url: ${server.origin}/
standard:
  name: WCAG
  version: "2.2"
  levels: [A, AA]
profile: core
goal: Find the lab page's issues.
journeys:
  - id: lab-page
    name: Demo page with issues
    goal: Read the page.
    startPath: /${contract.pages.issues.url}
    allowedActions: [focus]
    forbiddenActions: [submit-forms]
    virtualScreenReaderCommands: [start]
approval:
  required: true
`;
    await writeFile(scenarioPath, scenario);
    const { planDigest } = compileScenarioPlan(await loadScenario(scenarioPath));
    await writeFile(scenarioPath, `${scenario}  approvedPlanDigest: ${planDigest}\n`);

    // Started the way a coding agent's MCP config starts it; no model is named, so none is asked.
    const env = { ...process.env } as Record<string, string>;
    delete env.AEE_LLM_PROVIDER;
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve("packages/mcp/dist/bin.js")],
        env
      })
    );
    const output = testInfo.outputPath("aee-output");
    const run = textOf(
      await client.callTool({ name: "run", arguments: { scenario: scenarioPath, output } })
    );
    expect(run).toContain("## Accessibility: release blocked");
    expect(run).toContain("patterns/buttons.instructions.md");
    expect(run).toMatch(/Full report: .*aee-report\.html$/);

    // The same fixes from the folder later, and the pattern behind one of them.
    const findings = textOf(
      await client.callTool({ name: "findings", arguments: { folder: output } })
    );
    expect(findings).toBe(run.slice(0, run.lastIndexOf("\n\nFull report:")));
    const explained = textOf(
      await client.callTool({ name: "explain", arguments: { topic: "button-name" } })
    );
    expect(explained).toMatch(/^# a11y-skills pattern: buttons\n/);
  } finally {
    await client.close();
    await server.close();
  }
});
