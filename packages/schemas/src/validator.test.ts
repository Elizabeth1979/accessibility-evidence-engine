import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020";
import addFormats from "ajv-formats";
import axe from "axe-core";

import { schemaCatalog, type SchemaName } from "./index";
import {
  conceptForAxeRule,
  patternForAxeRule,
  remediationRegistry,
  type RemediationRegistry
} from "./remediation-registry";
import { assertValidSchema, bundledSchema, validateSchema } from "./validator";

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
        stabilizeAfterInteractionMs: -1,
        watchWithoutInputMs: 1.5
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
  assert.match(result.errors.join(" "), /watchWithoutInputMs must be integer/);
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
    engineVersion: "0.3.0",
    speechEngine: "@guidepup/virtual-screen-reader 0.33.0",
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
        announcement: "heading, Invoices, level 1",
        item: {
          key: "main > h1",
          nodePath: "main > h1",
          tagName: "h1",
          role: "heading",
          name: "Invoices",
          level: 1,
          states: [],
          visualBounds: { x: 20, y: 40, width: 240, height: 48 }
        },
        focusMoved: false
      }
    ]
  });

  assert.equal(result.valid, true, result.errors.join("; "));
});

test("validateSchema accepts a transcript item with every state, the description and the value Chrome gives", () => {
  const result = validateSchema("virtualScreenReaderTranscript", {
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.3.0",
    speechEngine: "@guidepup/virtual-screen-reader 0.33.0",
    mode: "guide",
    fidelity: "semantic-simulation",
    physicalAssistiveTechnology: false,
    pageUrl: "https://example.com/",
    generatedAt: "2026-09-13T00:00:00.000Z",
    entries: [
      {
        sequence: 1,
        timestamp: "2026-09-13T00:00:00.000Z",
        command: "next-control",
        announcement: "button, Filters, collapsed, has popup menu",
        item: {
          key: "#filters#start",
          nodePath: "#filters",
          tagName: "button",
          role: "button",
          name: "Filters",
          description: "Narrows the list by status",
          value: "",
          states: ["collapsed"],
          properties: [
            { name: "hasPopup", value: { type: "token", value: "menu" } },
            { name: "expanded", value: { type: "booleanOrUndefined", value: false } },
            {
              name: "describedby",
              value: {
                type: "idrefList",
                value: "filters-hint",
                relatedNodes: [{ backendDOMNodeId: 13, idref: "filters-hint" }]
              }
            }
          ],
          backendDOMNodeId: 12
        },
        focusMoved: false
      }
    ]
  });

  assert.equal(result.valid, true, result.errors.join("; "));
});

test("validateSchema accepts a transcript step into a frame, with the frames it left and entered", () => {
  const frame = (frameId: string, framePath: string[], name: string) => ({
    frameId,
    framePath,
    name
  });
  const result = validateSchema("virtualScreenReaderTranscript", {
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.3.0",
    speechEngine: "@guidepup/virtual-screen-reader 0.32.1",
    mode: "guide",
    fidelity: "semantic-simulation",
    physicalAssistiveTechnology: false,
    pageUrl: "https://example.com/",
    generatedAt: "2026-10-17T00:00:00.000Z",
    entries: [
      {
        sequence: 1,
        timestamp: "2026-10-17T00:00:00.000Z",
        command: "next-heading",
        announcement: "heading, Shipping, level 2",
        framesLeft: [frame("frame-billing", ["#billing"], "Billing")],
        framesEntered: [frame("frame-shipping", ["#shipping"], "Shipping")],
        item: {
          key: "#shipping >>> body > h2#start",
          nodePath: "body > h2",
          tagName: "h2",
          role: "heading",
          name: "Shipping",
          level: 2,
          states: [],
          frameId: "frame-shipping",
          framePath: ["#shipping"]
        },
        domFocusBefore: { nodePath: "#pay", backendDOMNodeId: 9, frameId: "frame-top" },
        domFocusAfter: {
          nodePath: "body > button",
          backendDOMNodeId: 9,
          frameId: "frame-billing",
          framePath: ["#billing"]
        },
        focusMoved: true
      }
    ]
  });

  assert.equal(result.valid, true, result.errors.join("; "));
});

test("validateSchema rejects DOM focus named only by a path, with no frame", () => {
  const result = validateSchema("virtualScreenReaderTranscript", {
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.3.0",
    speechEngine: "@guidepup/virtual-screen-reader 0.32.1",
    mode: "guide",
    fidelity: "semantic-simulation",
    physicalAssistiveTechnology: false,
    pageUrl: "https://example.com/",
    generatedAt: "2026-10-17T00:00:00.000Z",
    entries: [
      {
        sequence: 1,
        timestamp: "2026-10-17T00:00:00.000Z",
        command: "next-item",
        announcement: "button, Pay now",
        domFocusBefore: "#billing",
        focusMoved: false
      }
    ]
  });

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /domFocusBefore must be object/);
});

test("validateSchema accepts an image the tree leaves out, with Chrome's reasons", () => {
  const result = validateSchema("elementMap", {
    schemaVersion: "0.1.0",
    captureType: "element-map",
    elements: [
      {
        kind: "image",
        role: "none",
        name: "",
        alt: "ignored",
        ignoredReasons: ["emptyAlt"],
        selector: "header > img",
        box: { x: 0, y: 0, width: 40, height: 40 }
      }
    ]
  });

  assert.equal(result.valid, true, result.errors.join("; "));
});

test("validateSchema rejects a virtual transcript that claims physical AT fidelity", () => {
  const result = validateSchema("virtualScreenReaderTranscript", {
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.3.0",
    speechEngine: "@guidepup/virtual-screen-reader 0.33.0",
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

test("validateSchema checks a transcript's live-region announcements", () => {
  const transcript = (politeness: string) => ({
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.3.0",
    speechEngine: "@guidepup/virtual-screen-reader 0.32.1",
    mode: "guide",
    fidelity: "semantic-simulation",
    physicalAssistiveTechnology: false,
    pageUrl: "https://example.com/",
    generatedAt: "2026-09-13T00:00:00.000Z",
    entries: [],
    liveRegionAnnouncements: [
      { sequence: 1, timestamp: "2026-09-13T00:00:00.000Z", politeness, text: "Saved" }
    ]
  });

  const valid = validateSchema("virtualScreenReaderTranscript", transcript("polite"));
  assert.equal(valid.valid, true, valid.errors.join("; "));
  // aria-live="off" is never announced, so it is never recorded as an announcement.
  assert.equal(validateSchema("virtualScreenReaderTranscript", transcript("off")).valid, false);
});

test("validateSchema checks the accessibility changes an accessibility-tree record carries", () => {
  const record = (kind: string) => ({
    id: "accessibility-tree:after:1",
    runId: "run-1",
    observerId: "accessibility-tree",
    phase: "after",
    status: "ok",
    timestamp: "2026-09-13T00:00:00.000Z",
    meta: {
      accessibilityChanges: {
        focusedBefore: { nodeId: 4, role: "checkbox", name: "Agree" },
        changes: [
          {
            nodeId: 4,
            role: "checkbox",
            name: "Agree",
            kind,
            state: "checked",
            before: "false",
            after: "true"
          }
        ],
        truncated: false
      }
    }
  });

  const valid = validateSchema("evidenceRecord", record("state"));
  assert.equal(valid.valid, true, valid.errors.join("; "));
  const invalid = validateSchema("evidenceRecord", record("moved"));
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join(" "), /accessibilityChanges\/changes\/0\/kind/);
});

test("validateSchema checks the new live-region announcements a reader record carries", () => {
  const result = validateSchema("evidenceRecord", {
    id: "virtual-screen-reader:after:1",
    runId: "run-1",
    observerId: "virtual-screen-reader",
    phase: "after",
    status: "ok",
    timestamp: "2026-09-13T00:00:00.000Z",
    meta: { newLiveRegionAnnouncements: [{ politeness: "polite", text: "Saved" }] }
  });

  assert.equal(result.valid, false);
  assert.match(
    result.errors.join(" "),
    /newLiveRegionAnnouncements\/0 is missing required property "sequence"/
  );
});

test("validateSchema checks what the page did on its own before a press, and the live regions changes are in", () => {
  const clock = {
    nodeId: 2,
    role: "region",
    name: "Clock",
    politeness: "polite",
    text: "10:00:02"
  };
  const treeRecord = (region: Record<string, unknown>) => ({
    id: "accessibility-tree:before:1",
    runId: "run-1",
    observerId: "accessibility-tree",
    phase: "before",
    status: "ok",
    timestamp: "2026-09-13T00:00:00.000Z",
    meta: {
      accessibilityChangesWithoutInput: {
        changes: [
          {
            nodeId: 3,
            role: "StaticText",
            name: "10:00:02",
            kind: "name",
            before: "10:00:01",
            after: "10:00:02"
          }
        ],
        truncated: false,
        liveRegions: [region]
      }
    }
  });

  const valid = validateSchema("evidenceRecord", treeRecord(clock));
  assert.equal(valid.valid, true, valid.errors.join("; "));
  const offRegion = validateSchema("evidenceRecord", treeRecord({ ...clock, politeness: "off" }));
  assert.equal(offRegion.valid, false);
  assert.match(
    offRegion.errors.join(" "),
    /accessibilityChangesWithoutInput\/liveRegions\/0\/politeness/
  );

  const heard = validateSchema("evidenceRecord", {
    id: "virtual-screen-reader:before:1",
    runId: "run-1",
    observerId: "virtual-screen-reader",
    phase: "before",
    status: "ok",
    timestamp: "2026-09-13T00:00:00.000Z",
    meta: { liveRegionAnnouncementsWithoutInput: [{ politeness: "polite", text: "10:00:01" }] }
  });
  assert.equal(heard.valid, false);
  assert.match(
    heard.errors.join(" "),
    /liveRegionAnnouncementsWithoutInput\/0 is missing required property "sequence"/
  );
});

test("validateSchema accepts an isolated virtual screen-reader lane", () => {
  const entry = {
    sequence: 1,
    timestamp: "2026-09-14T00:00:01.000Z",
    command: "next-heading",
    announcement: "heading, Invoices, level 1",
    focusMoved: false
  };
  const transcript = {
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.3.0",
    speechEngine: "@guidepup/virtual-screen-reader 0.33.0",
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
    documentHasFocus: true,
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

test("validateSchema accepts focus inside a frame, named with its frame", () => {
  const indicator = {
    visible: false,
    outlineStyle: "none",
    outlineWidth: "0px",
    boxShadow: "none"
  };
  const frameElement = {
    tagName: "iframe",
    id: "pay",
    nodePath: "iframe#pay",
    frameId: "TOP",
    backendDOMNodeId: 9,
    focusVisible: false,
    focusIndicator: indicator
  };
  const button = {
    tagName: "button",
    role: "button",
    name: "Pay now",
    nodePath: "html > body > button",
    frameId: "PAY",
    framePath: ["iframe#pay"],
    backendDOMNodeId: 4,
    focusOrderIndex: 2,
    focusableCount: 5,
    focusVisible: true,
    focusIndicator: indicator
  };
  const focusState = {
    schemaVersion: "0.1.0",
    captureType: "deep-focus-state",
    documentHasFocus: true,
    ...button,
    documentActiveElement: frameElement,
    deepActiveElement: button,
    activeElementChain: [
      { context: "document", ...frameElement },
      { context: "iframe-document", ...button }
    ],
    accessibilityFocus: { status: "matched", backendDOMNodeId: 4, frameId: "PAY" }
  };

  assert.deepEqual(validateSchema("focusState", focusState), { valid: true, errors: [] });
  // A frame path names at least one frame; an element in the top document has none.
  assert.equal(
    validateSchema("focusState", { ...focusState, deepActiveElement: { ...button, framePath: [] } })
      .valid,
    false
  );
  // Every capture says whether the page had focus: a <body> means lost focus only while it did.
  const withoutPageFocus: Record<string, unknown> = { ...focusState };
  delete withoutPageFocus.documentHasFocus;
  assert.equal(validateSchema("focusState", withoutPageFocus).valid, false);
  // A place in the page's tab order counts from 0.
  assert.equal(
    validateSchema("focusState", {
      ...focusState,
      deepActiveElement: { ...button, focusOrderIndex: -1 }
    }).valid,
    false
  );
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

test("validateSchema accepts an integrated scenario report", () => {
  const result = validateSchema("scenarioReport", {
    schemaVersion: "0.1.0",
    assessmentId: "scenario-assessment-1",
    scenarioId: "scenario-assessment",
    scenarioDigest: `sha256:${"a".repeat(64)}`,
    planDigest: `sha256:${"b".repeat(64)}`,
    profile: "core",
    target: "https://example.com/",
    goal: "Evaluate an approved public journey.",
    standard: "WCAG 2.2 A/AA",
    status: "completed",
    verdict: "pass",
    startedAt: "2026-09-14T00:00:00.000Z",
    finishedAt: "2026-09-14T00:01:00.000Z",
    completeness: {
      status: "complete",
      plannedLanes: 1,
      completedLanes: 1,
      missingArtifacts: 0,
      failedArtifacts: 0,
      plannedChecks: { keyboard: false, reader: true }
    },
    summary: {
      actions: 1,
      passed: 1,
      failed: 0,
      unknown: 0,
      findings: 0,
      advisories: 0,
      artifacts: 1
    },
    journeys: [
      { id: "journey", name: "Journey", goal: "Read content", startUrl: "https://example.com/" }
    ],
    actions: [],
    findings: [],
    synthesis: {
      conclusion: "The authored reader command passed cross-evidence validation.",
      directJudgments: { passed: 1, failed: 0, unknown: 0 },
      releaseGates: { passed: 1, failed: 0, unknown: 0 },
      findingOccurrences: 0,
      affectedInstancesAtLargestCheckpoint: 0,
      incompleteRuleResults: 0,
      uniqueIncompleteRules: [],
      lanes: [],
      comparisons: [],
      reader: { commands: 1, passed: 1, failed: 0, unknown: 0 },
      status: [
        {
          id: "reader",
          label: "Virtual reader",
          verdict: "pass",
          result: "Pass",
          detail: "Every authored reader command matched the page."
        }
      ],
      findings: [],
      undecidedContrast: []
    },
    artifacts: [],
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
    ai: { present: false, label: "AI-generated analysis: none in this report." }
  });

  assert.deepEqual(result, { valid: true, errors: [] });
});

test("a bundled schema resolves every reference without AEE's other schema files", () => {
  // The report refers to the run, which refers to the checkpoint and interaction in turn.
  const bundled = bundledSchema("report");
  assert.deepEqual(Object.keys(bundled.$defs ?? {}).sort(), [
    "checkpoint",
    "common",
    "evidenceBundle",
    "evidenceRecord",
    "finding",
    "interaction",
    "judgment",
    "run"
  ]);
  const standalone = new Ajv2020({ allErrors: true });
  addFormats(standalone);
  assert.doesNotThrow(() => standalone.compile(bundled));
  for (const name of Object.keys(schemaCatalog) as SchemaName[]) {
    assert.doesNotThrow(() => addFormats(new Ajv2020()).compile(bundledSchema(name)), name);
  }
});

test("validateSchema accepts the canonical remediation registry", () => {
  const result = validateSchema("remediationRegistry", remediationRegistry);

  assert.equal(result.valid, true, result.errors.join("; "));
  assert.deepEqual(result.errors, []);
});

test("each axe rule a registry entry detects links to one of that entry's patterns", () => {
  const registry: RemediationRegistry = remediationRegistry;
  const detected = registry.entries.flatMap((entry) =>
    entry.requirements
      .filter((r) => r.standard === "axe-core")
      .map((r) => ({ entry, rule: r.requirementId }))
  );

  assert.ok(detected.length > 0);
  for (const { entry, rule } of detected) {
    const pattern = patternForAxeRule(rule)?.id;
    assert.ok(pattern && entry.patterns.includes(pattern), `${entry.id}: ${rule} → ${pattern}`);
  }
});

// a11y-skills is pinned to a commit in @aee/mcp, which serves its patterns; each pattern id names a file there.
const skillsRoot = path.dirname(require.resolve("a11y-skills/package.json"));

function patternFileExists(id: string): boolean {
  return existsSync(path.join(skillsRoot, "patterns", `${id}.instructions.md`));
}

function missingPatternFiles(registry: RemediationRegistry): string[] {
  const ids = [
    ...registry.entries.flatMap((entry) => entry.patterns),
    ...Object.values(registry.axeRulePatterns)
  ];
  return [...new Set(ids)].filter((id) => !patternFileExists(id));
}

test("every registry pattern points to a file in the pinned a11y-skills", () => {
  assert.deepEqual(missingPatternFiles(remediationRegistry), []);
});

test("a renamed or missing pattern file is caught", () => {
  const renamed: RemediationRegistry = structuredClone(remediationRegistry);
  renamed.entries[0]!.patterns.push("buttons-renamed");

  assert.deepEqual(missingPatternFiles(renamed), ["buttons-renamed"]);
});

test("the registry links patterns at the same a11y-skills commit the engine installs", () => {
  const mcpPackage = JSON.parse(readFileSync("packages/mcp/package.json", "utf8")) as {
    dependencies: Record<string, string>;
  };
  const pinned = mcpPackage.dependencies["a11y-skills"]!.split("#")[1];

  assert.equal(remediationRegistry.patternSource.commit, pinned);
});

test("every mapped axe rule is a real rule and links to its pattern file", async (t) => {
  const axeRules = new Set(axe.getRules().map((rule) => rule.ruleId));

  for (const [rule, pattern] of Object.entries(remediationRegistry.axeRulePatterns)) {
    await t.test(`${rule} → ${pattern}`, () => {
      assert.ok(axeRules.has(rule), `${rule} is not an axe-core rule`);
      assert.ok(patternFileExists(pattern), `${pattern} is not an a11y-skills pattern`);
    });
  }
});

test("patternForAxeRule links a mapped rule to its pattern file", () => {
  assert.deepEqual(patternForAxeRule("button-name"), {
    id: "buttons",
    url: `https://github.com/Elizabeth1979/a11y-skills/blob/${remediationRegistry.patternSource.commit}/patterns/buttons.instructions.md`
  });
  assert.equal(patternForAxeRule("not-a-mapped-rule"), undefined);
  assert.equal(patternForAxeRule("constructor"), undefined);
});

test("conceptForAxeRule finds the concept that lists the rule as detection", () => {
  assert.equal(conceptForAxeRule("button-name")?.id, "accessible-name");
  assert.equal(conceptForAxeRule("image-alt")?.id, "image-purpose");
  assert.equal(conceptForAxeRule("not-a-mapped-rule"), undefined);
});

test("validateSchema rejects a registry without axe rule patterns", () => {
  const invalidRegistry: Partial<RemediationRegistry> = structuredClone(remediationRegistry);
  delete invalidRegistry.axeRulePatterns;

  const result = validateSchema("remediationRegistry", invalidRegistry);

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /missing required property "axeRulePatterns"/);
});

test("validateSchema rejects a registry entry without patterns", () => {
  const invalidRegistry = structuredClone(remediationRegistry) as {
    entries: Array<{ patterns?: string[] }>;
  };
  delete invalidRegistry.entries[0]?.patterns;

  const result = validateSchema("remediationRegistry", invalidRegistry);

  assert.equal(result.valid, false);
  assert.match(result.errors.join(" "), /missing required property "patterns"/);
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
