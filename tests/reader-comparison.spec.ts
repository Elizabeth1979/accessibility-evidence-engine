import { expect, test } from "@playwright/test";

import {
  align,
  readWithRealReader,
  realReaderName,
  sideBySide,
  summarize,
  withoutReaderHints,
  wordDifference,
  type ReaderComparison
} from "./reader-comparison";

const comparison: ReaderComparison = {
  page: "site/test-case.html",
  recordedAt: "2026-10-16T12:00:00.000Z",
  environment: {
    platform: "darwin",
    release: "27.0.0",
    guidepup: "0.36.3",
    speechEngine: "@guidepup/virtual-screen-reader 0.32.1"
  },
  virtual: ["heading, Workspace, level 1", "link, Help | projects", "end of list"],
  real: {
    reader: "VoiceOver",
    phrases: ["Workspace, heading level 1", "Help, link", "Fern"],
    stoppedBecause: "silence",
    maxSteps: 33
  }
};

test("each platform's real screen reader is named", () => {
  expect(realReaderName("darwin")).toBe("VoiceOver");
  expect(realReaderName("win32")).toBe("NVDA");
  expect(realReaderName("linux")).toBe("Orca");
  expect(realReaderName("freebsd")).toBe("A real screen reader");
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

test("role and state words count: a reversed state, a wrong role or a missing name shows", () => {
  // The audit's pairs (B1): the old score called the first four "heard" and left the last out.
  expect(
    wordDifference("Email updates, checkbox, not checked", "checkbox, Email updates, checked")
  ).toEqual({ onlyReal: ["not"], onlyVirtual: [] });
  expect(wordDifference("Menu, collapsed, button", "button, Menu, expanded")).toEqual({
    onlyReal: ["collapsed"],
    onlyVirtual: ["expanded"]
  });
  expect(
    wordDifference("Bold, toggle button, not pressed", "toggle button, Bold, pressed")
  ).toEqual({ onlyReal: ["not"], onlyVirtual: [] });
  expect(wordDifference("Save, button", "link, Save")).toEqual({
    onlyReal: ["button"],
    onlyVirtual: ["link"]
  });
  expect(wordDifference("button", "Archive project, button")).toEqual({
    onlyReal: [],
    onlyVirtual: ["archive", "project"]
  });
});

test("the order of role, name and state within a phrase does not count", () => {
  expect(wordDifference("heading level 1 Workspace", "Workspace, heading, level 1")).toEqual({
    onlyReal: [],
    onlyVirtual: []
  });
  // A word one reader says twice and the other once is a difference, in the phrase's own order.
  expect(wordDifference("Seats: 5 of 5 1 of 3", "Seats: 5 of 5")).toEqual({
    onlyReal: ["1", "of", "3"],
    onlyVirtual: []
  });
});

test("the audit's pairs line up side by side, each with what differs", () => {
  const real = [
    "Email updates, checkbox, not checked",
    "Menu, collapsed, button",
    "Bold, toggle button, not pressed",
    "Save, button",
    "button"
  ];
  const virtual = [
    "checkbox, Email updates, checked",
    "button, Menu, expanded",
    "toggle button, Bold, pressed",
    "link, Save",
    "Archive project, button"
  ];
  const rows = align(real, virtual);
  expect(rows.map((row) => [row.real, row.virtual])).toEqual(
    real.map((phrase, index) => [phrase, virtual[index]])
  );
  expect(summarize(rows)).toEqual({ same: 0, differ: 5, onlyReal: 0, onlyVirtual: 0 });
});

test("both directions: what only one reader said gets its own row", () => {
  const rows = align(
    ["banner", "link Open the fixed page", "end of banner", "main", "list 2 items"],
    ["banner", "Open the fixed page, link", "main", "list", "Skip to content, link"]
  );
  expect(rows).toEqual([
    { real: "banner", virtual: "banner", onlyReal: [], onlyVirtual: [] },
    {
      real: "link Open the fixed page",
      virtual: "Open the fixed page, link",
      onlyReal: [],
      onlyVirtual: []
    },
    { real: "end of banner", onlyReal: ["end", "of", "banner"], onlyVirtual: [] },
    { real: "main", virtual: "main", onlyReal: [], onlyVirtual: [] },
    { real: "list 2 items", virtual: "list", onlyReal: ["2", "items"], onlyVirtual: [] },
    {
      virtual: "Skip to content, link",
      onlyReal: [],
      onlyVirtual: ["skip", "to", "content", "link"]
    }
  ]);
  expect(summarize(rows)).toEqual({ same: 3, differ: 1, onlyReal: 1, onlyVirtual: 1 });
});

test("phrases with little in common are not paired", () => {
  // One word shared, three different: two items, one said by each reader.
  expect(align(["Export report, button"], ["Search projects, button"])).toEqual([
    { real: "Export report, button", onlyReal: ["export", "report", "button"], onlyVirtual: [] },
    {
      virtual: "Search projects, button",
      onlyReal: [],
      onlyVirtual: ["search", "projects", "button"]
    }
  ]);
});

/** A screen reader that says `phrases` one per step, then `after` forever. */
function fakeReader(phrases: string[], after = "") {
  let step = 0;
  return {
    next: async () => {
      step += 1;
    },
    lastSpokenPhrase: async () => phrases[step] ?? after
  };
}

test("the real reader's walk says why it stopped", async () => {
  expect(await readWithRealReader(fakeReader(["main", "Workspace"]), 10)).toEqual({
    phrases: ["main", "Workspace"],
    stoppedBecause: "silence"
  });
  expect(await readWithRealReader(fakeReader(["main"], "end of main"), 10)).toEqual({
    phrases: ["main", "end of main", "end of main", "end of main"],
    stoppedBecause: "repeated"
  });
  expect(await readWithRealReader(fakeReader(["a", "b", "c", "d", "e"]), 3)).toEqual({
    phrases: ["a", "b", "c"],
    stoppedBecause: "step-limit"
  });
});

test("both transcripts line up, with what each said that the other did not", () => {
  const lines = sideBySide(comparison).split("\n");
  expect(lines[0]).toBe("# What each screen reader said: site/test-case.html");
  expect(lines).toContain(
    "Recorded 2026-10-16T12:00:00.000Z on darwin 27.0.0, with Guidepup 0.36.3; AEE's virtual reader speaks through @guidepup/virtual-screen-reader 0.32.1."
  );
  expect(lines).toContain(
    "VoiceOver read 3 steps, then said nothing at the next step, so its walk ended there."
  );
  expect(lines).toContain("| Both said the same words | 1 |");
  expect(lines).toContain("| Both said something here, in different words | 1 |");
  expect(lines).toContain("| Only VoiceOver said it | 1 |");
  expect(lines).toContain("| Only AEE's virtual screen reader said it | 1 |");
  expect(lines).toContain("| Row | AEE's virtual screen reader | VoiceOver | What differs |");
  expect(lines).toContain(
    "| 1 | heading, Workspace, level 1 | Workspace, heading level 1 | same words |"
  );
  // A pipe in a phrase stays inside its cell.
  expect(lines).toContain(
    "| 2 | link, Help \\| projects | Help, link | only AEE's virtual screen reader: **projects** |"
  );
  expect(lines).toContain("| 3 |  | Fern | only VoiceOver said this |");
  expect(lines).toContain("| 4 | end of list |  | only AEE's virtual screen reader said this |");
});

test("a walk cut off at the step limit says so", () => {
  const lines = sideBySide({
    ...comparison,
    real: { ...comparison.real, stoppedBecause: "step-limit", maxSteps: 3 }
  }).split("\n");
  expect(lines).toContain(
    "VoiceOver read 3 steps and was stopped at the limit of 3 steps, so it may not have reached the end of the page. What it would have said after that is not here: rows near the end that only AEE's virtual screen reader said may be page VoiceOver never reached."
  );
});

test("a phrase that spans lines stays on its row", () => {
  const lines = sideBySide({
    ...comparison,
    real: { ...comparison.real, phrases: ["Workspace\nheading level 1"] }
  }).split("\n");
  expect(lines).toContain(
    "| 1 | heading, Workspace, level 1 | Workspace heading level 1 | same words |"
  );
});
