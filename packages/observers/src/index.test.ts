import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createNetworkObserver, type RuntimeObserverContext } from "./index";

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
