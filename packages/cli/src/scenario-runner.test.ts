import assert from "node:assert/strict";
import test from "node:test";

import {
  aeeRunModelProvider,
  buildScenarioSynthesisForTest,
  renderFixesCsvForTest,
  renderIntegratedHtmlForTest,
  renderPullRequestComment,
  type PageChecksSkipped,
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
      failedArtifacts: 0,
      plannedChecks: { keyboard: true, reader: true }
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
      tags:
        id === "aria-required-parent"
          ? ["cat.aria", "wcag2a", "wcag131"]
          : ["cat.color", "wcag2aa", "wcag143"],
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

  return {
    report,
    views: {
      transcripts: [],
      actionReports,
      axeReports,
      comparisons,
      sweeps: [],
      presses: [],
      screens: [],
      elementMaps: []
    }
  };
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

  const row = (id: string) => synthesis.status.find((area) => area.id === id);
  assert.equal(row("keyboard")?.verdict, "unknown");
  assert.equal(row("reader")?.verdict, "pass");
  assert.equal(row("semantics")?.verdict, "fail");
  assert.match(row("semantics")?.detail ?? "", /Certain ARIA roles must be contained/);
  assert.equal(row("contrast")?.verdict, "fail");
  assert.equal(row("contrast")?.detail, "2 links fall below the required contrast ratio.");

  report.synthesis = synthesis;
  const html = renderIntegratedHtmlForTest(report, {
    transcripts: [],
    actionReports,
    axeReports,
    comparisons,
    sweeps: [],
    presses: [],
    screens: [],
    elementMaps: []
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
  assert.equal(contrast?.pattern?.id, "color-contrast");
  assert.match(html, /\/patterns\/color-contrast\.instructions\.md">color-contrast pattern<\/a>/);
  assert.equal(aria?.pattern, undefined);
  const ariaRow = html.match(
    /<article [^>]*id="review-aria-required-parent">[\s\S]*?<\/article>/
  )?.[0];
  assert.ok(ariaRow);
  assert.doesNotMatch(ariaRow, /How to build it right/);
});

test("a contrast failure on plain text is called text, not a link", () => {
  const { report, views } = exampleSynthesisInputs();
  for (const axeReport of views.axeReports) {
    const contrast = axeReport.violations.find(({ id }) => id === "color-contrast")!;
    contrast.nodes = contrast.nodes.map((node) => ({
      ...node,
      html: node.html.replace(/^<a /, "<p ").replace(/<\/a>$/, "</p>")
    }));
    contrast.htmlSamples = contrast.nodes.map(({ html }) => html);
  }

  report.synthesis = buildScenarioSynthesisForTest(report, views);
  const contrastRow = report.synthesis.status.find(({ id }) => id === "contrast");
  const html = renderIntegratedHtmlForTest(report, views);
  const fixRow = html.match(/<article [^>]*id="review-color-contrast">[\s\S]*?<\/article>/)?.[0];

  assert.equal(contrastRow?.detail, "2 text elements fall below the required contrast ratio.");
  assert.ok(fixRow);
  assert.match(fixRow, /<h3>Replace the low-contrast text color<\/h3>/);
  assert.match(fixRow, /may not be able to read this text\.<\/p>/);
});

test("a contrast failure on a dark background proposes a lighter color that passes", () => {
  const { report, views } = exampleSynthesisInputs();
  const failureSummary =
    "Fix any of the following: Element has insufficient color contrast of 2.13 (foreground color: #3f4c48, background color: #07110f, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1";
  for (const axeReport of views.axeReports) {
    const contrast = axeReport.violations.find(({ id }) => id === "color-contrast")!;
    contrast.nodes = contrast.nodes.map((node) => ({ ...node, failureSummary }));
    contrast.failureSummaries = [failureSummary];
  }

  report.synthesis = buildScenarioSynthesisForTest(report, views);
  const fixRow = renderIntegratedHtmlForTest(report, views).match(
    /<article [^>]*id="review-color-contrast">[\s\S]*?<\/article>/
  )?.[0];

  assert.match(fixRow ?? "", /<code>#3f4c48<\/code> on <code>#07110f<\/code> · 2\.13:1/);
  assert.match(fixRow ?? "", /<code>#757e7b<\/code> on <code>#07110f<\/code> · 4\.59:1/);
});

test("a best-practice result is reported as advisory and never blocks release", () => {
  const { report, views } = exampleSynthesisInputs();
  report.findings.push({
    ruleId: "empty-heading",
    severity: "low",
    tags: ["best-practice"],
    occurrences: [{}]
  } as unknown as ScenarioIntegratedReport["findings"][number]);
  for (const axeReport of views.axeReports) {
    axeReport.violations.push({
      id: "empty-heading",
      impact: "minor",
      help: "Headings should not be empty",
      description: "empty-heading description",
      nodeCount: 1,
      targets: ["h2"],
      htmlSamples: ["<h2></h2>"],
      nodes: [{ target: "h2", html: "<h2></h2>", failureSummary: "Element does not have text" }],
      tags: ["cat.name-role-value", "best-practice"],
      failureSummary: "Element does not have text",
      failureSummaries: ["Element does not have text"]
    });
  }

  report.synthesis = buildScenarioSynthesisForTest(report, views);
  const advisory = report.synthesis.findings.at(-1);
  const semantics = report.synthesis.status.find(({ id }) => id === "semantics");
  const html = renderIntegratedHtmlForTest(report, views);

  assert.equal(advisory?.ruleId, "empty-heading");
  assert.equal(advisory?.advisory, true);
  assert.equal(report.synthesis.affectedInstancesAtLargestCheckpoint, 4);
  assert.match(report.synthesis.conclusion, /1 advisory result does not block release/);
  assert.match(semantics?.detail ?? "", /Advisory: Headings should not be empty/);
  assert.match(
    html.match(/<article [^>]*id="review-empty-heading">[\s\S]*?<\/article>/)?.[0] ?? "",
    /<span class="badge unknown">Advisory<\/span>/
  );
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

test("a sweep finding joins the report with its summary, fix pattern and place on the page", () => {
  const { report, views } = exampleSynthesisInputs();
  report.findings.push({
    id: "sweep-lane:pointer-only",
    ruleId: "pointer-only",
    message: "Works with a mouse only",
    severity: "high",
    occurrences: [{ journeyId: "journey", laneId: "sweep-lane" }]
  });
  const targetBox = { x: 10, y: 20, width: 100, height: 30, pageWidth: 1280, pageHeight: 900 };
  const summary = "A mouse can click it, but pressing Tab never reaches it.";
  const sweepViews = {
    ...views,
    sweeps: [
      {
        path: "sweep-lane/keyboard-pointer-sweep.json",
        screenshotPath: "sweep-lane/full-page.png",
        document: {
          schemaVersion: "0.2.0",
          laneId: "sweep-lane",
          driver: "keyboard-pointer-sweep",
          isolation: "dedicated-browser-context",
          status: "completed",
          targetUrl: "https://example.com/",
          allowedOrigins: ["https://example.com"],
          activateControls: false,
          startedAt: "2026-09-16T00:00:00.000Z",
          finishedAt: "2026-09-16T00:00:05.000Z",
          blockedNavigations: [],
          tabStops: [{ selector: "#search", label: "Search", focusVisible: true }],
          activated: [],
          findings: [
            {
              kind: "pointer-only",
              concept: "keyboard-operation",
              selector: "#export-report",
              label: "Export report",
              summary,
              targetBox
            }
          ]
        }
      }
    ]
  };

  report.synthesis = buildScenarioSynthesisForTest(report, sweepViews);
  const finding = report.synthesis.findings.find(({ ruleId }) => ruleId === "pointer-only");
  const html = renderIntegratedHtmlForTest(report, sweepViews);

  assert.equal(finding?.title, "Works with a mouse only");
  assert.match(finding?.conclusion ?? "", /pressing Tab never reaches it/);
  assert.deepEqual(finding?.wcagCriteria, ["WCAG 2.1.1"]);
  assert.equal(finding?.pattern?.id, "focus-management");
  assert.deepEqual(finding?.instances, [
    {
      component: "Export report",
      label: "Export report",
      selector: "#export-report",
      targetBox,
      detail: summary
    }
  ]);
  assert.equal(finding?.checkpoints[0]?.sweepPath, "sweep-lane/keyboard-pointer-sweep.json");
  assert.equal(finding?.checkpoints[0]?.screenshotPath, "sweep-lane/full-page.png");
  assert.match(
    html,
    /<strong>Keyboard access<\/strong><span>Works with a mouse only\.<\/span><\/div><b class="health-result fail">Fix required/
  );
  assert.match(html, /Controls not pressed: activate-page-controls is not allowed/);
});

test("the PR comment puts blocking fixes first and AI last, and shows page text inertly", () => {
  const { report, views } = exampleSynthesisInputs();
  report.synthesis = buildScenarioSynthesisForTest(report, views);
  const [first] = report.synthesis.findings;
  // Text a page controls: an element's name, and axe's summary quoting the page's markup.
  first!.instances[0]!.label = "@octocat </details><img src=x> see #12";
  first!.remediation.deterministic = "Fix @octocat's <b>menu</b> [link](https://example.com)";
  first!.remediation.ai = {
    used: true,
    status: "suggested",
    reason: "",
    providerId: "claude:claude-opus-5",
    suggestions: [
      {
        selector: "#archive",
        text: "Archive `Project` Alpha",
        rationale: "",
        confidence: 0.9,
        citedEvidenceIds: ["nearbyText"],
        patch: ""
      }
    ]
  };

  const comment = renderPullRequestComment(report);

  assert.match(comment, /^## Accessibility: release blocked, 2 fixes needed/);
  assert.ok(comment.indexOf("### Blocking fixes (2)") < comment.indexOf("### AI suggestions"));
  assert.match(
    comment,
    /- \*\*AI suggestion\*\* for `#archive` \(.+\): ``Archive `Project` Alpha``\. Based on the text around it; confidence 0\.90; suggested by `claude:claude-opus-5`\./
  );
  // In a code span GitHub renders nothing and mentions no one.
  assert.ok(comment.includes("- `@octocat </details><img src=x> see #12` at "));
  assert.ok(
    comment.includes(
      "**Fix:** Fix @\u200boctocat&#39;s &lt;b&gt;menu&lt;/b&gt; \\[link\\]\\(https://example.com\\)"
    )
  );
  assert.equal(comment.match(/<details>/g)?.length, comment.match(/<\/details>\n/g)?.length);
});

test("scenario synthesis clearly reports an empty authored scope", () => {
  const report = {
    profile: "playwright-test",
    completeness: { plannedChecks: { keyboard: false, reader: false } },
    actions: [],
    artifacts: [],
    findings: [],
    summary: { passed: 0, failed: 0, unknown: 0 }
  } as unknown as ScenarioIntegratedReport;
  const synthesis = buildScenarioSynthesisForTest(report, {
    transcripts: [],
    actionReports: [],
    axeReports: [],
    comparisons: [],
    sweeps: [],
    presses: [],
    screens: [],
    elementMaps: []
  });

  assert.match(synthesis.conclusion, /no confirmed fixes were emitted/);
  assert.equal(synthesis.affectedInstancesAtLargestCheckpoint, 0);
  assert.equal(synthesis.findings.length, 0);
  assert.equal(synthesis.lanes.length, 0);
  assert.deepEqual(synthesis.reader, { commands: 0, passed: 0, failed: 0, unknown: 0 });
  // Checks the run does not include say so, rather than asking for a review of nothing.
  assert.deepEqual(
    synthesis.status.map(({ id, verdict, result }) => [id, verdict, result]),
    [
      ["keyboard", "not-run", "Not in this run"],
      ["reader", "not-run", "Not in this run"],
      ["semantics", "unknown", "Needs review"],
      ["contrast", "unknown", "Needs review"]
    ]
  );
});

test("a test whose page the fixture did not check says why, and only a page checked elsewhere says so", () => {
  const rows = (skipped: PageChecksSkipped) =>
    buildScenarioSynthesisForTest(
      {
        profile: "playwright-test",
        completeness: { plannedChecks: { keyboard: false, reader: false, skipped } },
        actions: [],
        artifacts: [],
        findings: [],
        summary: { passed: 0, failed: 0, unknown: 0 }
      } as unknown as ScenarioIntegratedReport,
      {
        transcripts: [],
        actionReports: [],
        axeReports: [],
        comparisons: [],
        sweeps: [],
        presses: [],
        screens: [],
        elementMaps: []
      }
    ).status.slice(0, 2);

  // Never a pass: the result for this test is in another test's report.
  assert.deepEqual(
    rows("checked-in-another-test").map(({ id, verdict, result, detail }) => [
      id,
      verdict,
      result,
      detail
    ]),
    ["keyboard", "reader"].map((id) => [
      id,
      "not-run",
      "Checked in another test",
      "Another test of this run ended on this page and was checked there: the test fixture checks each page once per run. That test's report has the result."
    ])
  );
  for (const [skipped, detail] of [
    ["test-did-not-pass", /^Not for this test: it did not pass/],
    ["no-web-page", /^Not for this test: it did not end on a web page\./],
    ["turned-off", /^Not for this test: its keyboard and reader checks are off/]
  ] as const) {
    for (const row of rows(skipped)) {
      assert.equal(row.verdict, "not-run");
      assert.equal(row.result, "Not in this run");
      assert.match(row.detail, detail);
    }
  }
});

test("aee run asks a model only when AEE_LLM_PROVIDER names one, never because a key is set", () => {
  assert.equal(aeeRunModelProvider({}).id, "stub");
  assert.equal(aeeRunModelProvider({ ANTHROPIC_API_KEY: "key" }).id, "stub");
  assert.equal(
    aeeRunModelProvider({ AEE_LLM_PROVIDER: "claude", ANTHROPIC_API_KEY: "key" }).id,
    "claude:claude-opus-5"
  );
  assert.equal(aeeRunModelProvider({ AEE_LLM_PROVIDER: "local" }).id, "local:gemma4:e4b");
});

test("the fixes CSV has one quoted row per fix, and keeps page text that looks like a formula as text", () => {
  const { report, views } = exampleSynthesisInputs();
  report.synthesis = buildScenarioSynthesisForTest(report, views);
  // A spreadsheet runs a cell starting with = as a formula, and page text can start with anything.
  report.synthesis.findings[0]!.instances[0]!.detail = '=HYPERLINK("https://example.com","Click")';
  const csv = renderFixesCsvForTest(report, views);
  const lines = csv.split("\r\n").filter(Boolean);
  assert.match(lines[0]!, /^Title,Severity,WCAG,Rule,Rule link,How to build it,Page,Elements/);
  assert.match(csv, /,"'=HYPERLINK\(""https:\/\/example\.com"",""Click""\)/);
  // RFC 4180 rows, read back to back: a cell is bare, or quoted with "" for a quote inside it.
  const cell = '(?:[^",\\r\\n]*|"(?:[^"]|"")*")';
  const row = new RegExp(`${cell}(?:,${cell})*\\r\\n`, "y");
  const read: string[] = [];
  for (let match = row.exec(csv); match; match = row.exec(csv)) read.push(match[0]);
  assert.equal(read.join(""), csv);
  assert.equal(read.length, report.synthesis.findings.length + 1);
});
