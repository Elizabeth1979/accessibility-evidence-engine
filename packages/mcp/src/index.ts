import { readFileSync } from "node:fs";
import path from "node:path";

import { buildPullRequestComment, executeScenario } from "@aee/cli";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { explain, renderExplanation } from "./explain";

export { explain, renderExplanation, type ExplainedAs, type Explanation } from "./explain";

const { version } = JSON.parse(readFileSync(path.join(__dirname, "../package.json"), "utf8")) as {
  version: string;
};

const text = (value: string) => ({ content: [{ type: "text" as const, text: value }] });

/** A run's fixes as its pull-request comment lists them: blocking first, each with its pattern. */
async function findings(folder: string): Promise<string> {
  const comment = await buildPullRequestComment([path.resolve(folder)]);
  if (comment.reports === 0) {
    throw new Error(
      `No AEE assessment was found under ${folder}. Run \`aee run <scenario.yml>\` or tests that import @aee/cli/test first.`
    );
  }
  return comment.body;
}

/**
 * What the agent's system prompt says about the server. A tool description alone was not enough:
 * asked "explain button-name", a coding agent answered from memory without calling the tool.
 */
const INSTRUCTIONS =
  "Accessibility Evidence Engine (AEE). When asked to explain an accessibility rule or finding (an axe rule id such as button-name, or an AEE finding id such as pointer-only), or how to build a UI element accessibly, call `explain` and answer from the a11y-skills pattern it returns, the one the team's AEE reports link to, rather than from memory; cite its WCAG criteria and source link. Use `findings` to read an AEE run's fixes and `run` for a scenario a person has approved. Never apply a fix from here: suggest it, and a person applies it with `aee fix`.";

/**
 * The AEE MCP server. A coding agent runs an approved scenario, reads a run's fixes, and asks what
 * a rule or UI element needs, answered with its a11y-skills pattern through the remediation
 * registry. It has no rules or model of its own, and it cannot apply a fix: that stays with
 * `aee fix`, after a person has reviewed the suggestion. Returned unconnected, so the caller picks
 * the transport.
 */
export function createServer(): McpServer {
  const server = new McpServer({ name: "aee", version }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "explain",
    {
      title: "Explain an accessibility rule or UI element",
      description:
        "Returns the a11y-skills pattern for an axe rule id (button-name), an AEE finding id (pointer-only), a pattern name (dialog-modal) or the UI element you are building (icon button): its rules with good and bad examples, a complete example, WCAG references and a checklist. Use it before fixing a finding or building a widget.",
      inputSchema: {
        topic: z
          .string()
          .min(1)
          .describe("An axe rule id, an AEE finding id, a pattern name or a UI element in words.")
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ topic }) => text(renderExplanation(explain(topic)))
  );

  server.registerTool(
    "findings",
    {
      title: "Read a run's fixes",
      description:
        "Reads the AEE assessments under a folder (an `aee run` output or a test run's report folder) and returns their fixes as the pull-request comment lists them: blocking first, each with the element, the fix, its a11y-skills pattern and any AI suggestion, labelled as AI.",
      inputSchema: {
        folder: z
          .string()
          .min(1)
          .describe("The folder holding the assessments, such as aee-output.")
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    async ({ folder }) => text(await findings(folder))
  );

  server.registerTool(
    "run",
    {
      title: "Run an approved scenario",
      description:
        "Runs an AEE scenario whose plan a person has approved (`aee plan`, then approval.approvedPlanDigest) in a headless browser, and returns its fixes. An unapproved scenario is refused. It opens only the scenario's own target.",
      inputSchema: {
        scenario: z.string().min(1).describe("Path to the approved scenario YAML file."),
        output: z
          .string()
          .optional()
          .describe("Where to write the assessment; defaults to aee-output.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async ({ scenario, output }) => {
      const result = await executeScenario(path.resolve(scenario), { outputDir: output });
      return text(`${await findings(result.outputDir)}\n\nFull report: ${result.reportFiles.html}`);
    }
  );

  return server;
}

/** Serves the tools over stdio, the way coding agents start an MCP server. */
export async function startServer(): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}
