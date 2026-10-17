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
 * The real screen reader reads on from where it entered the page, one item per step. Each step
 * waits until the reader has finished speaking (`capture: true`): by default Guidepup reads once,
 * just after the key press, and gets nothing when the reader is slow to speak, which would end
 * the walk halfway down the page. The walk ends for one of the reasons in `WalkEnd`, and says which.
 */
export async function readWithRealReader(
  reader: Pick<ScreenReader, "next" | "lastSpokenPhrase">,
  maxSteps: number
): Promise<{ phrases: string[]; stoppedBecause: WalkEnd }> {
  const phrases = [withoutReaderHints(await reader.lastSpokenPhrase())];
  const said = () => phrases.filter(Boolean);
  while (phrases.length < maxSteps) {
    await reader.next({ capture: true });
    const phrase = withoutReaderHints(await reader.lastSpokenPhrase());
    if (!phrase) return { phrases: said(), stoppedBecause: "silence" };
    phrases.push(phrase);
    const [a, b, c] = phrases.slice(-3);
    if (phrases.length >= 3 && a === b && b === c) {
      return { phrases: said(), stoppedBecause: "repeated" };
    }
  }
  return { phrases: said(), stoppedBecause: "step-limit" };
}

const cell = (phrase = "") => phrase.replaceAll("|", "\\|").replaceAll("\n", " ");

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

interface Step {
  real?: string;
  virtual?: string;
}

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
    for (let i = 0; i < count; i++) {
      if (removed) result.push({ real: real[r++] });
      else if (added) result.push({ virtual: virtual[v++] });
      else result.push({ real: real[r++], virtual: virtual[v++] });
    }
  }
  return result;
}

/** One row of the alignment: a phrase from either reader or both, and the words only one said. */
export interface AlignedRow extends Step {
  onlyReal: string[];
  onlyVirtual: string[];
}

const toRow = ({ real = "", virtual = "" }: Step): AlignedRow => ({
  ...(real && { real }),
  ...(virtual && { virtual }),
  ...wordDifference(real, virtual)
});

/**
 * The two transcripts lined up both ways, the way a text diff lines up two files and then shows
 * the words that changed within a line. jsdiff first pairs the phrases with the same words. Between
 * those, it pairs the phrases about the same item, and what is left is a row said by one reader
 * only. Every phrase from both readers is in a row, in its reader's order.
 */
export function align(real: string[], virtual: string[]): AlignedRow[] {
  const rows: AlignedRow[] = [];
  let unpaired = { real: [] as string[], virtual: [] as string[] };
  const pairUnpaired = () => {
    rows.push(...steps(unpaired.real, unpaired.virtual, sameItem).map(toRow));
    unpaired = { real: [], virtual: [] };
  };
  for (const step of steps(real, virtual, sameWords)) {
    if (step.real !== undefined && step.virtual !== undefined) {
      pairUnpaired();
      rows.push(toRow(step));
    } else if (step.real !== undefined) unpaired.real.push(step.real);
    else if (step.virtual !== undefined) unpaired.virtual.push(step.virtual);
  }
  pairUnpaired();
  return rows;
}

/** How many rows of the alignment are the same, differ, or were said by one reader only. */
export function summarize(rows: AlignedRow[]) {
  const count = (test: (row: AlignedRow) => boolean) => rows.filter(test).length;
  const both = (row: AlignedRow) => row.real !== undefined && row.virtual !== undefined;
  return {
    same: count((row) => both(row) && !row.onlyReal.length && !row.onlyVirtual.length),
    differ: count((row) => both(row) && (row.onlyReal.length > 0 || row.onlyVirtual.length > 0)),
    onlyReal: count((row) => row.virtual === undefined),
    onlyVirtual: count((row) => row.real === undefined)
  };
}

const VIRTUAL = "AEE's virtual screen reader";

/** Why the real reader's walk ended, in a sentence, and whether it needed a retry to start. */
function walkEnd({
  reader,
  phrases,
  stoppedBecause,
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
      return `${read} and said the same thing three times in a row, which is how it marks the end of the page, so its walk ended there.${retried}`;
    case "step-limit":
      return `${read} and was stopped at the limit of ${maxSteps} steps, so it may not have reached the end of the page. What it would have said after that is not here: rows near the end that only ${VIRTUAL} said may be page ${reader} never reached.${retried}`;
  }
}

/** What differs in a row, for its last cell. */
function difference(row: AlignedRow, reader: string) {
  if (row.virtual === undefined) return `only ${reader} said this`;
  if (row.real === undefined) return `only ${VIRTUAL} said this`;
  const only = (who: string, said: string[]) =>
    said.length ? [`only ${who}: **${cell(said.join(" "))}**`] : [];
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
    `Each row is one thing on the page: a phrase from each reader about the same item, or a phrase only one of them said. Two phrases are about the same item when they have at least as many words in common as words that differ. Every word counts, including role and state words such as "button", "link", "not", "checked" and "expanded"; only the order of words within a phrase does not, since each reader orders role, name and state its own way.`,
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

/** One row of several readers' alignments merged: AEE's phrase, and each real reader's row. */
export interface CombinedRow {
  virtual?: string;
  /** Each real reader's row, in the order the comparisons were given; absent where it has none. */
  readers: (AlignedRow | undefined)[];
}

/**
 * Several real readers lined up against AEE's virtual reader at once, one machine's comparison
 * each (NVDA on Windows, VoiceOver on a Mac). Each comparison keeps its own two-way alignment;
 * this merges them on AEE's phrases, which every comparison holds in the same order. A phrase only
 * one real reader said gets its own row, where that reader said it. The comparisons must have read
 * the same page with the same virtual transcript, or there is nothing shared to line up on.
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
  const sides = comparisons.map(({ real }) => {
    const before: AlignedRow[][] = first.virtual.map(() => []);
    const after: AlignedRow[] = [];
    const paired: AlignedRow[] = [];
    for (const row of align(real.phrases, first.virtual)) {
      if (row.virtual !== undefined) paired.push(row);
      else (before[paired.length] ?? after).push(row);
    }
    return { before, paired, after };
  });
  const alone = (index: number, row: AlignedRow): CombinedRow => ({
    readers: comparisons.map((_, other) => (other === index ? row : undefined))
  });
  return [
    ...first.virtual.flatMap((virtual, step) => [
      ...sides.flatMap(({ before }, index) => before[step]!.map((row) => alone(index, row))),
      { virtual, readers: sides.map(({ paired }) => paired[step]) }
    ]),
    ...sides.flatMap(({ after }, index) => after.map((row) => alone(index, row)))
  ];
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
    `Each row is one thing on the page: AEE's phrase with each real reader's phrase about the same item, or a phrase only one reader said. Two phrases are about the same item when they have at least as many words in common as words that differ. Every word counts, including role and state words such as "button", "link", "not", "checked" and "expanded"; only the order of words within a phrase does not, since each reader orders role, name and state its own way.`,
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
