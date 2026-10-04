import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { reportsRequests, trackOpenRequests, waitForQuietPage } from "./quiet-page";

/** A page whose requests the test opens and ends, and that records when its DOM is read. */
function standInPage() {
  const events = new EventEmitter();
  const reads: string[] = [];
  return {
    events,
    reads,
    on: (event: string, listener: (request: object) => void) => events.on(event, listener),
    off: (event: string, listener: (request: object) => void) => events.off(event, listener),
    // The DOM is quiet at once: the stand-in records each wait for it.
    evaluate: async () => {
      reads.push("DOM read");
    }
  };
}

test("a page that is still loading its data is read once the data has arrived", async () => {
  const page = standInPage();
  const openRequests = trackOpenRequests(page);
  const photos = {};
  page.events.emit("request", photos);

  const waited = waitForQuietPage(page, openRequests);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(page.reads, [], "The DOM was read while the data was still on its way.");

  page.events.emit("requestfinished", photos);
  await waited;
  assert.equal(page.reads.length, 1);
  openRequests.stop();
  assert.equal(page.events.listenerCount("request"), 0, "Stopping leaves no listener behind.");
});

test("drawing that sends new requests is waited for too, and a failed request ends like any other", async () => {
  const page = standInPage();
  const openRequests = trackOpenRequests(page);
  const thumbnail = {};
  // Reading the DOM the first time draws a gallery whose thumbnail is then requested.
  page.evaluate = async () => {
    page.reads.push("DOM read");
    if (page.reads.length === 1) {
      page.events.emit("request", thumbnail);
      setTimeout(() => page.events.emit("requestfailed", thumbnail), 20);
    }
  };

  await waitForQuietPage(page, openRequests);
  assert.deepEqual(page.reads, ["DOM read", "DOM read"]);
  assert.equal(openRequests.count, 0);
  openRequests.stop();
});

test("a page with nothing open is read at once, and a stand-in without events is not tracked", async () => {
  const page = standInPage();
  const openRequests = trackOpenRequests(page);
  await waitForQuietPage(page, openRequests);
  assert.equal(page.reads.length, 1);
  openRequests.stop();

  assert.equal(reportsRequests(page), true);
  assert.equal(reportsRequests({ evaluate: page.evaluate }), false);
});

test("a request that never ends does not hold the page past the wait's limit", async () => {
  const page = standInPage();
  const openRequests = trackOpenRequests(page);
  // A long poll, say, that the app keeps open.
  page.events.emit("request", {});
  const started = Date.now();
  await waitForQuietPage(page, openRequests);
  const waited = Date.now() - started;
  assert.ok(waited >= 2_900 && waited < 4_000, `Waited ${waited} ms, not about 3 seconds.`);
  assert.equal(page.reads.length, 1, "The DOM is still read once the limit is reached.");
  openRequests.stop();
});
