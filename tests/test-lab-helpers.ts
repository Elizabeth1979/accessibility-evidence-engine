import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Browser, TestInfo } from "@playwright/test";

import { createStubModelProvider, type ModelProvider, type ModelRequest } from "@aee/ai-fixes";
import { SWEEP_FINDING_CONCEPTS } from "@aee/playwright";

import { runApprovedScenario, serveDirectory, startHtmlServer } from "./scenario-helpers";

export interface LabPage {
  title: string;
  url: string;
  headingOutline: string[];
}

export interface LabIssue {
  id: string;
  concept: string;
  axeRule?: string;
  sweepFinding?: string;
  plannedStep?: string;
}

// The contract is the known answer: the demo page must show exactly its issues' axe rules and
// sweep findings, and the fixed page none. The lab page is generated from the same file.
export const contract = JSON.parse(readFileSync("site/test-lab-contract.json", "utf8")) as {
  pages: { issues: LabPage; fixed: LabPage };
  issues: LabIssue[];
};

export interface ScenarioReport {
  verdict: string;
  completeness: { status: string };
  artifacts: Array<{ kind: string; path: string; provenance?: { laneId?: string } }>;
  synthesis: {
    conclusion: string;
    status: Array<{ id: string; verdict: string; detail: string }>;
    findings: Array<{
      ruleId: string;
      advisory: boolean;
      pattern?: { url: string };
      checkpoints: Array<{ sweepPath?: string }>;
      remediation: {
        ai: {
          used: boolean;
          status: string;
          reason: string;
          providerId?: string;
          suggestions?: Array<{ selector: string; text: string; classification?: string }>;
          notes?: string[];
        };
      };
    }>;
  };
  ai: { present: boolean; label: string };
}

const sweepKinds = new Set(Object.keys(SWEEP_FINDING_CONCEPTS));
/** Enough reader moves to land on every named and unnamed control near the top of either page. */
export const readerWalk = ["start", ...Array<string>(5).fill("next-control")];

/**
 * The stub fixture: a model that answers each specialist with the fixed page's own names, so a
 * test runs the whole AI path with no real model. It records what it was asked.
 */
export function labFixtureModel(): { provider: ModelProvider; requests: ModelRequest[] } {
  const fixedPageNames: Record<string, string> = {
    "#archive-project": "Archive Project Alpha",
    "#help-link": "Help with projects",
    "#usage-chart": "Reviews per day: 12 on Monday, rising to 30 on Friday."
  };
  const requests: ModelRequest[] = [];
  return {
    requests,
    provider: {
      id: "lab-fixture",
      async ask(request) {
        requests.push(request);
        const { selector } = request.input as { selector: string };
        const answer = {
          rationale: "The fixed demo page uses this wording.",
          confidence: 1,
          citedEvidenceIds: ["nearbyText"]
        };
        return request.name === "image_purpose_specialist"
          ? {
              ...answer,
              classification: "informative",
              suggestedAlternative: fixedPageNames[selector]
            }
          : { ...answer, suggestedName: fixedPageNames[selector] };
      }
    }
  };
}

/**
 * Runs `aee run` on a lab page over http, as a user would, and reads back its report. No model is
 * asked unless a test passes one, whatever the environment says.
 */
export async function runOnLabPage(
  browser: Browser,
  labPage: LabPage,
  allowedActions: string[],
  testInfo: TestInfo,
  {
    readerCommands = ["start"],
    aiProvider = createStubModelProvider()
  }: { readerCommands?: string[]; aiProvider?: ModelProvider } = {}
) {
  const server = await startHtmlServer(serveDirectory("site"));
  try {
    const result = await runApprovedScenario(
      browser,
      `schemaVersion: 0.1.0
id: test-lab
target:
  url: ${server.origin}/
standard:
  name: WCAG
  version: "2.2"
  levels: [A, AA]
profile: core
goal: Find every issue the lab page is known to have.
journeys:
  - id: lab-page
    name: ${JSON.stringify(labPage.title)}
    goal: Read and operate the page.
    startPath: ${JSON.stringify(`/${labPage.url}`)}
    allowedActions: [${allowedActions.join(", ")}]
    forbiddenActions: [submit-forms]
    virtualScreenReaderCommands: [${readerCommands.join(", ")}]
approval:
  required: true
`,
      testInfo,
      { aiProvider }
    );
    const report = JSON.parse(await readFile(result.reportFiles.json, "utf8")) as ScenarioReport;
    const sweepArtifact = report.artifacts.find(({ kind }) => kind === "keyboard-pointer-sweep");
    const sweep = JSON.parse(
      await readFile(path.join(result.outputDir, sweepArtifact!.path), "utf8")
    ) as { activated: string[] };
    return {
      report,
      outputDir: result.outputDir,
      reportFiles: result.reportFiles,
      activated: sweep.activated,
      sweepFindings: report.synthesis.findings.filter(({ ruleId }) => sweepKinds.has(ruleId))
    };
  } finally {
    await server.close();
  }
}
