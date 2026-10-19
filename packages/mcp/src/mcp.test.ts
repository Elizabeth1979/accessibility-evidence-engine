import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./index";

type ToolResult = {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const textOf = (result: unknown) =>
  (result as ToolResult).content.map(({ text = "" }) => text).join("\n");

async function connected(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

test("the server offers explain, findings and run, and nothing that applies a fix", async () => {
  const client = await connected();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map(({ name }) => name).sort(), ["explain", "findings", "run"]);
  assert.equal(tools.find(({ name }) => name === "explain")?.annotations?.readOnlyHint, true);
  // Without these in its system prompt, an agent asked "explain button-name" answered from memory.
  assert.match(
    client.getInstructions() ?? "",
    /call `explain` and answer from the a11y-skills pattern/
  );
  await client.close();
});

/** Six text elements below the contrast minimum, each with its own reading; the PR comment lists five. */
const contrastFinding = {
  ruleId: "color-contrast",
  title: "Elements must meet minimum color contrast ratio thresholds",
  severity: "serious",
  area: "contrast",
  advisory: false,
  wcagCriteria: ["WCAG 1.4.3"],
  pattern: { id: "color-contrast", url: "https://example.com/patterns/color-contrast" },
  conclusion: "Six text elements fall below 4.5:1.",
  occurrenceCount: 1,
  checkpointCount: 1,
  maximumAffectedNodes: 6,
  instanceCount: 6,
  componentCount: 1,
  instances: Array.from({ length: 6 }, (_, index) => ({
    component: "card",
    label: `Card ${index + 1} caption`,
    selector: `.card:nth-child(${index + 1}) > .caption`,
    tagName: "p",
    contrast: { ratio: 3.1, required: 4.5, foreground: "#8a8a8a", background: "#ffffff" }
  })),
  checkpoints: [
    {
      actionId: "load",
      laneId: "axe",
      runId: "run-1",
      driver: "playwright",
      behaviorVerdict: "fail",
      behaviorSummary: "axe reported six nodes.",
      nodeCount: 6,
      targets: [".card:nth-child(1) > .caption"],
      htmlSamples: ['<p class="caption">Caption</p>'],
      axePath: "checkpoints/load/axe.json",
      screenshotPath: "checkpoints/load/page.png"
    }
  ],
  remediation: {
    deterministic: "Darken the caption text to at least 4.5:1 against its background.",
    ai: { used: false, status: "not-applicable", reason: "Contrast is measured, not suggested." },
    verification: ["Re-run axe color-contrast on the cards."]
  }
};

/** A schema-valid assessment, as `aee run` writes it, that fails on the contrast finding. */
const failingReport = {
  schemaVersion: "0.1.0",
  assessmentId: "cards-1",
  scenarioId: "cards",
  scenarioDigest: `sha256:${"a".repeat(64)}`,
  planDigest: `sha256:${"b".repeat(64)}`,
  profile: "core",
  target: "https://example.com/",
  goal: "Read the cards.",
  standard: "WCAG 2.2 A/AA",
  status: "completed",
  verdict: "fail",
  startedAt: "2026-09-14T00:00:00.000Z",
  finishedAt: "2026-09-14T00:01:00.000Z",
  completeness: {
    status: "complete",
    plannedLanes: 1,
    completedLanes: 1,
    missingArtifacts: 0,
    failedArtifacts: 0,
    plannedChecks: { keyboard: false, reader: false }
  },
  summary: {
    actions: 1,
    passed: 0,
    failed: 1,
    unknown: 0,
    findings: 1,
    advisories: 0,
    artifacts: 1
  },
  journeys: [
    { id: "journey", name: "Journey", goal: "Read the cards.", startUrl: "https://example.com/" }
  ],
  actions: [],
  findings: [],
  synthesis: {
    conclusion: "One contrast problem blocks release.",
    directJudgments: { passed: 0, failed: 1, unknown: 0 },
    releaseGates: { passed: 0, failed: 1, unknown: 0 },
    findingOccurrences: 1,
    affectedInstancesAtLargestCheckpoint: 6,
    incompleteRuleResults: 0,
    uniqueIncompleteRules: [],
    lanes: [],
    comparisons: [],
    reader: { commands: 0, passed: 0, failed: 0, unknown: 0 },
    status: [
      {
        id: "contrast",
        label: "Contrast",
        verdict: "fail",
        result: "Fix required",
        detail: "Six text elements fall below 4.5:1."
      }
    ],
    findings: [contrastFinding],
    undecidedContrast: []
  },
  artifacts: [],
  diagnostics: [],
  files: {
    html: "aee-report.html",
    json: "aee-report.json",
    markdown: "aee-report.md",
    prComment: "aee-pr-comment.md",
    csv: "aee-fixes.csv",
    manifest: "manifest.json",
    plan: "scenario-plan.json"
  },
  privacy: {
    classification: "sensitive",
    reviewedForSharing: false,
    remoteUploadAuthorized: false
  },
  ai: { present: false, label: "AI-generated analysis: none in this report." }
};

test("findings gives the agent every finding in full, with a text summary beside it", async () => {
  const client = await connected();
  const output = await mkdtemp(path.join(os.tmpdir(), "aee-mcp-"));
  const assessment = path.join(output, "cards");
  try {
    await mkdir(assessment);
    await writeFile(path.join(assessment, "aee-report.json"), JSON.stringify(failingReport));
    await writeFile(path.join(assessment, "aee-pr-comment.md"), "");
    const result = (await client.callTool({
      name: "findings",
      arguments: { folder: output }
    })) as ToolResult;

    // The text is the PR comment: five of the six elements, and no evidence paths.
    const summary = textOf(result);
    assert.match(summary, /### Blocking fixes \(1\)/);
    assert.match(summary, /and 1 more in the full report/);
    assert.doesNotMatch(summary, /nth-child\(6\)|page\.png/);
    // The structured part is the whole report: the sixth element, its contrast, the evidence.
    assert.deepEqual(result.structuredContent, {
      verdict: "fail",
      assessments: [{ folder: assessment, report: failingReport }]
    });
    // Declared up front, so a client can check it: the report part is AEE's own report schema.
    const { tools } = await client.listTools();
    const outputSchema = tools.find(({ name }) => name === "findings")?.outputSchema;
    assert.equal(
      (
        outputSchema?.properties?.assessments as {
          items: { properties: { report: { title: string } } };
        }
      ).items.properties.report.title,
      "AEE Integrated Scenario Report"
    );
  } finally {
    await client.close();
    await rm(output, { recursive: true, force: true });
  }
});

test("a report that does not match AEE's report schema is an error, not a partial answer", async () => {
  const client = await connected();
  const output = await mkdtemp(path.join(os.tmpdir(), "aee-mcp-"));
  try {
    const { synthesis, ...rest } = failingReport;
    await writeFile(
      path.join(output, "aee-report.json"),
      JSON.stringify({ ...rest, synthesis: { ...synthesis, reader: undefined } })
    );
    await writeFile(path.join(output, "aee-pr-comment.md"), "");
    const result = (await client.callTool({
      name: "findings",
      arguments: { folder: output }
    })) as ToolResult;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /\/synthesis is missing required property "reader"/);
  } finally {
    await client.close();
    await rm(output, { recursive: true, force: true });
  }
});

test("findings on a folder with no assessment is an error that says how to make one", async () => {
  const client = await connected();
  const empty = await mkdtemp(path.join(os.tmpdir(), "aee-mcp-"));
  try {
    const result = (await client.callTool({
      name: "findings",
      arguments: { folder: empty }
    })) as ToolResult;
    assert.equal(result.isError, true);
    assert.match(textOf(result), /No AEE assessment was found under .*aee run/);
  } finally {
    await client.close();
    await rm(empty, { recursive: true, force: true });
  }
});

test("a coding agent that starts aee-mcp and asks to explain button-name gets the buttons pattern", async () => {
  const client = new Client({ name: "coding-agent", version: "1.0.0" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, "bin.js")] })
  );
  try {
    const answer = textOf(
      await client.callTool({ name: "explain", arguments: { topic: "button-name" } })
    );
    assert.match(answer, /^# a11y-skills pattern: buttons\n/);
    assert.match(answer, /Requirements: WCAG 4\.1\.2 Name, Role, Value \(A\)\./);
    assert.match(answer, /patterns\/buttons\.instructions\.md/);
    assert.match(answer, /# Button and Clickable Element Accessibility/);
  } finally {
    await client.close();
  }
});
