import { expect, test } from "@playwright/test";

import { realReaderName, sideBySide, type ReaderComparison } from "./reader-comparison";

const comparison: Omit<ReaderComparison, "real"> = {
  page: "site/test-case.html",
  recordedAt: "2026-10-01T12:00:00.000Z",
  environment: { platform: "darwin", release: "24.1.0", screenReaderCli: "0.7.0" },
  virtual: ["heading, Workspace, level 1", "link, Help | projects", "end of document"]
};

test("each platform's real screen reader is named", () => {
  expect(realReaderName("darwin")).toBe("VoiceOver");
  expect(realReaderName("win32")).toBe("NVDA");
  expect(realReaderName("linux")).toBe("A real screen reader");
});

test("both transcripts sit side by side, a row per step", () => {
  const lines = sideBySide({
    ...comparison,
    real: { reader: "VoiceOver", phrases: ["Workspace, heading level 1", "Help, link"] }
  }).split("\n");
  expect(lines[0]).toBe("# What each screen reader said: site/test-case.html");
  expect(lines).toContain("- VoiceOver: 2 announcements.");
  expect(lines).toContain("| Step | Virtual screen reader | VoiceOver |");
  expect(lines).toContain("| 1 | heading, Workspace, level 1 | Workspace, heading level 1 |");
  // A pipe in a phrase stays inside its cell.
  expect(lines).toContain("| 2 | link, Help \\| projects | Help, link |");
  // The longer transcript keeps its rows; the other column is empty there.
  expect(lines).toContain("| 3 | end of document |  |");
});

test("a real reader that could not run says why, and the virtual one still shows", () => {
  const lines = sideBySide({
    ...comparison,
    environment: { ...comparison.environment, platform: "linux", release: "6.8.0" },
    real: { reader: "A real screen reader", notRun: "Live mode needs macOS or Windows." }
  }).split("\n");
  expect(lines).toContain("- A real screen reader: not run. Live mode needs macOS or Windows.");
  expect(lines).toContain("- Virtual screen reader: 3 announcements.");
  expect(lines).toContain("| 3 | end of document |  |");
});
