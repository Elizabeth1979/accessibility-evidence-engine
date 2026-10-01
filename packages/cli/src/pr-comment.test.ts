import assert from "node:assert/strict";
import test from "node:test";

import { failsOn } from "./pr-comment";
import {
  PR_COMMENT_MARKER,
  renderPullRequestSummary,
  type ScenarioIntegratedReport,
  type StatusArea
} from "./scenario-runner";

/** The parts of an assessment a PR comment reads, with one blocking finding when it fails. */
function assessment(
  goal: string,
  verdict: ScenarioIntegratedReport["verdict"],
  fix = "Give the button a name.",
  selector = "#archive"
): ScenarioIntegratedReport {
  return {
    goal,
    verdict,
    profile: "playwright-test",
    target: "https://example.com/",
    standard: "WCAG 2.2 A/AA",
    completeness: { status: "complete" },
    synthesis: {
      status: [
        {
          id: "semantics",
          label: "Semantics",
          verdict: verdict === "fail" ? "fail" : "pass",
          result: verdict === "fail" ? "Fix required" : "No confirmed issue",
          detail: "."
        }
      ],
      uniqueIncompleteRules: [],
      undecidedContrast: [],
      findings:
        verdict === "fail"
          ? [
              {
                ruleId: "button-name",
                title: "Buttons must have discernible text",
                advisory: false,
                wcagCriteria: ["WCAG 4.1.2"],
                instanceCount: 1,
                instances: [{ label: "Archive", selector }],
                remediation: { deterministic: fix, ai: { status: "not-applicable" } }
              }
            ]
          : []
    }
  } as unknown as ScenarioIntegratedReport;
}

test("fail-on decides which verdicts fail the job", () => {
  assert.deepEqual(
    (["blocking", "incomplete", "never"] as const).map((failOn) =>
      (["fail", "unknown", "pass"] as const).map((verdict) => failsOn(verdict, failOn))
    ),
    [
      [true, false, false],
      [true, true, false],
      [false, false, false]
    ]
  );
});

test("several tests make one comment: rows counted, failing tests first", () => {
  const body = renderPullRequestSummary([
    assessment("Home page loads", "pass"),
    assessment("Checkout opens", "fail")
  ]);

  assert.ok(
    body.startsWith(`${PR_COMMENT_MARKER}\n## Accessibility: release blocked by 1 of 2 tests`)
  );
  assert.match(body, /\| Semantics \| Fix required \\\(1\\\) · No confirmed issue \\\(1\\\) \|/);
  assert.match(body, /### Blocking fixes \(1\)/);
  assert.match(body, /\*\*Release blocked \(1\):\*\* Checkout opens/);
  assert.ok(body.indexOf("Checkout opens") < body.indexOf("Home page loads"));
});

test("a suite row counts each result apart, most common first within a verdict", () => {
  const withKeyboard = (goal: string, result: string, verdict: StatusArea["verdict"]) => {
    const report = assessment(goal, "pass");
    report.synthesis.status = [
      { id: "keyboard", label: "Keyboard access", verdict, result, detail: "." }
    ];
    return report;
  };
  const body = renderPullRequestSummary([
    withKeyboard("Shop opens", "No confirmed issue", "pass"),
    withKeyboard("Checks off", "Not in this run", "not-run"),
    withKeyboard("Shop again", "Checked in another test", "not-run"),
    withKeyboard("Shop from search", "Checked in another test", "not-run")
  ]);

  assert.match(
    body,
    /\| Keyboard access \| No confirmed issue \\\(1\\\) · Checked in another test \\\(2\\\) · Not in this run \\\(1\\\) \|/
  );
});

test("a problem three tests see is listed once, with the tests that saw it", () => {
  const body = renderPullRequestSummary([
    assessment("Archive a project", "fail"),
    assessment("Restore a project", "fail"),
    assessment("Delete a project", "fail"),
    // The same rule on another element is another problem.
    assessment("Open settings", "fail", "Give the button a name.", "#settings")
  ]);

  assert.equal(body.match(/<summary><strong>Buttons must have discernible text/g)?.length, 2);
  assert.match(body, /### Blocking fixes \(2\)/);
  // The two share a title, so each names its first element.
  assert.match(body, /WCAG 4\.1\.2 · on “Archive” · 1 element · seen in 3 tests<\/summary>/);
  assert.match(body, /\*\*Seen in:\*\* Archive a project; Restore a project; Delete a project\n/);
  assert.match(
    body,
    /1 element · seen in 1 test<\/summary>[\s\S]*\*\*Seen in:\*\* Open settings\n/
  );
});

test("a comment stays under GitHub's size limit and names what it left out", () => {
  const reports = Array.from({ length: 200 }, (_, index) =>
    assessment(`Page ${index}`, "fail", "Give the button a name. ".repeat(40), `#button-${index}`)
  );
  const body = renderPullRequestSummary(reports);

  assert.ok(body.length < 65_536);
  assert.match(body, /\d+ more problems are in the full reports\./);
});

test("a run that wrote no report says so", () => {
  assert.match(renderPullRequestSummary([]), /not decided, no AEE report was written/);
});
