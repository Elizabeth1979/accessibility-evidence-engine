import { expect, test } from "@playwright/test";

import {
  agreement,
  pageWords,
  realPageWords,
  realReaderName,
  sideBySide,
  withoutReaderHints,
  type ReaderComparison
} from "./reader-comparison";

const comparison: ReaderComparison = {
  page: "site/test-case.html",
  recordedAt: "2026-10-16T12:00:00.000Z",
  environment: {
    platform: "darwin",
    release: "27.0.0",
    guidepup: "0.36.3",
    speechEngine: "@guidepup/virtual-screen-reader 0.33.0"
  },
  virtual: ["heading, Workspace, level 1", "link, Help | projects", "end of list"],
  real: { reader: "VoiceOver", phrases: ["Workspace, heading level 1", "Help, link", "Fern"] }
};

test("each platform's real screen reader is named", () => {
  expect(realReaderName("darwin")).toBe("VoiceOver");
  expect(realReaderName("win32")).toBe("NVDA");
  expect(realReaderName("linux")).toBe("Orca");
  expect(realReaderName("freebsd")).toBe("A real screen reader");
});

test("a phrase's page words leave out each reader's own words", () => {
  expect([...pageWords("heading level 1 Workspace overview")]).toEqual([
    "1",
    "workspace",
    "overview"
  ]);
  expect([...pageWords("Workspace overview, heading, level 1")]).toEqual([
    "workspace",
    "overview",
    "1"
  ]);
  // A virtual reader's "5 of 5" is what the page says, not a position.
  expect([...pageWords("Seats: 5 of 5")]).toEqual(["seats", "5"]);
  expect(pageWords("end of list").size).toBe(0);
});

test("a real reader's list size and list position are its own words", () => {
  // VoiceOver's "1 of 3" is where the item is; "5 of 5" is what the page says.
  expect([...realPageWords("Seats: 5 of 5 1 of 3")]).toEqual(["seats", "5"]);
  expect([...realPageWords("list Plan limits 3 items")]).toEqual(["plan", "limits"]);
});

test("VoiceOver's usage hints are cut from what it said", () => {
  expect(
    withoutReaderHints(
      "link Test lab 1 of 2. You are currently on a link. To click this link, press Control-Option-Space."
    )
  ).toBe("link Test lab 1 of 2");
  expect(
    withoutReaderHints(
      "end of list. You are currently on a list. To move between items in this list, press Control-Option-Right Arrow."
    )
  ).toBe("end of list");
  // A sentence of the page's own keeps its full stop, and a phrase with no hint is kept whole.
  expect(withoutReaderHints("Manage your projects and workspace preferences.")).toBe(
    "Manage your projects and workspace preferences."
  );
  expect(withoutReaderHints("Seats: 5 of 5 1 of 3")).toBe("Seats: 5 of 5 1 of 3");
});

test("agreement counts the real reader's phrases a virtual reader also says", () => {
  const result = agreement(
    [
      "heading level 1 Workspace",
      "Project Alpha",
      "end of list",
      "Export report",
      "Seats: 5 of 5 1 of 3"
    ],
    ["Workspace, heading, level 1", "Project Alpha, text", "Seats: 5 of 5"]
  );
  // "end of list" says nothing of the page's own, so it is not compared.
  expect(result).toEqual({ compared: 4, heard: 3, missed: ["Export report"] });
});

test("both transcripts sit side by side, with the virtual reader's score", () => {
  const lines = sideBySide(comparison).split("\n");
  expect(lines[0]).toBe("# What each screen reader said: site/test-case.html");
  expect(lines).toContain(
    "Recorded 2026-10-16T12:00:00.000Z on darwin 27.0.0, with Guidepup 0.36.3; AEE's virtual reader speaks through @guidepup/virtual-screen-reader 0.33.0."
  );
  expect(lines).toContain("| AEE's virtual screen reader | 3 | 67% (2 of 3) |");
  expect(lines).toContain("| VoiceOver | 3 | |");
  expect(lines).toContain("VoiceOver said, and AEE's virtual screen reader did not:");
  expect(lines).toContain("- Fern");
  expect(lines).toContain("| Step | AEE's virtual screen reader | VoiceOver |");
  expect(lines).toContain("| 1 | heading, Workspace, level 1 | Workspace, heading level 1 |");
  // A pipe in a phrase stays inside its cell.
  expect(lines).toContain("| 2 | link, Help \\| projects | Help, link |");
});

test("a phrase that spans lines stays on its row", () => {
  const lines = sideBySide({
    ...comparison,
    real: { reader: "VoiceOver", phrases: ["Workspace\nheading level 1"] }
  }).split("\n");
  expect(lines).toContain("| 1 | heading, Workspace, level 1 | Workspace heading level 1 |");
});
