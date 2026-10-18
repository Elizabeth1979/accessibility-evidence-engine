import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ScreenReader } from "@guidepup/guidepup";
import type { Page } from "@playwright/test";
import { diffArrays } from "diff";

import { createPortableVirtualScreenReader } from "@aee/playwright";

export interface ReaderComparison {
  page: string;
  recordedAt: string;
  environment: {
    platform: string;
    release: string;
    guidepup: string;
    /** What decides what AEE's virtual reader says: Guidepup's virtual screen reader, and its version. */
    speechEngine: string;
  };
  /** What AEE's virtual screen reader said. */
  virtual: string[];
  /**
   * What the real screen reader on this machine said, why its walk ended, and which attempt this
   * was: a reader that fails to start is tried again, up to the retries the run allows.
   */
  real: {
    reader: string;
    phrases: string[];
    stoppedBecause: WalkEnd;
    /** What the reader said again at the end of the page, left out of `phrases` (`endRepeats`). */
    repeatedAtEnd: string[];
    maxSteps: number;
    attempt?: number;
  };
}

/**
 * Why the real reader's walk ended: it said nothing at the next step, it said the same thing three
 * times in a row (the end of the page, for readers that repeat there), or it reached `maxSteps`.
 */
export type WalkEnd = "silence" | "repeated" | "step-limit";

export const GUIDEPUP_VERSION = (
  JSON.parse(readFileSync(require.resolve("@guidepup/guidepup/package.json"), "utf8")) as {
    version: string;
  }
).version;

const REAL_READERS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "VoiceOver",
  win32: "NVDA",
  linux: "Orca"
};

/** The real screen reader Guidepup drives on this platform, by name. */
export function realReaderName(platform: NodeJS.Platform = process.platform) {
  return REAL_READERS[platform] ?? "A real screen reader";
}

/** AEE's virtual screen reader reads the page from top to bottom, one item per step. */
export async function readWithVirtualReader(
  page: Page
): Promise<{ phrases: string[]; speechEngine: string }> {
  const reader = createPortableVirtualScreenReader(page);
  const phrases: string[] = [];
  for (let entry = await reader.command("start"); entry.item;) {
    phrases.push(entry.announcement);
    entry = await reader.command("next-item");
  }
  return { phrases, speechEngine: (await reader.snapshot()).speechEngine };
}

/**
 * What the reader said about the page, without the usage hints VoiceOver speaks after it ("You are
 * currently on a link. To click this link, press Control-Option-Space."): those coach the user and
 * say nothing about the page. The same cut screen-reader-cli makes before comparing.
 */
export function withoutReaderHints(phrase: string): string {
  return phrase
    .split(
      /\.\s*(?:You are currently (?:on|in)|To (?:click|move between|exit|enter|interact|select|begin))\b/i
    )[0]!
    .trim();
}

/**
 * How many steps at the end of a walk only said the step before them again. At the last line of a
 * page NVDA cannot move on, and it reads that line again at each press of Down Arrow: its
 * `_caretMovementScriptHelper` (source/cursorManager.py) speaks the line whether or not the caret
 * moved. The first time it also names the containers it left ("out of list, No changes made."),
 * and Guidepup joins those parts with a comma; the repeats say the line alone ("No changes
 * made."). So a step repeats the one before it when it says it whole, or says its last part.
 */
function endRepeats(phrases: string[]) {
  let count = 0;
  for (let i = phrases.length - 1; i > 0; i--) {
    const [before, phrase] = [phrases[i - 1]!, phrases[i]!];
    if (before !== phrase && !before.endsWith(`, ${phrase}`)) break;
    count += 1;
  }
  return count;
}

/**
 * The real screen reader reads on from where it entered the page, one item per step. Each step
 * waits until the reader has finished speaking (`capture: true`): by default Guidepup reads once,
 * just after the key press, and gets nothing when the reader is slow to speak, which would end
 * the walk halfway down the page. The walk ends for one of the reasons in `WalkEnd`, and says
 * which. When it ends on repeats, those are the end of the page said again, not more of the page:
 * they are kept apart in `repeatedAtEnd`, so they do not show as phrases only the real reader said.
 */
export async function readWithRealReader(
  reader: Pick<ScreenReader, "next" | "lastSpokenPhrase">,
  maxSteps: number
): Promise<{ phrases: string[]; stoppedBecause: WalkEnd; repeatedAtEnd: string[] }> {
  const phrases = [withoutReaderHints(await reader.lastSpokenPhrase())];
  const said = () => phrases.filter(Boolean);
  while (phrases.length < maxSteps) {
    await reader.next({ capture: true });
    const phrase = withoutReaderHints(await reader.lastSpokenPhrase());
    if (!phrase) return { phrases: said(), stoppedBecause: "silence", repeatedAtEnd: [] };
    phrases.push(phrase);
    const [a, b, c] = phrases.slice(-3);
    if (phrases.length >= 3 && a === b && b === c) {
      const page = said();
      const end = page.length - endRepeats(page);
      return {
        phrases: page.slice(0, end),
        stoppedBecause: "repeated",
        repeatedAtEnd: page.slice(end)
      };
    }
  }
  return { phrases: said(), stoppedBecause: "step-limit", repeatedAtEnd: [] };
}

/** Phrases in one table cell, a line each; a pipe or line break in a phrase stays inside it. */
const cell = (phrases: string[] = []) =>
  phrases.map((phrase) => phrase.replaceAll("|", "\\|").replaceAll("\n", " ")).join("<br>");

/**
 * The words of a phrase, lower-cased and without punctuation. Every word is kept: the role and
 * state words ("button", "link", "not", "checked", "expanded") are what a screen-reader user
 * depends on most, so a difference in them is a difference.
 */
const words = (phrase: string) =>
  phrase
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * `picked` (a bag of words taken from `phrase`) in the order the phrase says them. Where the phrase
 * says a word more often than `picked` holds it, the later sayings are picked: what a reader adds,
 * such as VoiceOver's "1 of 3" after "Seats: 5 of 5", comes after the rest.
 */
function inPhraseOrder(phrase: string, picked: string[]) {
  const left = [...picked];
  return words(phrase)
    .reverse()
    .filter((word) => {
      const index = left.indexOf(word);
      if (index === -1) return false;
      left.splice(index, 1);
      return true;
    })
    .reverse();
}

/**
 * What each of two phrases says that the other does not, word for word. Each reader orders role,
 * name and state its own way ("Workspace, heading level 1" against "heading, Workspace, level 1"),
 * so order within a phrase does not count: jsdiff aligns the two phrases' words sorted, which
 * leaves exactly the words one of them says more often than the other.
 */
export function wordDifference(real: string, virtual: string) {
  const changes = diffArrays(words(real).sort(), words(virtual).sort());
  const said = (by: "removed" | "added") =>
    changes.filter((change) => change[by]).flatMap((change) => change.value);
  return {
    onlyReal: inPhraseOrder(real, said("removed")),
    onlyVirtual: inPhraseOrder(virtual, said("added"))
  };
}

const sameWords = (real: string, virtual: string) => {
  const { onlyReal, onlyVirtual } = wordDifference(real, virtual);
  return onlyReal.length === 0 && onlyVirtual.length === 0;
};

/**
 * Two phrases are about the same item when they have at least as many words in common as words
 * that differ: a Sørensen–Dice similarity of one half or more.
 */
const sameItem = (real: string, virtual: string) => {
  const { onlyReal, onlyVirtual } = wordDifference(real, virtual);
  const common = words(real).length - onlyReal.length;
  return common > 0 && 2 * common >= onlyReal.length + onlyVirtual.length;
};

/** The phrases each reader said about one thing on the page; either may be empty. */
interface Step {
  real: string[];
  virtual: string[];
}

const alone = (real: string[], virtual: string[]): Step[] => [
  ...real.map((phrase) => ({ real: [phrase], virtual: [] })),
  ...virtual.map((phrase) => ({ real: [], virtual: [phrase] }))
];

/** jsdiff's alignment of two transcripts: the phrases `same` pairs, and those only one reader said. */
function steps(
  real: string[],
  virtual: string[],
  same: (real: string, virtual: string) => boolean
) {
  const result: Step[] = [];
  let r = 0;
  let v = 0;
  for (const { added, removed, count } of diffArrays(real, virtual, { comparator: same })) {
    if (removed) result.push(...alone(real.slice(r, (r += count)), []));
    else if (added) result.push(...alone([], virtual.slice(v, (v += count))));
    else {
      for (let i = 0; i < count; i++) result.push({ real: [real[r++]!], virtual: [virtual[v++]!] });
    }
  }
  return result;
}

/**
 * The words two transcripts have in common, as links between the phrases they are in, by jsdiff's
 * word-by-word alignment: the README's way to diff your own tokens (tokenize, then `diffArrays`).
 * Where a word could link either of two places equally well ("button" in "Save, button" and in
 * the unnamed "button" after it), a diff picks one of them arbitrarily, so the transcripts are
 * aligned forwards and backwards and only the links both directions make are kept: the
 * intersection of two one-way word alignments, as statistical machine translation takes it for
 * its surest links (Och and Ney 2003). Each link is a pair of phrase indexes, in order.
 */
function wordLinks(real: string[], virtual: string[]) {
  const tokens = (phrases: string[]) =>
    phrases.flatMap((phrase, index) => words(phrase).map((word) => ({ word, index })));
  const realWords = tokens(real);
  const virtualWords = tokens(virtual);
  const matched = (backwards: boolean) => {
    const order = <T>(list: T[]) => (backwards ? [...list].reverse() : list);
    const at = (index: number, length: number) => (backwards ? length - 1 - index : index);
    const pairs = new Set<string>();
    let r = 0;
    let v = 0;
    const diff = diffArrays(
      order(realWords.map(({ word }) => word)),
      order(virtualWords.map(({ word }) => word))
    );
    for (const { added, removed, count } of diff) {
      if (removed) r += count;
      else if (added) v += count;
      else {
        for (let i = 0; i < count; i++) {
          pairs.add(`${at(r++, realWords.length)} ${at(v++, virtualWords.length)}`);
        }
      }
    }
    return pairs;
  };
  const backwards = matched(true);
  return [...matched(false)]
    .filter((pair) => backwards.has(pair))
    .map((pair) => {
      const [r, v] = pair.split(" ").map(Number) as [number, number];
      return [realWords[r]!.index, virtualWords[v]!.index] as const;
    });
}

/** A run of phrases from each reader; `linked` when some word links them (`wordLinks`). */
interface Segment extends Step {
  linked: boolean;
}

/**
 * The phrases of two transcripts in groups, where one reader's phrase may cover several of the
 * other's: NVDA names a landmark, a list and its first link in one breath ("main landmark, list,
 * with 2 items, link, Test lab"), where AEE's reader takes a step for each. A group is a run of
 * phrases on each side that no word link leaves, holding at least one link: the rule by which
 * statistical machine translation takes phrase pairs from a word alignment (a phrase pair
 * "consistent with the alignment", as in Moses' phrase extraction). The groups are the smallest
 * such runs. The phrases between two groups, linked to nothing, come as one unlinked segment.
 */
function wordGroups(real: string[], virtual: string[]): Segment[] {
  // The links run forward on both sides, so each one joins the group before it or starts one.
  const groups: { real: [number, number]; virtual: [number, number] }[] = [];
  for (const [p, q] of wordLinks(real, virtual)) {
    const last = groups.at(-1);
    if (last && (p === last.real[1] || q === last.virtual[1])) {
      last.real[1] = p;
      last.virtual[1] = q;
    } else groups.push({ real: [p, p], virtual: [q, q] });
  }
  const segments: Segment[] = [];
  let realAt = 0;
  let virtualAt = 0;
  const unlinked = (realTo: number, virtualTo: number) => {
    if (realTo > realAt || virtualTo > virtualAt) {
      segments.push({
        real: real.slice(realAt, realTo),
        virtual: virtual.slice(virtualAt, virtualTo),
        linked: false
      });
    }
  };
  for (const {
    real: [realFrom, realTo],
    virtual: [virtualFrom, virtualTo]
  } of groups) {
    unlinked(realFrom, virtualFrom);
    realAt = realTo + 1;
    virtualAt = virtualTo + 1;
    segments.push({
      real: real.slice(realFrom, realAt),
      virtual: virtual.slice(virtualFrom, virtualAt),
      linked: true
    });
  }
  unlinked(real.length, virtual.length);
  return segments;
}

/** One row of the alignment: the phrases each reader said about one thing, and the words only one said. */
export interface AlignedRow extends Step {
  onlyReal: string[];
  onlyVirtual: string[];
}

const said = (phrases: string[]) => phrases.join(" ");

const toRow = ({ real, virtual }: Step): AlignedRow => ({
  real,
  virtual,
  ...wordDifference(said(real), said(virtual))
});

/**
 * The two transcripts lined up both ways, the way a text diff lines up two files and then shows
 * the words that changed within a line. jsdiff first pairs the phrases with the same words.
 * Between those, the phrases are grouped word by word (`wordGroups`), so one reader's phrase can
 * cover several of the other's steps. A group is a row when it is about the same item (at least
 * as many words in common as words that differ); the phrases of any other group, and those no
 * word links, are paired one to one where they are about the same item. What is left is a row
 * said by one reader only. Every phrase from both readers is in a row, in its reader's order.
 */
export function align(real: string[], virtual: string[]): AlignedRow[] {
  const rows: AlignedRow[] = [];
  let unpaired: Step = { real: [], virtual: [] };
  const pairUnpaired = () => {
    for (const { real, virtual, linked } of wordGroups(unpaired.real, unpaired.virtual)) {
      const pairs =
        linked && sameItem(said(real), said(virtual))
          ? [{ real, virtual }]
          : steps(real, virtual, sameItem);
      rows.push(...pairs.map(toRow));
    }
    unpaired = { real: [], virtual: [] };
  };
  for (const step of steps(real, virtual, sameWords)) {
    if (step.real.length && step.virtual.length) {
      pairUnpaired();
      rows.push(toRow(step));
    } else {
      unpaired.real.push(...step.real);
      unpaired.virtual.push(...step.virtual);
    }
  }
  pairUnpaired();
  return rows;
}

/** How many rows of the alignment are the same, differ, or were said by one reader only. */
export function summarize(rows: AlignedRow[]) {
  const count = (test: (row: AlignedRow) => boolean) => rows.filter(test).length;
  const both = (row: AlignedRow) => row.real.length > 0 && row.virtual.length > 0;
  return {
    same: count((row) => both(row) && !row.onlyReal.length && !row.onlyVirtual.length),
    differ: count((row) => both(row) && (row.onlyReal.length > 0 || row.onlyVirtual.length > 0)),
    onlyReal: count((row) => row.virtual.length === 0),
    onlyVirtual: count((row) => row.real.length === 0)
  };
}

const VIRTUAL = "AEE's virtual screen reader";

/** How the rows are made, in words, for both Markdown pages. */
const HOW_ROWS_LINE_UP = `A row can hold several of AEE's steps: a real reader often says in one phrase what AEE's reader takes a step for each of, such as NVDA's "main landmark, list, with 2 items, link, Test lab", and that phrase sits next to every step it covers. Phrases are about the same item when they have at least as many words in common as words that differ. Every word counts, including role and state words such as "button", "link", "not", "checked" and "expanded"; only the order of words does not, since each reader orders role, name and state its own way.`;

/** Why the real reader's walk ended, in a sentence, and whether it needed a retry to start. */
function walkEnd({
  reader,
  phrases,
  stoppedBecause,
  repeatedAtEnd,
  maxSteps,
  attempt = 1
}: ReaderComparison["real"]) {
  const read = `${reader} read ${phrases.length} steps`;
  const retried =
    attempt > 1
      ? ` ${reader} started on attempt ${attempt}: ${attempt - 1} ${attempt === 2 ? "retry was" : "retries were"} needed.`
      : "";
  switch (stoppedBecause) {
    case "silence":
      return `${read}, then said nothing at the next step, so its walk ended there.${retried}`;
    case "repeated":
      return `${read}, then said "${repeatedAtEnd.at(-1)}" again at each of the next ${repeatedAtEnd.length} steps: at the end of the page it cannot move on, so it reads the last line again. Its walk ended there, and those repeats are left out of the rows below.${retried}`;
    case "step-limit":
      return `${read} and was stopped at the limit of ${maxSteps} steps, so it may not have reached the end of the page. What it would have said after that is not here: rows near the end that only ${VIRTUAL} said may be page ${reader} never reached.${retried}`;
  }
}

/** What differs in a row, for its last cell. */
function difference(row: AlignedRow, reader: string) {
  if (row.virtual.length === 0) return `only ${reader} said this`;
  if (row.real.length === 0) return `only ${VIRTUAL} said this`;
  const only = (who: string, said: string[]) =>
    said.length ? [`only ${who}: **${cell([said.join(" ")])}**`] : [];
  const parts = [...only(VIRTUAL, row.onlyVirtual), ...only(reader, row.onlyReal)];
  return parts.length ? parts.join("; ") : "same words";
}

/**
 * Both transcripts as Markdown: what ran where, why the real reader's walk ended, how the two line
 * up, then every row of the alignment with what each reader said that the other did not.
 */
export function sideBySide(comparison: ReaderComparison) {
  const { page, recordedAt, environment, virtual, real } = comparison;
  const rows = align(real.phrases, virtual);
  const counts = summarize(rows);
  return [
    `# What each screen reader said: ${page}`,
    "",
    `Recorded ${recordedAt} on ${environment.platform} ${environment.release}, with Guidepup ${environment.guidepup}; AEE's virtual reader speaks through ${environment.speechEngine}.`,
    "",
    "| Reader | Announcements |",
    "| --- | ---: |",
    `| ${VIRTUAL} | ${virtual.length} |`,
    `| ${real.reader} | ${real.phrases.length} |`,
    "",
    walkEnd(real),
    "",
    "## How the two line up",
    "",
    `Each row is one thing on the page: what each reader said about it, or what only one of them said. ${HOW_ROWS_LINE_UP}`,
    "",
    "| Rows | Count |",
    "| --- | ---: |",
    `| Both said the same words | ${counts.same} |`,
    `| Both said something here, in different words | ${counts.differ} |`,
    `| Only ${real.reader} said it | ${counts.onlyReal} |`,
    `| Only ${VIRTUAL} said it | ${counts.onlyVirtual} |`,
    "",
    "These counts describe how the two differ, not which one is right.",
    "",
    `| Row | ${VIRTUAL} | ${real.reader} | What differs |`,
    "| ---: | --- | --- | --- |",
    ...rows.map(
      (row, index) =>
        `| ${index + 1} | ${cell(row.virtual)} | ${cell(row.real)} | ${difference(row, real.reader)} |`
    ),
    ""
  ].join("\n");
}

/** One row of several readers' alignments merged: AEE's phrases, and each real reader's row. */
export interface CombinedRow {
  virtual: string[];
  /** Each real reader's row, in the order the comparisons were given; absent where it has none. */
  readers: (AlignedRow | undefined)[];
}

/** A reader's rows within one combined row, as one: their phrases and differences, in order. */
const merged = (rows: AlignedRow[]): AlignedRow => ({
  real: rows.flatMap(({ real }) => real),
  virtual: rows.flatMap(({ virtual }) => virtual),
  onlyReal: rows.flatMap(({ onlyReal }) => onlyReal),
  onlyVirtual: rows.flatMap(({ onlyVirtual }) => onlyVirtual)
});

/**
 * Several real readers lined up against AEE's virtual reader at once, one machine's comparison
 * each (NVDA on Windows, VoiceOver on a Mac). Each comparison keeps its own two-way alignment;
 * this merges them on AEE's phrases, which every comparison holds in the same order. A combined
 * row holds as few of AEE's steps as it can without splitting any reader's row: where NVDA says
 * in one phrase what AEE's reader and VoiceOver take three steps for, the row holds all three,
 * with each reader's phrases for them. A phrase only one real reader said, outside such a row,
 * gets its own row, where that reader said it. The comparisons must have read the same page with
 * the same virtual transcript, or there is nothing shared to line up on.
 */
export function combine(comparisons: ReaderComparison[]): CombinedRow[] {
  const [first] = comparisons;
  if (!first) throw new Error("No comparisons to combine.");
  for (const { page, virtual, real } of comparisons) {
    if (page !== first.page || virtual.join("\n") !== first.virtual.join("\n")) {
      throw new Error(
        `${real.reader}'s comparison read ${page} with a different virtual transcript from ${first.real.reader}'s (${first.page}); comparisons line up only on the same one.`
      );
    }
  }
  // Each reader's rows, with the run of AEE's steps each covers, from `start` up to `end`; a row
  // only the real reader said covers none and sits just before step `start`.
  const sides = comparisons.map(({ real }) => {
    let step = 0;
    return align(real.phrases, first.virtual).map((row) => ({
      row,
      start: step,
      end: (step += row.virtual.length)
    }));
  });
  const next = sides.map(() => 0);
  const alone = (index: number, row: AlignedRow): CombinedRow => ({
    virtual: [],
    readers: comparisons.map((_, other) => (other === index ? row : undefined))
  });
  const rows: CombinedRow[] = [];
  for (let start = 0; ;) {
    sides.forEach((side, index) => {
      for (let at = side[next[index]!]; at?.start === start && at.end === start;) {
        rows.push(alone(index, at.row));
        at = side[++next[index]!];
      }
    });
    if (start === first.virtual.length) return rows;
    // Grow the run of steps until no reader's row goes past its end.
    let end = start + 1;
    for (let grown = true; grown;) {
      grown = false;
      sides.forEach((side, index) => {
        for (let at = next[index]!; side[at] && side[at]!.start < end; at++) {
          if (side[at]!.end > end) [end, grown] = [side[at]!.end, true];
        }
      });
    }
    rows.push({
      virtual: first.virtual.slice(start, end),
      readers: sides.map((side, index) => {
        const taken: AlignedRow[] = [];
        while (side[next[index]!] && side[next[index]!]!.start < end) {
          taken.push(side[next[index]!++]!.row);
        }
        return merged(taken);
      })
    });
    start = end;
  }
}

/**
 * Every real reader's comparison in one Markdown page: what ran where and why each walk ended,
 * how each reader lines up with AEE's, then one table with a column for AEE's reader and, for each
 * real reader, what it said and what differs. A reader's cells are empty on a row another reader
 * said alone.
 */
export function readersSideBySide(comparisons: ReaderComparison[]) {
  const rows = combine(comparisons);
  const [{ page, environment }] = comparisons as [ReaderComparison];
  const readers = comparisons.map(({ real }) => real.reader);
  const counts = comparisons.map(({ real, virtual }) => summarize(align(real.phrases, virtual)));
  const countRow = (label: string, pick: (count: (typeof counts)[number]) => number) =>
    `| ${label} | ${counts.map(pick).join(" | ")} |`;
  return [
    `# What each screen reader said: ${page}`,
    "",
    `AEE's virtual reader speaks through ${environment.speechEngine}.`,
    "",
    "| Reader | Where it ran | Announcements |",
    "| --- | --- | ---: |",
    `| ${VIRTUAL} | each machine below, the same transcript | ${comparisons[0]!.virtual.length} |`,
    ...comparisons.map(
      ({ real, environment: ran, recordedAt }) =>
        `| ${real.reader} | ${ran.platform} ${ran.release}, Guidepup ${ran.guidepup}, ${recordedAt} | ${real.phrases.length} |`
    ),
    "",
    ...comparisons.flatMap(({ real }) => [walkEnd(real), ""]),
    "## How they line up",
    "",
    `Each row is one thing on the page: what AEE's reader and each real reader said about it, or what only one reader said. ${HOW_ROWS_LINE_UP}`,
    "",
    `| Rows | ${readers.join(" | ")} |`,
    `| --- | ${readers.map(() => "---:").join(" | ")} |`,
    countRow("Same words as AEE's reader", ({ same }) => same),
    countRow("About the same item, in different words", ({ differ }) => differ),
    countRow("Only the real reader said it", ({ onlyReal }) => onlyReal),
    countRow("Only AEE's reader said it", ({ onlyVirtual }) => onlyVirtual),
    "",
    "These counts describe how each reader differs from AEE's, not which one is right.",
    "",
    `| Row | ${VIRTUAL} | ${readers.map((reader) => `${reader} | What differs from ${reader}`).join(" | ")} |`,
    `| ---: | --- | ${readers.map(() => "--- | ---").join(" | ")} |`,
    ...rows.map(
      ({ virtual, readers: cells }, index) =>
        `| ${index + 1} | ${cell(virtual)} | ${cells
          .map(
            (row, reader) => `${cell(row?.real)} | ${row ? difference(row, readers[reader]!) : ""}`
          )
          .join(" | ")} |`
    ),
    ""
  ].join("\n");
}

/** Writes the comparison to `dir` as comparison.json, with its alignment, and comparison.md. */
export async function writeComparison(dir: string, comparison: ReaderComparison) {
  await mkdir(dir, { recursive: true });
  const alignment = align(comparison.real.phrases, comparison.virtual);
  await writeFile(
    path.join(dir, "comparison.json"),
    `${JSON.stringify({ ...comparison, alignment }, null, 2)}\n`
  );
  await writeFile(path.join(dir, "comparison.md"), sideBySide(comparison));
}
