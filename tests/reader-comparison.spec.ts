import { expect, test } from "@playwright/test";

import {
  align,
  combine,
  readersSideBySide,
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
    repeatedAtEnd: [],
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
    real.map((phrase, index) => [[phrase], [virtual[index]]])
  );
  expect(summarize(rows)).toEqual({ same: 0, differ: 5, onlyReal: 0, onlyVirtual: 0 });
});

test("both directions: what only one reader said gets its own row", () => {
  const rows = align(
    ["banner", "link Open the fixed page", "end of banner", "main", "list 2 items"],
    ["banner", "Open the fixed page, link", "main", "list", "Skip to content, link"]
  );
  expect(rows).toEqual([
    { real: ["banner"], virtual: ["banner"], onlyReal: [], onlyVirtual: [] },
    {
      real: ["link Open the fixed page"],
      virtual: ["Open the fixed page, link"],
      onlyReal: [],
      onlyVirtual: []
    },
    { real: ["end of banner"], virtual: [], onlyReal: ["end", "of", "banner"], onlyVirtual: [] },
    { real: ["main"], virtual: ["main"], onlyReal: [], onlyVirtual: [] },
    { real: ["list 2 items"], virtual: ["list"], onlyReal: ["2", "items"], onlyVirtual: [] },
    {
      real: [],
      virtual: ["Skip to content, link"],
      onlyReal: [],
      onlyVirtual: ["skip", "to", "content", "link"]
    }
  ]);
  expect(summarize(rows)).toEqual({ same: 3, differ: 1, onlyReal: 1, onlyVirtual: 1 });
});

test("phrases with little in common are not paired", () => {
  // One word shared, three different: two items, one said by each reader.
  expect(align(["Export report, button"], ["Search projects, button"])).toEqual([
    {
      real: ["Export report, button"],
      virtual: [],
      onlyReal: ["export", "report", "button"],
      onlyVirtual: []
    },
    {
      real: [],
      virtual: ["Search projects, button"],
      onlyReal: [],
      onlyVirtual: ["search", "projects", "button"]
    }
  ]);
});

// The phrases below are what NVDA 2026.2 and AEE's virtual reader said about the public test lab
// page (site/test-case.html) in the first run of the "Real screen readers" workflow.

test("NVDA's phrase that names containers with the first item in them pairs with every step it covers", () => {
  const rows = align(
    [
      "out of list, banner landmark, link, Open the fixed page",
      "main landmark, Breadcrumb, navigation landmark, list, with 2 items, link, Test lab",
      "current page, Workspace overview"
    ],
    [
      "banner",
      "link, Open the fixed page",
      "end of banner",
      "main",
      "navigation, Breadcrumb",
      "list",
      "listitem, level 1, position 1, set size 2",
      "link, Test lab",
      "end of listitem, level 1, position 1, set size 2",
      "listitem, level 1, position 2, set size 2",
      "current page",
      "Workspace overview",
      "end, current page"
    ]
  );
  expect(rows).toEqual([
    {
      real: ["out of list, banner landmark, link, Open the fixed page"],
      virtual: ["banner", "link, Open the fixed page"],
      onlyReal: ["out", "of", "list", "landmark"],
      onlyVirtual: []
    },
    { real: [], virtual: ["end of banner"], onlyReal: [], onlyVirtual: ["end", "of", "banner"] },
    {
      real: ["main landmark, Breadcrumb, navigation landmark, list, with 2 items, link, Test lab"],
      virtual: [
        "main",
        "navigation, Breadcrumb",
        "list",
        "listitem, level 1, position 1, set size 2",
        "link, Test lab"
      ],
      // Every word still counts in a row that holds several steps, role words included.
      onlyReal: ["landmark", "landmark", "with", "items"],
      onlyVirtual: ["listitem", "level", "1", "position", "1", "set", "size"]
    },
    {
      real: [],
      virtual: ["end of listitem, level 1, position 1, set size 2"],
      onlyReal: [],
      onlyVirtual: ["end", "of", "listitem", "level", "1", "position", "1", "set", "size", "2"]
    },
    {
      real: [],
      virtual: ["listitem, level 1, position 2, set size 2"],
      onlyReal: [],
      onlyVirtual: ["listitem", "level", "1", "position", "2", "set", "size", "2"]
    },
    {
      real: ["current page, Workspace overview"],
      virtual: ["current page", "Workspace overview"],
      onlyReal: [],
      onlyVirtual: []
    },
    {
      real: [],
      virtual: ["end, current page"],
      onlyReal: [],
      onlyVirtual: ["end", "current", "page"]
    }
  ]);
  expect(summarize(rows)).toEqual({ same: 1, differ: 2, onlyReal: 0, onlyVirtual: 4 });
});

test("a list's name and size said with its first item, and a link said with its paragraph, pair too", () => {
  expect(
    align(
      ["Plan limits, list, with 3 items, Seats: 5 of 5", "Storage: 12 of 10 GB"],
      [
        "list, Plan limits",
        "listitem, level 1, position 1, set size 3",
        "Seats: 5 of 5",
        "end of listitem, level 1, position 1, set size 3",
        "listitem, level 1, position 2, set size 3",
        "Storage: 12 of 10 GB"
      ]
    ).map(({ real, virtual }) => ({ real, virtual }))
  ).toEqual([
    {
      real: ["Plan limits, list, with 3 items, Seats: 5 of 5"],
      virtual: ["list, Plan limits", "listitem, level 1, position 1, set size 3", "Seats: 5 of 5"]
    },
    { real: [], virtual: ["end of listitem, level 1, position 1, set size 3"] },
    { real: [], virtual: ["listitem, level 1, position 2, set size 3"] },
    { real: ["Storage: 12 of 10 GB"], virtual: ["Storage: 12 of 10 GB"] }
  ]);
  expect(
    align(
      ["Work in this workspace., same page, link, test-case projects-heading"],
      ["paragraph", "Work in this workspace.", "link", "end of paragraph"]
    )
  ).toEqual([
    { real: [], virtual: ["paragraph"], onlyReal: [], onlyVirtual: ["paragraph"] },
    {
      real: ["Work in this workspace., same page, link, test-case projects-heading"],
      virtual: ["Work in this workspace.", "link"],
      onlyReal: ["same", "page", "test", "case", "projects", "heading"],
      onlyVirtual: []
    },
    {
      real: [],
      virtual: ["end of paragraph"],
      onlyReal: [],
      onlyVirtual: ["end", "of", "paragraph"]
    }
  ]);
});

test("steps that share a few words but say mostly different things are not grouped", () => {
  // "of", "region" and "image" are shared, but most words differ: four rows, one reader each.
  const real = [
    "out of region, Unlabeled graphic, To get missing image descriptions, open the context menu."
  ];
  const virtual = ["end of region, Workspace settings", "region", "heading, level 2", "image"];
  expect(align(real, virtual).map(({ real, virtual }) => ({ real, virtual }))).toEqual([
    { real, virtual: [] },
    ...virtual.map((phrase) => ({ real: [], virtual: [phrase] }))
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
    stoppedBecause: "silence",
    repeatedAtEnd: []
  });
  // The last line is said once as part of the page; the steps that only say it again are kept apart.
  expect(await readWithRealReader(fakeReader(["main"], "end of main"), 10)).toEqual({
    phrases: ["main", "end of main"],
    stoppedBecause: "repeated",
    repeatedAtEnd: ["end of main", "end of main"]
  });
  expect(await readWithRealReader(fakeReader(["a", "b", "c", "d", "e"]), 3)).toEqual({
    phrases: ["a", "b", "c"],
    stoppedBecause: "step-limit",
    repeatedAtEnd: []
  });
});

test("NVDA's end of the page: the last line said again, without the containers it left, is not page", async () => {
  // NVDA reaches the last line naming the list it left, then reads the line alone at each further
  // Down Arrow, since it cannot move on (cursorManager.py's _caretMovementScriptHelper).
  const walk = await readWithRealReader(
    fakeReader(["Projects: 3 of 20", "out of list, No changes made."], "No changes made."),
    10
  );
  expect(walk).toEqual({
    phrases: ["Projects: 3 of 20", "out of list, No changes made."],
    stoppedBecause: "repeated",
    repeatedAtEnd: ["No changes made.", "No changes made.", "No changes made."]
  });
  const lines = sideBySide({
    ...comparison,
    virtual: ["Projects: 3 of 20", "end of list", "paragraph", "No changes made."],
    real: { ...comparison.real, ...walk, reader: "NVDA" }
  }).split("\n");
  expect(lines).toContain(
    'NVDA read 2 steps, then said "No changes made." again at each of the next 3 steps: at the end of the page it cannot move on, so it reads the last line again. Its walk ended there, and those repeats are left out of the rows below.'
  );
  expect(lines).toContain("| Only NVDA said it | 0 |");
  expect(lines).toContain(
    "| 2 | end of list<br>paragraph<br>No changes made. | out of list, No changes made. | only AEE's virtual screen reader: **end paragraph**; only NVDA: **out** |"
  );
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

/** One machine's comparison of the same three virtual phrases with `reader`'s `phrases`. */
function ran(reader: string, phrases: string[], attempt = 1): ReaderComparison {
  return {
    ...comparison,
    virtual: ["banner", "link, Test lab", "end of list"],
    real: { reader, phrases, stoppedBecause: "silence", repeatedAtEnd: [], maxSteps: 33, attempt }
  };
}

const nvda = ran(
  "NVDA",
  ["banner landmark", "Breadcrumb navigation landmark", "link, Test lab"],
  2
);
const voiceOver = ran("VoiceOver", ["banner", "link, Test lab", "end of list", "Fern"]);

test("several real readers line up on AEE's phrases, each phrase only one said where it said it", () => {
  const rows = combine([nvda, voiceOver]);
  expect(rows.map(({ virtual }) => virtual)).toEqual([
    ["banner"],
    [],
    ["link, Test lab"],
    ["end of list"],
    []
  ]);
  expect(rows.map(({ readers }) => readers.map((row) => row?.real))).toEqual([
    [["banner landmark"], ["banner"]],
    // Only NVDA said this, between the items it shares with AEE's reader.
    [["Breadcrumb navigation landmark"], undefined],
    [["link, Test lab"], ["link, Test lab"]],
    // NVDA said nothing about this item; its row is there, with no phrase.
    [[], ["end of list"]],
    // Only VoiceOver said this, after AEE's last phrase.
    [undefined, ["Fern"]]
  ]);
});

test("the combined table has a column for each real reader and what differs from it", () => {
  const lines = readersSideBySide([nvda, voiceOver]).split("\n");
  expect(lines[0]).toBe("# What each screen reader said: site/test-case.html");
  expect(lines).toContain(
    "NVDA read 3 steps, then said nothing at the next step, so its walk ended there. NVDA started on attempt 2: 1 retry was needed."
  );
  expect(lines).toContain(
    "VoiceOver read 4 steps, then said nothing at the next step, so its walk ended there."
  );
  expect(lines).toContain("| Rows | NVDA | VoiceOver |");
  expect(lines).toContain("| Same words as AEE's reader | 1 | 3 |");
  expect(lines).toContain("| About the same item, in different words | 1 | 0 |");
  expect(lines).toContain("| Only the real reader said it | 1 | 1 |");
  expect(lines).toContain("| Only AEE's reader said it | 1 | 0 |");
  expect(lines).toContain(
    "| Row | AEE's virtual screen reader | NVDA | What differs from NVDA | VoiceOver | What differs from VoiceOver |"
  );
  expect(lines).toContain(
    "| 1 | banner | banner landmark | only NVDA: **landmark** | banner | same words |"
  );
  expect(lines).toContain("| 2 |  | Breadcrumb navigation landmark | only NVDA said this |  |  |");
  expect(lines).toContain(
    "| 4 | end of list |  | only AEE's virtual screen reader said this | end of list | same words |"
  );
  expect(lines).toContain("| 5 |  |  |  | Fern | only VoiceOver said this |");
});

test("comparisons of different pages or transcripts are not combined", () => {
  expect(() => combine([nvda, { ...voiceOver, page: "site/other.html" }])).toThrow(
    "VoiceOver's comparison read site/other.html with a different virtual transcript from NVDA's (site/test-case.html); comparisons line up only on the same one."
  );
  expect(() => combine([])).toThrow("No comparisons to combine.");
});

test("a reader that needed retries to start says so on its own page too", () => {
  expect(sideBySide({ ...comparison, real: { ...comparison.real, attempt: 3 } })).toContain(
    "VoiceOver read 3 steps, then said nothing at the next step, so its walk ended there. VoiceOver started on attempt 3: 2 retries were needed."
  );
});

test("where one reader says several of AEE's steps in one phrase, the combined row holds them all", () => {
  const virtual = ["main", "list", "link, Test lab", "end of list"];
  const folded = {
    ...ran("NVDA", ["main landmark, list, with 2 items, link, Test lab"]),
    virtual
  };
  const stepByStep = {
    ...ran("VoiceOver", ["main", "list 2 items", "link, Test lab", "end of list"]),
    virtual
  };
  const rows = combine([folded, stepByStep]);
  expect(rows.map(({ virtual }) => virtual)).toEqual([
    ["main", "list", "link, Test lab"],
    ["end of list"]
  ]);
  expect(rows[0]!.readers).toEqual([
    {
      real: ["main landmark, list, with 2 items, link, Test lab"],
      virtual: ["main", "list", "link, Test lab"],
      onlyReal: ["landmark", "with", "2", "items"],
      onlyVirtual: []
    },
    // VoiceOver's three rows for the same steps, as one, each word it differs in kept.
    {
      real: ["main", "list 2 items", "link, Test lab"],
      virtual: ["main", "list", "link, Test lab"],
      onlyReal: ["2", "items"],
      onlyVirtual: []
    }
  ]);
  expect(readersSideBySide([folded, stepByStep]).split("\n")).toContain(
    "| 1 | main<br>list<br>link, Test lab | main landmark, list, with 2 items, link, Test lab | only NVDA: **landmark with 2 items** | main<br>list 2 items<br>link, Test lab | only VoiceOver: **2 items** |"
  );
});
