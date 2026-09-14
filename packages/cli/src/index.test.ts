import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import type { EvidenceRecord, Judgment } from "@aee/core";

import {
  compileScenarioPlan,
  createBootstrapPlan,
  loadScenario,
  renderScenarioPlan,
  runWithPage,
  type AeeCliConfig
} from "./index";

interface JsonReport {
  run: {
    config?: Record<string, unknown>;
  };
  records: EvidenceRecord[];
  judgments: Judgment[];
}

const execFileAsync = promisify(execFile);

test("createBootstrapPlan filters observers through the capture policy", () => {
  const plan = createBootstrapPlan({
    projectRoot: ".",
    fixturePath: "./fixture.json",
    observers: ["dom", "visual", "focus"],
    policy: {
      capture: {
        includeScreenshots: false
      }
    }
  });

  assert.deepEqual(plan.selectedObservers, ["dom", "focus"]);
});

test("runWithPage records the capture policy and filtered observer set", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "aee-cli-"));
  const configPath = path.join(tempRoot, "config.json");
  const config: AeeCliConfig = {
    projectRoot: ".",
    outputDir: "aee-output",
    fixturePath: "./fixture.json",
    observers: ["dom", "visual"],
    judges: ["release"],
    policy: {
      name: "dom-only",
      capture: {
        includeScreenshots: false
      }
    }
  };
  const page = {
    url() {
      return "https://example.com/checkout";
    },
    async content() {
      return `
        <main>
          <h1>Checkout</h1>
          <button type="button">Pay now</button>
        </main>
      `;
    },
    async snapshotScreenshot() {
      throw new Error("Visual capture should have been filtered by policy.");
    }
  };

  try {
    const result = await runWithPage(config, page, configPath);
    const reportPath = result.reporterFiles.find((filePath) =>
      filePath.endsWith("aee-report.json")
    );

    assert.ok(reportPath, "Expected a JSON reporter output file.");

    const report = JSON.parse(await readFile(reportPath, "utf8")) as JsonReport;

    assert.deepEqual(
      report.records.map((record) => record.observerId),
      ["dom", "dom"]
    );
    assert.deepEqual(report.run.config?.selectedObservers, ["dom"]);
    assert.deepEqual(report.run.config?.capturePolicy, {
      includeScreenshots: false,
      includeAccessibilityTree: true,
      includeDomSnapshot: true,
      stabilizeAfterInteractionMs: 250
    });
    assert.equal(report.judgments.length, 1);
    assert.equal(report.judgments[0]?.judgeId, "release");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("compileScenarioPlan expands user permissions and blocks incomplete Core coverage", async () => {
  const scenario = await loadScenario(
    path.resolve(__dirname, "../../../examples/melio/scenario.yml")
  );
  const plan = compileScenarioPlan(scenario);

  assert.equal(plan.readiness.status, "blocked");
  assert.equal(plan.approval.status, "pending");
  assert.ok(!plan.readiness.blockingCapabilityIds.includes("axe-results"));
  assert.ok(!plan.readiness.blockingCapabilityIds.includes("full-page-screenshot"));
  assert.equal(
    plan.requiredCapabilities.find(({ id }) => id === "axe-results")?.implementationStatus,
    "available"
  );
  assert.ok(!plan.readiness.blockingCapabilityIds.includes("virtual-screen-reader-lane"));
  assert.ok(!plan.readiness.blockingCapabilityIds.includes("screen-reader-transcript"));
  assert.ok(!plan.readiness.blockingCapabilityIds.includes("keyboard-lane"));
  assert.ok(!plan.readiness.blockingCapabilityIds.includes("pointer-hover-lane"));
  assert.ok(!plan.readiness.blockingCapabilityIds.includes("interaction-trace"));
  assert.ok(!plan.readiness.blockingCapabilityIds.includes("evidence-manifest"));
  assert.ok(plan.readiness.blockingCapabilityIds.includes("integrated-report"));
  assert.ok(
    plan.journeys[0]?.steps.some(
      ({ id, source }) => id === "permission-open-menus" && source === "user-permission"
    )
  );
  assert.deepEqual(
    plan.journeys[0]?.steps.filter(({ source }) => source === "user-command").map(({ id }) => id),
    [
      "reader-command-1-next-landmark",
      "reader-command-2-next-heading",
      "reader-command-3-next-control",
      "comparison-sign-in-hover-focus-pointer-1",
      "comparison-sign-in-hover-focus-keyboard-1"
    ]
  );
  assert.deepEqual(plan.safety.forbiddenActions, [
    "create-account",
    "initiate-payment",
    "sign-in",
    "submit-personal-information"
  ]);
  assert.deepEqual(plan.safety.allowedOrigins, ["https://melio.com"]);
  assert.match(renderScenarioPlan(plan), /AEE will not convert a partial run into an overall pass/);
});

test("compileScenarioPlan produces a stable plan digest that can be explicitly approved", async () => {
  const scenario = await loadScenario(
    path.resolve(__dirname, "../../../examples/melio/scenario.yml")
  );
  const firstPlan = compileScenarioPlan(scenario);
  const approvedPlan = compileScenarioPlan({
    ...scenario,
    approval: {
      required: true,
      approvedPlanDigest: firstPlan.planDigest
    }
  });

  assert.equal(approvedPlan.planDigest, firstPlan.planDigest);
  assert.equal(approvedPlan.scenarioDigest, firstPlan.scenarioDigest);
  assert.equal(approvedPlan.approval.status, "approved");
});

test("compileScenarioPlan rejects actions that are both allowed and forbidden", async () => {
  const scenario = await loadScenario(
    path.resolve(__dirname, "../../../examples/melio/scenario.yml")
  );
  const conflictingAction = scenario.journeys[0]?.allowedActions[0];
  assert.ok(conflictingAction);

  assert.throws(
    () =>
      compileScenarioPlan({
        ...scenario,
        journeys: [
          {
            ...scenario.journeys[0],
            forbiddenActions: [...scenario.journeys[0].forbiddenActions, conflictingAction]
          }
        ]
      }),
    /cannot both allow and forbid/
  );
});

test("CLI plan emits a machine-readable user-controlled plan", async () => {
  const cliPath = path.resolve(__dirname, "index.js");
  const scenarioPath = path.resolve(__dirname, "../../../examples/melio/scenario.yml");
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliPath,
    "plan",
    scenarioPath,
    "--json"
  ]);
  const plan = JSON.parse(stdout) as { scenarioId: string; readiness: { status: string } };

  assert.equal(stderr, "");
  assert.equal(plan.scenarioId, "melio-public-homepage");
  assert.equal(plan.readiness.status, "blocked");
});

test("CLI run refuses to execute a scenario with incomplete required evidence", async () => {
  const cliPath = path.resolve(__dirname, "index.js");
  const scenarioPath = path.resolve(__dirname, "../../../examples/melio/scenario.yml");

  await assert.rejects(
    () => execFileAsync(process.execPath, [cliPath, "run", scenarioPath]),
    (error: unknown) => {
      const output = error as { stderr?: string };
      assert.match(output.stderr ?? "", /Cannot run scenario “melio-public-homepage”/);
      assert.match(output.stderr ?? "", /required capabilities are not fully implemented/);
      return true;
    }
  );
});
