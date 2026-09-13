import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { assertValidSchema, validateSchema } from "./validator";

const sampleArtifact = {
  id: "artifact-1",
  kind: "dom-snapshot",
  path: "/tmp/dom-before.html",
  mediaType: "text/html"
};

const sampleCheckpoint = {
  id: "checkpoint-1",
  runId: "run-1",
  timestamp: "2026-06-20T00:00:00.000Z",
  trigger: "manual" as const,
  url: "https://example.com"
};

const sampleInteraction = {
  id: "interaction-1",
  runId: "run-1",
  checkpointId: "checkpoint-1",
  timestamp: "2026-06-20T00:00:01.000Z",
  actor: "test" as const,
  kind: "click",
  target: {
    role: "button",
    name: "Save"
  }
};

const sampleRecord = {
  id: "record-1",
  runId: "run-1",
  checkpointId: "checkpoint-1",
  interactionId: "interaction-1",
  observerId: "dom",
  phase: "before" as const,
  status: "ok" as const,
  timestamp: "2026-06-20T00:00:01.100Z",
  beforeStateRef: sampleArtifact,
  rawRef: sampleArtifact,
  artifacts: [sampleArtifact],
  changes: [
    {
      path: "network.events",
      summary: "Observed new network activity.",
      before: {
        eventCount: 0
      },
      after: {
        eventCount: 2
      },
      impact: "major" as const
    }
  ]
};

const sampleFinding = {
  id: "finding-1",
  message: "Sample finding",
  severity: "info" as const,
  evidenceRecordIds: ["record-1"]
};

const sampleJudgment = {
  id: "judgment-1",
  judgeId: "release",
  scope: "run" as const,
  verdict: "pass" as const,
  summary: "Sample judgment",
  evidenceRecordIds: ["record-1"],
  findings: [sampleFinding],
  tags: ["focus-management", "interaction-state"]
};

const sampleBundle = {
  runId: "run-1",
  interaction: sampleInteraction,
  checkpoint: sampleCheckpoint,
  records: [sampleRecord],
  artifacts: [sampleArtifact],
  correlation: {
    strategy: "observer-record-grouping",
    participatingObserverIds: ["dom"]
  }
};

const sampleRun = {
  id: "run-1",
  version: "0.1.0",
  startedAt: "2026-06-20T00:00:00.000Z",
  finishedAt: "2026-06-20T00:00:02.000Z",
  status: "completed" as const,
  checkpoints: [sampleCheckpoint],
  interactions: [sampleInteraction],
  results: {
    pass: 1,
    fail: 0,
    unknown: 0
  },
  environment: {
    mode: "test"
  },
  config: {
    writeReports: true
  }
};

const remediationRegistry = JSON.parse(
  readFileSync("rules/remediation-registry.json", "utf8")
) as unknown;

test("validateSchema accepts a valid CLI config payload", () => {
  const result = validateSchema("cliConfig", {
    projectRoot: "..",
    fixturePath: "./basic-fixture.json",
    observers: ["dom", "focus"],
    interaction: {
      kind: "tab",
      actor: "test"
    }
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("assertValidSchema reports missing required CLI config properties", () => {
  assert.throws(
    () => assertValidSchema("cliConfig", { outputDir: "aee-output" }),
    /missing required property "projectRoot"/
  );
});

test("validateSchema rejects malformed nested policy values", () => {
  const result = validateSchema("cliConfig", {
    projectRoot: ".",
    fixturePath: "./fixture.json",
    policy: {
      capture: {
        includeScreenshots: "yes",
        stabilizeAfterInteractionMs: -1
      },
      release: {
        unknownBehavior: "approve-everything"
      },
      observers: {
        perObserverTimeoutMs: 0
      }
    }
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /must be boolean/);
  assert.match(result.errors.join(" "), /must be >= 0/);
  assert.match(result.errors.join(" "), /must be equal to one of the allowed values/);
  assert.match(result.errors.join(" "), /must be >= 1/);
});

test("validateSchema rejects malformed virtual page fixtures", () => {
  const result = validateSchema("virtualPageFixture", {
    url: "https://example.com"
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /missing required property "html"/);
});

test("validateSchema accepts a portable virtual screen-reader transcript", () => {
  const result = validateSchema("virtualScreenReaderTranscript", {
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.1.0",
    mode: "guide",
    fidelity: "semantic-simulation",
    physicalAssistiveTechnology: false,
    pageUrl: "https://example.com/",
    generatedAt: "2026-09-13T00:00:00.000Z",
    entries: [
      {
        sequence: 1,
        timestamp: "2026-09-13T00:00:00.000Z",
        command: "next-heading",
        announcement: "Invoices, heading, level 1",
        focusMoved: false
      }
    ]
  });

  assert.equal(result.valid, true, result.errors.join("; "));
});

test("validateSchema rejects a virtual transcript that claims physical AT fidelity", () => {
  const result = validateSchema("virtualScreenReaderTranscript", {
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.1.0",
    mode: "guide",
    fidelity: "semantic-simulation",
    physicalAssistiveTechnology: true,
    pageUrl: "https://example.com/",
    generatedAt: "2026-09-13T00:00:00.000Z",
    entries: []
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /must be equal to constant/);
});

test("validateSchema accepts a valid evidence bundle payload", () => {
  const result = validateSchema("evidenceBundle", sampleBundle);

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateSchema accepts a valid report payload", () => {
  const result = validateSchema("report", {
    schemaVersion: "0.1.0",
    run: sampleRun,
    bundles: [sampleBundle],
    records: [sampleRecord],
    judgments: [sampleJudgment],
    findings: [sampleFinding],
    artifacts: [sampleArtifact]
  });

  assert.equal(result.valid, true);
  assert.deepEqual(result.errors, []);
});

test("validateSchema accepts the canonical remediation registry", () => {
  const result = validateSchema("remediationRegistry", remediationRegistry);

  assert.equal(result.valid, true, result.errors.join("; "));
  assert.deepEqual(result.errors, []);
});

test("validateSchema rejects an AI-enabled registry entry without a specialist", () => {
  const invalidRegistry = structuredClone(remediationRegistry) as {
    entries: Array<{ ai: { specialistId?: string } }>;
  };
  delete invalidRegistry.entries[0]?.ai.specialistId;

  const result = validateSchema("remediationRegistry", invalidRegistry);

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /missing required property "specialistId"/);
});
