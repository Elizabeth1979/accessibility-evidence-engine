import assert from "node:assert/strict";
import test from "node:test";

import { realReaderName, sideBySide } from "./compare-readers.mjs";

const comparison = {
  page: "site/test-case.html",
  recordedAt: "2026-10-01T12:00:00.000Z",
  environment: { platform: "darwin", release: "24.1.0", screenReaderCli: "0.7.0" },
  virtual: ["heading, Workspace, level 1", "link, Help | projects", "end of document"]
};

test("each platform's real screen reader is named", () => {
  assert.equal(realReaderName("darwin"), "VoiceOver");
  assert.equal(realReaderName("win32"), "NVDA");
  assert.equal(realReaderName("linux"), "A real screen reader");
});

test("both transcripts sit side by side, a row per step", () => {
  const markdown = sideBySide({
    ...comparison,
    real: { reader: "VoiceOver", phrases: ["Workspace, heading level 1", "Help, link"] }
  });
  assert.match(markdown, /^# What each screen reader said: site\/test-case\.html$/m);
  assert.match(markdown, /^- VoiceOver: 2 announcements\.$/m);
  assert.match(markdown, /^\| Step \| Virtual screen reader \| VoiceOver \|$/m);
  assert.match(markdown, /^\| 1 \| heading, Workspace, level 1 \| Workspace, heading level 1 \|$/m);
  // A pipe in a phrase stays inside its cell.
  assert.match(markdown, /^\| 2 \| link, Help \\\| projects \| Help, link \|$/m);
  // The longer transcript keeps its rows; the other column is empty there.
  assert.match(markdown, /^\| 3 \| end of document \| {2}\|$/m);
});

test("a real reader that could not run says why, and the virtual one still shows", () => {
  const markdown = sideBySide({
    ...comparison,
    environment: { ...comparison.environment, platform: "linux", release: "6.8.0" },
    real: { reader: "A real screen reader", notRun: "Live mode needs macOS or Windows." }
  });
  assert.match(markdown, /^- A real screen reader: not run\. Live mode needs macOS or Windows\.$/m);
  assert.match(markdown, /^- Virtual screen reader: 3 announcements\.$/m);
  assert.match(markdown, /^\| 3 \| end of document \| {2}\|$/m);
});
