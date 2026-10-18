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
  type AxeAnalysisOptions,
  type RuntimeObserverContext
} from "./index";

test("createAccessibilityTreeObserver indexes whole tree nodes by their DOM node", async () => {
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
              nodeId: "1",
              ignored: false,
              backendDOMNodeId: 7,
              role: { type: "role", value: "heading" },
              name: { type: "computedString", value: "  Invoices  " },
              description: { type: "computedString", value: "Unpaid this month" },
              properties: [{ name: "level", value: { type: "integer", value: 1 } }],
              childIds: ["2"]
            },
            {
              nodeId: "2",
              ignored: true,
              ignoredReasons: [
                { name: "ariaHiddenElement", value: { type: "boolean", value: true } }
              ],
              backendDOMNodeId: 8,
              role: { type: "role", value: "none" }
            },
            {
              nodeId: "3",
              ignored: false,
              backendDOMNodeId: 9,
              role: { type: "role", value: "textbox" },
              name: { type: "computedString", value: "Search" },
              value: { type: "string", value: "invoices" },
              properties: [
                { name: "focusable", value: { type: "booleanOrUndefined", value: true } },
                {
                  name: "describedby",
                  value: {
                    type: "nodeList",
                    relatedNodes: [{ backendDOMNodeId: 10, idref: "hint", text: "Press Enter" }]
                  }
                }
              ]
            },
            // A node no DOM node backs cannot be joined to what the reader read.
            { nodeId: "4", ignored: false, role: { type: "internalRole", value: "RootWebArea" } }
          ]
        };
      }
    }
  } as RuntimeObserverContext);

  assert.equal(record.status, "ok");
  assert.equal(record.observerVersion, "0.3.0");
  assert.deepEqual(record.meta, {
    semanticNodeCount: 3,
    semanticIndexTruncated: false,
    semanticNodes: [
      {
        backendDOMNodeId: 7,
        role: "heading",
        name: "  Invoices  ",
        description: "Unpaid this month",
        ignored: false,
        properties: [{ name: "level", value: { type: "integer", value: 1 } }]
      },
      {
        backendDOMNodeId: 8,
        role: "none",
        ignored: true,
        ignoredReasons: ["ariaHiddenElement"],
        properties: []
      },
      {
        backendDOMNodeId: 9,
        role: "textbox",
        name: "Search",
        value: "invoices",
        ignored: false,
        properties: [
          { name: "focusable", value: { type: "booleanOrUndefined", value: true } },
          {
            name: "describedby",
            value: {
              type: "nodeList",
              relatedNodes: [{ backendDOMNodeId: 10, idref: "hint", text: "Press Enter" }]
            }
          }
        ]
      }
    ]
  });
});

test("createAccessibilityTreeObserver records what changed between before and after", async () => {
  const observer = createAccessibilityTreeObserver();
  let checked = "false";
  const context: RuntimeObserverContext = {
    runId: "run-accessibility-change",
    page: {
      async content() {
        return '<input type="checkbox" aria-label="Agree">';
      },
      async snapshotAccessibilityTree() {
        return {
          nodes: [
            {
              nodeId: "4",
              ignored: false,
              role: { type: "role", value: "checkbox" },
              name: { type: "computedString", value: "Agree" },
              properties: [
                { name: "focused", value: { type: "booleanOrUndefined", value: true } },
                { name: "checked", value: { type: "tristate", value: checked } }
              ],
              backendDOMNodeId: 4
            }
          ]
        };
      }
    }
  };

  const [before] = await observer.captureBefore!(context);
  checked = "true";
  const [after] = await observer.captureAfter!(context);

  assert.equal(before.meta?.accessibilityChanges, undefined);
  assert.deepEqual(after.meta?.accessibilityChanges, {
    focusedBefore: { nodeId: 4, role: "checkbox", name: "Agree" },
    focusedAfter: { nodeId: 4, role: "checkbox", name: "Agree" },
    changes: [
      {
        nodeId: 4,
        role: "checkbox",
        name: "Agree",
        kind: "state",
        state: "checked",
        before: "false",
        after: "true"
      }
    ],
    truncated: false
  });
  assert.deepEqual(after.changes, [
    {
      path: "accessibility.checked",
      summary: 'checkbox "Agree" checked changed from false to true.',
      before: "false",
      after: "true",
      impact: "major"
    }
  ]);
  assert.match(after.summary ?? "", /1 change, 1 of them control state/);
});

test("the virtual-reader observer listens before the press and keeps only its live-region announcements", async () => {
  const announcement = (sequence: number, text: string) => ({
    sequence,
    timestamp: "2026-09-13T00:00:00.000Z",
    politeness: "polite" as const,
    text
  });
  // A message from before this press must not count as its response.
  const transcript = { entries: [], liveRegionAnnouncements: [announcement(1, "Loaded")] };
  let listening = false;
  const observer = createVirtualScreenReaderObserver();
  const context: RuntimeObserverContext = {
    runId: "run-reader-live",
    page: {
      async content() {
        return '<div role="status"></div>';
      },
      async listenVirtualScreenReader() {
        listening = true;
      },
      async snapshotVirtualScreenReaderTranscript() {
        return transcript;
      }
    }
  };

  await observer.setup!(context);
  const [before] = await observer.captureBefore!(context);
  transcript.liveRegionAnnouncements.push(announcement(2, "Saved"));
  const [after] = await observer.captureAfter!(context);

  assert.equal(listening, true);
  assert.equal(before.meta?.newLiveRegionAnnouncements, undefined);
  assert.deepEqual(after.meta?.newLiveRegionAnnouncements, [announcement(2, "Saved")]);
});

test("createVirtualScreenReaderObserver writes canonical JSON and readable text", async () => {
  const artifactDir = await mkdtemp(path.join(tmpdir(), "aee-virtual-reader-"));
  const transcript = {
    schemaVersion: "0.1.0",
    engine: "aee-portable-virtual-screen-reader",
    engineVersion: "0.3.0",
    speechEngine: "@guidepup/virtual-screen-reader 0.33.0",
    mode: "guide",
    fidelity: "semantic-simulation",
    physicalAssistiveTechnology: false,
    pageUrl: "https://example.com/",
    generatedAt: "2026-09-13T00:00:00.000Z",
    // A later entry also says which frames the reader left.
    entries: [
      {
        sequence: 1,
        timestamp: "2026-09-13T00:00:00.000Z",
        command: "next-heading",
        announcement: "heading, Invoices, level 1",
        domFocusBefore: { nodePath: "#pay", backendDOMNodeId: 7, frameId: "frame-top" },
        domFocusAfter: { nodePath: "#pay", backendDOMNodeId: 7, frameId: "frame-top" },
        focusMoved: false
      }
    ] as Array<Record<string, unknown>>
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

    await observer.setup!(context);
    const [before] = await observer.captureBefore!(context);
    // Focus on a button inside a frame is named by the frame element and the button's own path.
    const inBilling = {
      nodePath: "button",
      backendDOMNodeId: 4,
      frameId: "frame-billing",
      framePath: ["#billing"]
    };
    transcript.entries.push({
      sequence: 2,
      timestamp: "2026-09-13T00:00:01.000Z",
      command: "next-control",
      announcement: "Pay, button",
      framesLeft: [{ frameId: "frame-billing", framePath: ["#billing"], name: "Billing" }],
      domFocusBefore: inBilling,
      domFocusAfter: inBilling,
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
    // Leaving a frame is AEE's note, on its own line before the step, not part of what was said.
    assert.match(
      await readFile(textPath, "utf8"),
      /\nAEE: left frame Billing\n2\. next-control: Pay, button\n/
    );
    assert.match(
      await readFile(textPath, "utf8"),
      /\n {3}DOM focus: #billing >>> button -> #billing >>> button; moved: no\n/
    );
  } finally {
    await rm(artifactDir, { recursive: true, force: true });
  }
});

test("a reader command captured only after it still counts only its own entries", async () => {
  const entry = (sequence: number, focusMoved: boolean) => ({
    sequence,
    timestamp: "2026-09-13T00:00:00.000Z",
    command: "next-item",
    announcement: `Item ${sequence}`,
    focusMoved
  });
  // An earlier command moved focus; this run's command must not be blamed for it.
  const transcript = { entries: [entry(1, true)] };
  const observer = createVirtualScreenReaderObserver();
  const context: RuntimeObserverContext = {
    runId: "run-reader-once",
    page: {
      async content() {
        return "<main></main>";
      },
      async snapshotVirtualScreenReaderTranscript() {
        return transcript;
      }
    }
  };

  await observer.setup!(context);
  transcript.entries.push(entry(2, false));
  const [after] = await observer.captureAfter!(context);

  assert.equal(after.meta?.newEntryCount, 1);
  assert.equal(after.meta?.focusMovedCount, 0);
  assert.equal(after.meta?.lastAnnouncement, "Item 2");
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
  let requested: AxeAnalysisOptions | undefined;
  const rawResult = {
    testEngine: { name: "axe-core", version: "4.14.0" },
    testRunner: { name: "axe" },
    testEnvironment: { userAgent: "test" },
    toolOptions: { runOnly: { type: "tag", values: ["wcag22aa"] } },
    timestamp: "2026-09-13T00:00:00.000Z",
    url: "https://example.com/",
    violations: [
      { id: "button-name", tags: ["cat.name-role-value", "wcag2a", "wcag412"], nodes: [] },
      { id: "empty-heading", tags: ["cat.name-role-value", "best-practice"], nodes: [] }
    ],
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
          requested = options;
          return rawResult;
        }
      }
    };

    const [record] = await observer.captureBefore!(context);
    const artifactPath = record.artifacts?.[0]?.path;

    const wcagTags = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22a", "wcag22aa"];
    assert.deepEqual(requested, {
      tags: [...wcagTags, "best-practice"],
      experimentalTags: wcagTags
    });
    assert.equal(record.status, "ok");
    assert.deepEqual(record.meta, {
      engineVersion: "4.14.0",
      ruleSelection: {
        type: "tag",
        values: requested!.tags,
        experimentalTags: requested!.experimentalTags
      },
      explicitlyDisabledRuleIds: [],
      violations: 1,
      passes: 1,
      incomplete: 1,
      inapplicable: 1,
      violationRuleIds: ["button-name"],
      advisoryRuleIds: ["empty-heading"],
      incompleteRuleIds: ["color-contrast"],
      evaluatedRuleIds: [
        "audio-caption",
        "button-name",
        "color-contrast",
        "document-title",
        "empty-heading"
      ]
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
