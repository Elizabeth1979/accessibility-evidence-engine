// The lab contract is the benchmark's known answers (ADR 0006), so a case with a missing or
// unknown field must be refused naming that field, never read as a case with no answer.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { contractErrors, issuePageUrl, loadTestLabContract } from "./test-lab-contract.mjs";

const committed = JSON.parse(readFileSync("site/test-lab-contract.json", "utf8"));

/** The committed contract with its first issue changed. */
function withFirstIssue(change) {
  const contract = structuredClone(committed);
  change(contract.issues[0]);
  return contract;
}

test("the committed contract is valid, and every issue has its own page", () => {
  const contract = loadTestLabContract();
  assert.deepEqual(contractErrors(contract), []);
  assert.equal(
    issuePageUrl(contract, contract.issues[0]),
    "test-case.html?case=unnamed-archive-button"
  );
});

for (const field of ["family", "expected"]) {
  test(`an issue with no ${field} fails, naming it`, () => {
    const contract = withFirstIssue((issue) => delete issue[field]);
    assert.deepEqual(contractErrors(contract), [`/issues/0 is missing "${field}"`]);
  });
}

test("an issue with no expected element fails, naming it", () => {
  const contract = withFirstIssue((issue) => delete issue.expected.ownPage.element);
  assert.deepEqual(contractErrors(contract), [`/issues/0/expected/ownPage is missing "element"`]);
});

test("a misspelt field fails, naming it", () => {
  const contract = withFirstIssue((issue) => {
    issue.famly = issue.family;
    delete issue.family;
  });
  assert.deepEqual(contractErrors(contract), [
    `/issues/0 is missing "family"`,
    `/issues/0 has unknown field "famly"`
  ]);
});

test("a family that is not a registry concept fails, naming it", () => {
  const contract = withFirstIssue((issue) => (issue.family = "accessible-names"));
  assert.deepEqual(contractErrors(contract), [
    `/issues/0/family "accessible-names" is not a concept in remediation-registry.json`
  ]);
});

test("an outcome outside failed, passed and inapplicable fails, naming it", () => {
  const ownPage = withFirstIssue((issue) => (issue.expected.ownPage.outcome = "passed"));
  assert.deepEqual(contractErrors(ownPage), [
    `/issues/0/expected/ownPage/outcome must be "failed"`
  ]);
  const fixedPage = withFirstIssue((issue) => (issue.expected.fixedPage.outcome = "pass"));
  assert.deepEqual(contractErrors(fixedPage), [
    `/issues/0/expected/fixedPage/outcome must be one of passed, inapplicable`
  ]);
});

test("a passed case names its element, and an inapplicable one has none to name", () => {
  const passed = withFirstIssue((issue) => delete issue.expected.fixedPage.element);
  assert.deepEqual(contractErrors(passed), [`/issues/0/expected/fixedPage is missing "element"`]);
  const inapplicable = withFirstIssue(
    (issue) => (issue.expected.fixedPage.outcome = "inapplicable")
  );
  assert.deepEqual(contractErrors(inapplicable), [
    `/issues/0/expected/fixedPage/element is not allowed here`
  ]);
});

test("an issue is found in exactly one way: an axe rule, a sweep finding or a planned step", () => {
  const twoWays = withFirstIssue((issue) => (issue.sweepFinding = "focus-lost"));
  assert.deepEqual(contractErrors(twoWays), [`/issues/0 must match exactly one schema in oneOf`]);
});

// The expected outcome is data written with the case. Taking away the check that finds an issue,
// or swapping it for another, leaves the answer as it was: the check is then counted as missing it.
test("changing the check that finds an issue cannot change its expected outcome", () => {
  for (const change of [
    (issue) => {
      delete issue.axeRule;
      issue.plannedStep = "M3";
    },
    (issue) => {
      delete issue.axeRule;
      issue.sweepFinding = "focus-lost";
    }
  ]) {
    const contract = withFirstIssue(change);
    assert.deepEqual(contractErrors(contract), []);
    assert.deepEqual(contract.issues[0].expected, committed.issues[0].expected);
  }
});
