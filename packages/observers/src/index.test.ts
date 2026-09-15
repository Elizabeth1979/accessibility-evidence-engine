import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createAccessibilityTreeObserver,
  createAxeObserver,
  createNetworkObserver,
  createVirtualScreenReaderObserver,
  createVisualObserver,
  type RuntimeObserverContext
} from "./index";

test("createAccessibilityTreeObserver builds a normalized semantic index", async () => {
  const observer = createAccessibilityTreeObserver();
  const [record] = await observer.captureAfter!({
    runId: "run-accessibility",
    checkpointId: "checkpoint-accessibility",
    interactionId: "interaction-accessibility",
    page: {
      async content() {
        return "<h1>Invoices</h1>";
      },
      async snapshotAccessibilityTree() {
        return {
          nodes: [
            {
              role: { type: "role", value: "heading" },
              name: { type: "computedString", value: "  Invoices  " },
              properties: [{ name: "level", value: { type: "integer", value: 1 } }]
            },
            { role: "button", name: "PAY NOW" }
          ]
        };
      }
    }
  } as RuntimeObserverContext);

  assert.equal(record.status, "ok");
  assert.equal(record.observerVersion, "0.2.0");
  assert.deepEqual(record.meta, {
    semanticNodeCount: 2,
    semanticIndexTruncated: false,
    semanticNodes: [
      { role: "heading", name: "invoices", level: 1 },
      { role: "button", name: "pay now" }
    ]
  });
});

test("createVirtualScreenReaderObserver writes canonical JSON and readable text", async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), "aee-virtual-reader-"));
  const transcript = {
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
        domFocusBefore: "#pay",
        domFocusAfter: "#pay",
        focusMoved: false
      }
    ]
  };

  try {
    const observer = createVirtualScreenReaderObserver();
    const context: RuntimeObserverContext = {
      runId: "run-reader",
      checkpointId: "checkpoint-reader",
      interactionId: "interaction-reader",
      artifactDir,
      page: {
        async content() {
          return "<h1>Invoices</h1><button id='pay'>Pay</button>";
        },
        async snapshotVirtualScreenReaderTranscript() {
          return transcript;
        }
      }
    };

    const [before] = await observer.captureBefore!(context);
    transcript.entries.push({
      sequence: 2,
      timestamp: "2026-09-13T00:00:01.000Z",
      command: "next-control",
      announcement: "Pay, button",
      domFocusBefore: "#pay",
      domFocusAfter: "#pay",
      focusMoved: false
    });
    const [after] = await observer.captureAfter!(context);

    assert.equal(before.status, "ok");
    assert.equal(after.status, "ok");
    assert.equal(after.meta?.newEntryCount, 1);
    assert.equal(after.meta?.focusMovedCount, 0);
    assert.equal(after.meta?.lastAnnouncement, "Pay, button");
    assert.equal(after.artifacts?.length, 2);

    const jsonPath = after.artifacts?.find(
      ({ mediaType }) => mediaType === "application/json"
    )?.path;
    const textPath = after.artifacts?.find(({ mediaType }) => mediaType === "text/plain")?.path;
    assert.ok(jsonPath);
    assert.ok(textPath);
    assert.equal(JSON.parse(await readFile(jsonPath, "utf8")).entries.length, 2);
    assert.match(await readFile(textPath, "utf8"), /semantic simulation; not VoiceOver, NVDA/);
    assert.match(await readFile(textPath, "utf8"), /2\. next-control: Pay, button/);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("createVisualObserver captures separate viewport and full-page artifacts", async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), "aee-visual-"));
  const requestedFullPageValues: Array<boolean | undefined> = [];

  try {
    const observer = createVisualObserver();
    const context: RuntimeObserverContext = {
      runId: "run-visual",
      checkpointId: "checkpoint-visual",
      interactionId: "interaction-visual",
      artifactDir,
      page: {
        async content() {
          return "<main></main>";
        },
        async snapshotScreenshot(options) {
          requestedFullPageValues.push(options?.fullPage);
          return Uint8Array.from(options?.fullPage ? [2] : [1]);
        }
      }
    };

    const [record] = await observer.captureBefore!(context);

    assert.deepEqual(requestedFullPageValues.sort(), [false, true]);
    assert.equal(record.status, "ok");
    assert.deepEqual(record.meta, { viewportByteLength: 1, fullPageByteLength: 1 });
    assert.deepEqual(
      record.artifacts?.map(({ path: artifactPath }) => path.basename(artifactPath)).sort(),
      ["visual-full-page-before.png", "visual-viewport-before.png"]
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("createAxeObserver preserves complete pinned axe output", async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), "aee-axe-"));
  let requestedTags: string[] = [];
  const rawResult = {
    testEngine: { name: "axe-core", version: "4.13.0" },
    testRunner: { name: "axe" },
    testEnvironment: { userAgent: "test" },
    toolOptions: { runOnly: { type: "tag", values: ["wcag22aa"] } },
    timestamp: "2026-09-13T00:00:00.000Z",
    url: "https://example.com/",
    violations: [{ id: "button-name", nodes: [] }],
    passes: [{ id: "document-title", nodes: [] }],
    incomplete: [{ id: "color-contrast", nodes: [] }],
    inapplicable: [{ id: "audio-caption", nodes: [] }]
  };

  try {
    const observer = createAxeObserver();
    const context: RuntimeObserverContext = {
      runId: "run-axe",
      checkpointId: "checkpoint-axe",
      interactionId: "interaction-axe",
      artifactDir,
      page: {
        async content() {
          return "<button></button>";
        },
        async runAxeAnalysis(options) {
          requestedTags = options.tags;
          return rawResult;
        }
      }
    };

    const [record] = await observer.captureBefore!(context);
    const artifactPath = record.artifacts?.[0]?.path;

    assert.deepEqual(requestedTags, [
      "wcag2a",
      "wcag2aa",
      "wcag21a",
      "wcag21aa",
      "wcag22a",
      "wcag22aa"
    ]);
    assert.equal(record.status, "ok");
    assert.deepEqual(record.meta, {
      engineVersion: "4.13.0",
      ruleSelection: { type: "tag", values: requestedTags },
      explicitlyDisabledRuleIds: [],
      violations: 1,
      passes: 1,
      incomplete: 1,
      inapplicable: 1,
      violationRuleIds: ["button-name"],
      incompleteRuleIds: ["color-contrast"],
      evaluatedRuleIds: ["audio-caption", "button-name", "color-contrast", "document-title"]
    });
    assert.ok(artifactPath);
    assert.deepEqual(JSON.parse(await readFile(artifactPath, "utf8")), rawResult);
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("createNetworkObserver summarizes per-interaction network deltas and filters noise", async () => {
  const observer = createNetworkObserver();
  let setupCalled = false;
  let teardownCalled = false;
  let snapshot: unknown[] = [
    {
      kind: "request",
      url: "data:text/plain,bootstrap",
      method: "GET",
      timestamp: "2026-06-21T12:00:00.000Z"
    },
    {
      kind: "request",
      url: "  JAVASCRIPT:void(0)",
      method: "GET",
      timestamp: "2026-06-21T12:00:00.100Z"
    },
    {
      kind: "request",
      url: "vbscript:msgbox(1)",
      method: "GET",
      timestamp: "2026-06-21T12:00:00.200Z"
    }
  ];

  const context: RuntimeObserverContext = {
    runId: "run-1",
    checkpointId: "checkpoint-1",
    interactionId: "interaction-1",
    page: {
      async content() {
        return "<main></main>";
      },
      async setupNetworkTracking() {
        setupCalled = true;
      },
      async snapshotNetworkLog() {
        return snapshot;
      },
      async teardownNetworkTracking() {
        teardownCalled = true;
      }
    }
  };

  await observer.setup?.(context);
  const [beforeRecord] = await observer.captureBefore!(context);

  snapshot = [
    ...snapshot,
    {
      kind: "request",
      requestId: 1,
      url: "https://aee.test/api/save",
      method: "POST",
      resourceType: "fetch",
      timestamp: "2026-06-21T12:00:01.000Z"
    },
    {
      kind: "response",
      requestId: 1,
      url: "https://aee.test/api/save",
      method: "POST",
      status: 200,
      ok: true,
      timestamp: "2026-06-21T12:00:01.100Z"
    },
    {
      kind: "response",
      url: "https://aee.test/api/telemetry",
      method: "POST",
      status: 202,
      ok: true,
      timestamp: "2026-06-21T12:00:01.150Z"
    }
  ];

  const [afterRecord] = await observer.captureAfter!(context);
  await observer.teardown?.(context);

  assert.equal(setupCalled, true);
  assert.equal(teardownCalled, true);

  assert.equal(beforeRecord.status, "ok");
  assert.deepEqual(beforeRecord.meta, {
    eventCount: 3,
    interestingEventCount: 0,
    filteredNoiseCount: 3,
    requestCount: 0,
    responseCount: 0,
    matchedResponseCount: 0,
    unmatchedRequestCount: 0,
    unmatchedResponseCount: 0,
    interestingUrls: []
  });

  assert.equal(afterRecord.status, "ok");
  assert.match(afterRecord.summary ?? "", /3 new interesting network events/);
  assert.equal(afterRecord.changes?.[0]?.impact, "major");
  assert.match(afterRecord.changes?.[0]?.summary ?? "", /matched pair/);
  assert.deepEqual(afterRecord.meta, {
    eventCount: 6,
    interestingEventCount: 3,
    filteredNoiseCount: 3,
    requestCount: 1,
    responseCount: 2,
    matchedResponseCount: 1,
    unmatchedRequestCount: 0,
    unmatchedResponseCount: 1,
    interestingUrls: ["https://aee.test/api/save", "https://aee.test/api/telemetry"],
    newEventCount: 3,
    newInterestingEventCount: 3,
    newFilteredNoiseCount: 0,
    newRequestCount: 1,
    newResponseCount: 2,
    newMatchedResponseCount: 1,
    newUnmatchedRequestCount: 0,
    newUnmatchedResponseCount: 1,
    newInterestingUrls: ["https://aee.test/api/save", "https://aee.test/api/telemetry"]
  });
});

test("createNetworkObserver redacts sensitive network data before writing artifacts", async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), "aee-network-redaction-"));

  try {
    const observer = createNetworkObserver();
    const context: RuntimeObserverContext = {
      runId: "run-private",
      checkpointId: "checkpoint-private",
      interactionId: "interaction-private",
      artifactDir,
      page: {
        async content() {
          return "<main></main>";
        },
        async snapshotNetworkLog() {
          return [
            {
              kind: "request",
              requestId: 1,
              url: "https://user:password@aee.test/api/save?token=top-secret#private",
              method: "POST",
              resourceType: "fetch",
              headers: {
                authorization: "Bearer private-token",
                "x-trace-id": "private-trace"
              },
              postData: JSON.stringify({ email: "private@example.com" }),
              body: "unrecognized-private-payload",
              timestamp: "2026-06-21T12:00:01.000Z"
            },
            {
              kind: "request",
              requestId: { secret: "nested-request-id" },
              url: "not-a-url?nested-url-secret",
              statusText: { secret: "nested-status-secret" },
              ok: { secret: "nested-ok-secret" }
            }
          ];
        }
      }
    };

    const [record] = await observer.captureBefore!(context);
    const artifactPath = record.artifacts?.[0]?.path;
    assert.ok(artifactPath, "Expected a network artifact path.");

    const content = await readFile(artifactPath, "utf8");
    assert.doesNotMatch(
      content,
      /top-secret|private-token|private-trace|private@example|password|private-payload|nested-/
    );

    const [event, malformedEvent] = JSON.parse(content) as Array<Record<string, unknown>>;
    assert.equal(event.url, "https://aee.test/api/save?token=%5BREDACTED%5D");
    assert.deepEqual(event.headers, {
      authorization: "[REDACTED]",
      "x-trace-id": "[REDACTED]"
    });
    assert.equal(event.postData, "[REDACTED]");
    assert.equal(event.body, undefined);
    assert.deepEqual(malformedEvent, {
      kind: "request",
      url: "[REDACTED]"
    });
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});
