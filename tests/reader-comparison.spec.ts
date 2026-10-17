import { expect, test } from "@playwright/test";

import { realReaderName, sideBySide, type ReaderComparison } from "./reader-comparison";

const comparison: ReaderComparison = {
  page: "site/test-case.html",
  recordedAt: "2026-10-16T12:00:00.000Z",
  environment: { platform: "darwin", release: "27.0.0", guidepup: "0.36.3" },
  virtual: ["heading, Workspace, level 1", "link, Help | projects", "end of document"],
  real: { reader: "VoiceOver", phrases: ["Workspace, heading level 1", "Help, link"] }
};

test("each platform's real screen reader is named", () => {
  expect(realReaderName("darwin")).toBe("VoiceOver");
  expect(realReaderName("win32")).toBe("NVDA");
  expect(realReaderName("linux")).toBe("Orca");
  expect(realReaderName("freebsd")).toBe("A real screen reader");
});

test("both transcripts sit side by side, a row per step", () => {
  const lines = sideBySide(comparison).split("\n");
  expect(lines[0]).toBe("# What each screen reader said: site/test-case.html");
  expect(lines).toContain(
    "Recorded 2026-10-16T12:00:00.000Z on darwin 27.0.0, with Guidepup 0.36.3."
  );
  expect(lines).toContain("- AEE's virtual screen reader: 3 announcements.");
  expect(lines).toContain("- VoiceOver: 2 announcements.");
  expect(lines).toContain("| Step | AEE's virtual screen reader | VoiceOver |");
  expect(lines).toContain("| 1 | heading, Workspace, level 1 | Workspace, heading level 1 |");
  // A pipe in a phrase stays inside its cell.
  expect(lines).toContain("| 2 | link, Help \\| projects | Help, link |");
  // The longer transcript keeps its rows; the other column is empty there.
  expect(lines).toContain("| 3 | end of document |  |");
});

test("a phrase that spans lines stays on its row", () => {
  const lines = sideBySide({
    ...comparison,
    real: { reader: "VoiceOver", phrases: ["Workspace\nheading level 1"] }
  }).split("\n");
  expect(lines).toContain("| 1 | heading, Workspace, level 1 | Workspace heading level 1 |");
});
