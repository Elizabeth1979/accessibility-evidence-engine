import assert from "node:assert/strict";
import test from "node:test";

import {
  buildScenarioSynthesisForTest,
  renderIntegratedHtmlForTest,
  type ScenarioActionReport,
  type ScenarioIntegratedReport
} from "./scenario-runner";

function action(
  driver: ScenarioActionReport["driver"],
  actionId: string,
  runId: string
): ScenarioActionReport {
  return {
    journeyId: "journey",
    laneId: `lane-${driver}`,
    driver,
    actionId,
    sequence: 1,
    runId,
    pageUrl: "https://example.com/",
    results: { pass: 1, fail: 1, unknown: 0 },
    releaseVerdict: "fail",
    reportPath: `${runId}/report.json`,
    artifactPaths: []
  };
}

/** Three lanes on one page with two axe violations: the shared input for synthesis tests. */
function exampleSynthesisInputs() {
  const actions = [
    action("portable-virtual-screen-reader", "command-1-next-heading", "reader-run"),
    action("pointer", "pointer-hover", "pointer-run"),
    action("keyboard", "keyboard-focus", "keyboard-run")
  ];
  const artifacts = actions.flatMap((item) =>
    [
      ["dom-snapshot", "dom.html"],
      ["accessibility-tree", "aom.json"],
      ["focus-state", "focus.json"],
      ["full-page-screenshot", "full.png"],
      ["viewport-screenshot", "viewport.png"]
    ].map(([kind, name]) => ({
      kind,
      phase: "after",
      path: `${item.runId}/${name}`,
      provenance: { runId: item.runId }
    }))
  );
  artifacts.push({
    kind: "screen-reader-transcript",
    phase: "after",
    path: "reader-run/transcript-json-after.json",
    provenance: { runId: "reader-run" }
  });
  const report = {
    assessmentId: "assessment",
    scenarioId: "example-page",
    scenarioDigest: `sha256:${"a".repeat(64)}`,
    planDigest: `sha256:${"b".repeat(64)}`,
    profile: "core",
    target: "https://example.com/",
    goal: "Review the example page.",
    standard: "WCAG 2.2 A/AA",
    status: "completed",
    verdict: "fail",
    startedAt: "2026-09-16T00:00:00.000Z",
    finishedAt: "2026-09-16T00:01:00.000Z",
    completeness: {
      status: "complete",
      plannedLanes: 3,
      completedLanes: 3,
      missingArtifacts: 0,
      failedArtifacts: 0
    },
    actions,
    artifacts,
    findings: [
      { ruleId: "aria-required-parent", severity: "critical", occurrences: [{}, {}, {}] },
      { ruleId: "color-contrast", severity: "serious", occurrences: [{}, {}, {}] }
    ],
    summary: { actions: 3, passed: 0, failed: 3, unknown: 0, findings: 2, artifacts: 16 },
    journeys: [],
    diagnostics: [],
    files: {
      html: "aee-report.html",
      json: "aee-report.json",
      markdown: "aee-report.md",
      manifest: "manifest.json",
      plan: "scenario-plan.json"
    },
    privacy: {
      classification: "sensitive",
      reviewedForSharing: false,
      remoteUploadAuthorized: false
    },
    ai: { present: false, label: "No AI-generated analysis was used." }
  } as unknown as ScenarioIntegratedReport;
  const actionReports = actions.map((item) => ({
    action: item,
    observerSummaries: [],
    judgments: [
      {
        judgeId:
          item.driver === "portable-virtual-screen-reader" ? "screen-reader" : "focus-management",
        verdict: "pass",
        summary: `${item.driver} behavior matched the captured evidence.`
      },
      { judgeId: "axe", verdict: "fail", summary: "Confirmed automated violations." },
      { judgeId: "release", verdict: "fail", summary: "Release blocked." }
    ]
  }));
  const violation = (id: string) => {
    const failureSummary =
      id === "color-contrast"
        ? "Fix any of the following: Element has insufficient color contrast of 2.83"
        : "Fix any of the following: Required ARIA parent role not present";
    const nodes =
      id === "aria-required-parent"
        ? [
            {
              target: "#footer a:nth-child(1)",
              html: '<a role="menuitem">Help</a>',
              failureSummary
            },
            {
              target: "#footer a:nth-child(2)",
              html: '<a role="menuitem">Pricing</a>',
              failureSummary
            }
          ]
        : [
            {
              target: "#announcement_bar_button_cta",
              html: '<a id="announcement_bar_button_cta">Start now</a>',
              failureSummary
            },
            {
              target: "#mid_page_banner_button1_cta",
              html: '<a id="mid_page_banner_button1_cta">Learn more</a>',
              failureSummary
            }
          ];
    return {
      id,
      impact: id === "aria-required-parent" ? "critical" : "serious",
      help:
        id === "aria-required-parent"
          ? "Certain ARIA roles must be contained"
          : "Elements must meet minimum color contrast ratio thresholds",
      description: `${id} description`,
      nodeCount: nodes.length,
      targets: nodes.map(({ target }) => target),
      htmlSamples: nodes.map(({ html }) => html),
      nodes,
      tags: [id === "aria-required-parent" ? "wcag131" : "wcag143"],
      failureSummary,
      failureSummaries: [failureSummary]
    };
  };
  const axeReports = actions.map((item) => ({
    path: `${item.runId}/axe.json`,
    actionId: item.actionId,
    laneId: item.laneId,
    runId: item.runId,
    violations: [violation("aria-required-parent"), violation("color-contrast")],
    incomplete: [
      {
        ...violation("aria-valid-attr-value"),
        id: "aria-valid-attr-value"
      }
    ],
    passes: 20,
    inapplicable: 5
  }));
  const comparisons = [
    {
      path: "comparison.json",
      comparisonId: "comparison",
      name: "Hover and focus",
      status: "completed",
      isolation: "separate contexts",
      equivalence: { verdict: "pass", summary: "Equivalent" },
      expectation: { verdict: "pass", summary: "Expected outcome matched" },
      pointer: { actionIds: ["pointer-hover"], visible: true },
      keyboard: { actionIds: ["keyboard-focus"], visible: true }
    }
  ];

  return { report, views: { transcripts: [], actionReports, axeReports, comparisons } };
}

test("scenario synthesis correlates findings with keyboard, reader, DOM, AOM, and visual evidence", () => {
  const { report, views } = exampleSynthesisInputs();
  const { actionReports, axeReports, comparisons } = views;
  const synthesis = buildScenarioSynthesisForTest(report, views);

  assert.deepEqual(synthesis.directJudgments, { passed: 3, failed: 3, unknown: 0 });
  assert.deepEqual(synthesis.releaseGates, { passed: 0, failed: 3, unknown: 0 });
  assert.equal(synthesis.reader.passed, 1);
  assert.equal(synthesis.findingOccurrences, 6);
  assert.equal(synthesis.affectedInstancesAtLargestCheckpoint, 4);
  assert.deepEqual(synthesis.uniqueIncompleteRules, ["aria-valid-attr-value"]);
  assert.match(synthesis.conclusion, /pointer\/keyboard comparisons matched/);
  assert.equal(synthesis.lanes.length, 3);

  const aria = synthesis.findings.find(({ ruleId }) => ruleId === "aria-required-parent");
  assert.equal(aria?.wcagCriteria[0], "WCAG 1.3.1");
  assert.equal(aria?.checkpoints.length, 3);
  assert.equal(aria?.instanceCount, 2);
  assert.equal(aria?.componentCount, 1);
  assert.equal(aria?.instances[0]?.label, "Help");
  assert.equal(aria?.checkpoints[0]?.domPath, "reader-run/dom.html");
  assert.equal(aria?.checkpoints[0]?.accessibilityTreePath, "reader-run/aom.json");
  assert.equal(aria?.checkpoints[0]?.screenshotPath, "reader-run/full.png");
  assert.equal(aria?.checkpoints[0]?.readerTranscriptPath, "reader-run/transcript-json-after.json");
  assert.equal(aria?.remediation.ai.status, "not-applicable");
  assert.match(aria?.remediation.deterministic ?? "", /remove role="menuitem"/);

  const contrast = synthesis.findings.find(({ ruleId }) => ruleId === "color-contrast");
  assert.equal(contrast?.wcagCriteria[0], "WCAG 1.4.3");
  assert.equal(contrast?.instanceCount, 2);
  assert.equal(contrast?.componentCount, 2);
  assert.equal(contrast?.remediation.ai.status, "available-if-needed");
  assert.match(contrast?.remediation.deterministic ?? "", /2\.83/);

  report.synthesis = synthesis;
  const html = renderIntegratedHtmlForTest(report, {
    transcripts: [],
    actionReports,
    axeReports,
    comparisons
  });
  assert.match(html, /Your accessibility status/);
  assert.match(html, /Ask this report/);
  assert.match(html, /Grouped fix review/);
  assert.match(html, /This defect is not visible in a screenshot/);
  assert.match(html, /Show all 2 affected page locations/);
  assert.match(html, /Proposed fix/);
  assert.match(html, /3–6 engineering hours/);
  assert.match(html, /Technical annex/);
  assert.match(html, /data-fix-filter="small"/);
  assert.equal(aria?.pattern, undefined);
  assert.doesNotMatch(html, /How to build it right/);
});

test("a finding the registry maps links to its a11y-skills pattern in the report", () => {
  const { report, views } = exampleSynthesisInputs();
  report.findings[0]!.ruleId = "button-name";
  for (const axeReport of views.axeReports) axeReport.violations[0]!.id = "button-name";

  report.synthesis = buildScenarioSynthesisForTest(report, views);
  const finding = report.synthesis.findings.find(({ ruleId }) => ruleId === "button-name");
  const html = renderIntegratedHtmlForTest(report, views);

  assert.equal(finding?.pattern?.id, "buttons");
  assert.match(finding?.pattern?.url ?? "", /\/patterns\/buttons\.instructions\.md$/);
  assert.match(
    html,
    /How to build it right:<\/strong> <a href="https:\/\/github\.com\/Elizabeth1979\/a11y-skills\/blob\/[0-9a-f]{40}\/patterns\/buttons\.instructions\.md">buttons pattern<\/a>/
  );
});

test("scenario synthesis clearly reports an empty authored scope", () => {
  const report = {
    actions: [],
    artifacts: [],
    findings: [],
    summary: { passed: 0, failed: 0, unknown: 0 }
  } as unknown as ScenarioIntegratedReport;
  const synthesis = buildScenarioSynthesisForTest(report, {
    transcripts: [],
    actionReports: [],
    axeReports: [],
    comparisons: []
  });

  assert.match(synthesis.conclusion, /no confirmed fixes were emitted/);
  assert.equal(synthesis.affectedInstancesAtLargestCheckpoint, 0);
  assert.equal(synthesis.findings.length, 0);
  assert.equal(synthesis.lanes.length, 0);
  assert.deepEqual(synthesis.reader, { commands: 0, passed: 0, failed: 0, unknown: 0 });
});
