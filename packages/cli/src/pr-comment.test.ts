import assert from "node:assert/strict";
import test from "node:test";

import { failsOn } from "./pr-comment";
import {
  PR_COMMENT_MARKER,
  renderPullRequestSummary,
  type ScenarioIntegratedReport
} from "./scenario-runner";

/** The parts of an assessment a PR comment reads, with one blocking finding when it fails. */
function assessment(
  goal: string,
  verdict: ScenarioIntegratedReport["verdict"],
  fix = "Give the button a name."
): ScenarioIntegratedReport {
  return {
    goal,
    verdict,
    target: "https://example.com/",
    standard: "WCAG 2.2 A/AA",
    completeness: { status: "complete" },
    synthesis: {
      status: [],
      uniqueIncompleteRules: [],
      findings:
        verdict === "fail"
          ? [
              {
                ruleId: "button-name",
                title: "Buttons must have discernible text",
                advisory: false,
                wcagCriteria: ["WCAG 4.1.2"],
                instanceCount: 1,
                instances: [{ label: "Archive", selector: "#archive" }],
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

test("several assessments make one comment, failing ones first", () => {
  const body = renderPullRequestSummary([
    assessment("Home page loads", "pass"),
    assessment("Checkout opens", "fail")
  ]);

  assert.ok(body.startsWith(`${PR_COMMENT_MARKER}\n## Accessibility: release blocked by 1 of 2`));
  assert.ok(body.indexOf("Checkout opens") < body.indexOf("Home page loads"));
  assert.match(body, /<summary><strong>Checkout opens<\/strong>: release blocked, 1 fix needed/);
  assert.match(body, /#### Blocking fixes \(1\)/);
});

test("a comment stays under GitHub's size limit and names what it left out", () => {
  const reports = Array.from({ length: 200 }, (_, index) =>
    assessment(`Page ${index}`, "fail", "Give the button a name. ".repeat(40))
  );
  const body = renderPullRequestSummary(reports);

  assert.ok(body.length < 65_536);
  assert.match(body, /\d+ more assessments are in the full reports\./);
});

test("a run that wrote no report says so", () => {
  assert.match(renderPullRequestSummary([]), /not decided, no AEE report was written/);
});
