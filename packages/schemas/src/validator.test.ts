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

const evidenceManifestExample = JSON.parse(
  readFileSync("docs/examples/evidence-run-manifest.example.json", "utf8")
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

test("validateSchema accepts an isolated virtual screen-reader lane", () => {
  const entry = {
    sequence: 1,
    timestamp: "2026-09-14T00:00:01.000Z",
    command: "next-heading",
    announcement: "Invoices, heading, level 1",
    focusMoved: false
  };
  const transcript = {
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.1.0",
    mode: "guide",
    fidelity: "semantic-simulation",
    physicalAssistiveTechnology: false,
    pageUrl: "https://example.com/",
    generatedAt: "2026-09-14T00:00:02.000Z",
    entries: [entry]
  };
  const result = validateSchema("virtualScreenReaderLane", {
    schemaVersion: "0.1.0",
    laneId: "reader-lane",
    driver: "portable-virtual-screen-reader",
    isolation: "dedicated-browser-context",
    status: "completed",
    targetUrl: "https://example.com/",
    allowedOrigins: ["https://example.com"],
    startedAt: "2026-09-14T00:00:00.000Z",
    finishedAt: "2026-09-14T00:00:03.000Z",
    transcriptJsonFile: "/tmp/transcript.json",
    transcriptTextFile: "/tmp/transcript.txt",
    manifestFile: "/tmp/manifest.json",
    video: {
      videoFile: "/tmp/video.webm",
      sidecarFile: "/tmp/video.json",
      captionsFile: "/tmp/video.vtt"
    },
    steps: [
      {
        sequence: 1,
        command: "next-heading",
        runId: "reader-lane-001",
        pageUrl: "https://example.com/",
        entry,
        results: { pass: 2, fail: 0, unknown: 0 },
        releaseVerdict: "pass",
        reporterFiles: ["/tmp/report.md"],
        artifactFiles: ["/tmp/full-page.png"]
      }
    ],
    transcript
  });

  assert.equal(result.valid, true, result.errors.join("; "));
});

test("validateSchema accepts a user-authored input comparison request", () => {
  const result = validateSchema("interactionComparisonRequest", {
    id: "menu-equivalence",
    name: "Menu opens with pointer and keyboard",
    pointerActions: [{ id: "click-menu", kind: "click", target: { role: "button", name: "Menu" } }],
    keyboardActions: [
      { id: "focus-menu", kind: "focus", target: { role: "button", name: "Menu" } },
      { id: "press-enter", kind: "press", key: "Enter" }
    ],
    observe: {
      target: { selector: "#menu" },
      visible: true,
      attributes: ["aria-hidden"]
    },
    expected: { visible: true, attributes: { "aria-hidden": "false" } }
  });

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateSchema accepts an interaction video sidecar", () => {
  const result = validateSchema("interactionVideo", {
    schemaVersion: "0.1.0",
    laneId: "keyboard-lane",
    driver: "keyboard",
    status: "completed",
    startedAt: "2026-09-14T00:00:00.000Z",
    finishedAt: "2026-09-14T00:00:01.000Z",
    video: {
      path: "keyboard/video.webm",
      mediaType: "video/webm",
      captionsPath: "keyboard/video.vtt"
    },
    actions: [
      {
        id: "press-enter",
        sequence: 1,
        label: "Press Enter",
        startedAt: "2026-09-14T00:00:00.100Z",
        finishedAt: "2026-09-14T00:00:00.300Z",
        offsetMs: 100,
        durationMs: 200
      }
    ],
    privacy: {
      classification: "sensitive",
      reviewedForSharing: false,
      shareable: false
    }
  });

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateSchema accepts a deep focus-state artifact", () => {
  const element = {
    tagName: "button",
    id: "save",
    nodePath: "button#save",
    focusVisible: true,
    focusIndicator: {
      visible: true,
      outlineColor: "rgb(0, 0, 0)",
      outlineStyle: "auto",
      outlineWidth: "1px",
      boxShadow: "none"
    }
  };
  const result = validateSchema("focusState", {
    schemaVersion: "0.1.0",
    captureType: "deep-focus-state",
    ...element,
    documentActiveElement: element,
    deepActiveElement: element,
    activeElementChain: [{ context: "document", ...element }],
    accessibilityFocus: {
      status: "matched",
      nodeId: "7",
      backendDOMNodeId: 14,
      role: "button",
      name: "Save"
    }
  });

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateSchema rejects input actions whose operation is ambiguous", () => {
  const result = validateSchema("interactionComparisonRequest", {
    id: "ambiguous-menu",
    name: "Ambiguous menu action",
    pointerActions: [{ id: "bad-hover", kind: "hover" }],
    keyboardActions: [{ id: "bad-press", kind: "press" }],
    observe: { url: true }
  });

  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test("validateSchema accepts a checksummed evidence manifest", () => {
  const result = validateSchema("evidenceManifest", {
    schemaVersion: "0.1.0",
    assessmentId: "assessment-001",
    status: "completed",
    createdAt: "2026-09-14T00:00:00.000Z",
    root: ".",
    lanes: [
      {
        id: "keyboard-lane",
        driver: "keyboard",
        status: "completed",
        actionIds: [],
        actions: []
      }
    ],
    artifacts: [],
    summary: { total: 0, available: 0, missing: 0, failed: 0 },
    privacy: {
      defaultClassification: "sensitive",
      reviewedForSharing: false,
      remoteUploadAuthorized: false
    }
  });

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("validateSchema accepts the documented evidence manifest example", () => {
  const result = validateSchema("evidenceManifest", evidenceManifestExample);

  assert.deepEqual(result, { valid: true, errors: [] });
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
