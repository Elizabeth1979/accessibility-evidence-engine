import assert from "node:assert/strict";
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
    eventCount: 1,
    interestingEventCount: 0,
    filteredNoiseCount: 1,
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
    eventCount: 4,
    interestingEventCount: 3,
    filteredNoiseCount: 1,
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
