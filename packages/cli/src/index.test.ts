import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import type { EvidenceRecord, Judgment } from "@aee/core";

import { createBootstrapPlan, runWithPage, type AeeCliConfig } from "./index";

interface JsonReport {
  run: {
    config?: Record<string, unknown>;
  };
  records: EvidenceRecord[];
  judgments: Judgment[];
}

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
    const reportPath = result.reporterFiles.find((filePath) => filePath.endsWith("aee-report.json"));

    assert.ok(reportPath, "Expected a JSON reporter output file.");

    const report = JSON.parse(await readFile(reportPath, "utf8")) as JsonReport;

    assert.deepEqual(report.records.map((record) => record.observerId), ["dom", "dom"]);
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
