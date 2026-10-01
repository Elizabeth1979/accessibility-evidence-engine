import assert from "node:assert/strict";
import test from "node:test";

import { commentImageUrl, failsOn, uploadCommentImages } from "./pr-comment";
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

test("a problem with a picture shows it first, with its alt text, in one test and in a suite", () => {
  const image = (finding: { instances: Array<{ label: string }> }) => ({
    url: `https://github.com/owner/app/raw/aee-images/${finding.instances[0]!.label}.png`,
    alt: `Screenshot: “${finding.instances[0]!.label}”, outlined in pink`
  });
  const picture =
    '<img src="https://github.com/owner/app/raw/aee-images/Archive.png" alt="Screenshot: “Archive”, outlined in pink">';
  for (const body of [
    renderPullRequestSummary([assessment("Archive a project", "fail")], undefined, image),
    renderPullRequestSummary(
      [assessment("Archive a project", "fail"), assessment("Home page loads", "pass")],
      undefined,
      image
    )
  ]) {
    assert.ok(body.includes(`</summary>\n\n${picture}\n\n**Problem:**`));
  }
  // Without pictures, the comment is as it was.
  assert.ok(!renderPullRequestSummary([assessment("Archive a project", "fail")]).includes("<img"));
});

test("pictures are shown from the images branch of the repository the comment is on", () => {
  assert.equal(
    commentImageUrl("https://github.com/", "owner/app", "abc.png"),
    "https://github.com/owner/app/raw/aee-images/abc.png"
  );
});

/** A fake GitHub API that records each call and answers from the given replies, in order. */
function fakeGitHub(replies: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const fetch = (async (url: string, init: { method: string; body?: string }) => {
    calls.push({
      method: init.method,
      url: url.replace("https://api.github.com/repos/owner/app", ""),
      ...(init.body ? { body: JSON.parse(init.body) as unknown } : {})
    });
    const reply = replies.shift()!;
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), {
      status: reply.status
    });
  }) as unknown as typeof globalThis.fetch;
  return { calls, target: { repository: "owner/app", token: "token", fetch } };
}

test("the first pictures create the images branch, with no history of the project's own", async () => {
  const { calls, target } = fakeGitHub([
    { status: 404, body: { message: "Not Found" } },
    { status: 201, body: { sha: "blob1" } },
    { status: 201, body: { sha: "tree1" } },
    { status: 201, body: { sha: "commit1" } },
    { status: 201, body: {} }
  ]);
  await uploadCommentImages(new Map([["a.png", Buffer.from("png")]]), target);

  assert.deepEqual(calls, [
    { method: "GET", url: "/git/ref/heads/aee-images" },
    { method: "POST", url: "/git/blobs", body: { content: "cG5n", encoding: "base64" } },
    {
      method: "POST",
      url: "/git/trees",
      body: { tree: [{ path: "a.png", mode: "100644", type: "blob", sha: "blob1" }] }
    },
    {
      method: "POST",
      url: "/git/commits",
      body: { message: "Add pictures for an AEE pull-request comment", tree: "tree1", parents: [] }
    },
    { method: "POST", url: "/git/refs", body: { ref: "refs/heads/aee-images", sha: "commit1" } }
  ]);
});

test("later pictures are added to the branch, and pictures already on it add nothing", async () => {
  const later = fakeGitHub([
    { status: 200, body: { object: { sha: "commit1" } } },
    { status: 200, body: { tree: { sha: "tree1" } } },
    { status: 201, body: { sha: "blob2" } },
    { status: 201, body: { sha: "tree2" } },
    { status: 201, body: { sha: "commit2" } },
    { status: 200, body: {} }
  ]);
  await uploadCommentImages(new Map([["b.png", Buffer.from("png")]]), later.target);
  assert.deepEqual(later.calls.at(3)?.body, {
    base_tree: "tree1",
    tree: [{ path: "b.png", mode: "100644", type: "blob", sha: "blob2" }]
  });
  assert.deepEqual(later.calls.at(4)?.body, {
    message: "Add pictures for an AEE pull-request comment",
    tree: "tree2",
    parents: ["commit1"]
  });
  assert.deepEqual(later.calls.at(5), {
    method: "PATCH",
    url: "/git/refs/heads/aee-images",
    body: { sha: "commit2" }
  });

  const again = fakeGitHub([
    { status: 200, body: { object: { sha: "commit2" } } },
    { status: 200, body: { tree: { sha: "tree2" } } },
    { status: 201, body: { sha: "blob2" } },
    { status: 201, body: { sha: "tree2" } }
  ]);
  await uploadCommentImages(new Map([["b.png", Buffer.from("png")]]), again.target);
  assert.equal(again.calls.length, 4);
});

test("a token that cannot write the branch fails the upload with GitHub's answer", async () => {
  const { target } = fakeGitHub([
    { status: 404, body: { message: "Not Found" } },
    { status: 403, body: { message: "Resource not accessible by integration" } }
  ]);
  await assert.rejects(
    uploadCommentImages(new Map([["a.png", Buffer.from("png")]]), target),
    /answered 403: .*Resource not accessible by integration/
  );
});
