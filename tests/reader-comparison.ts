import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ScreenReader } from "@guidepup/guidepup";
import type { Page } from "@playwright/test";

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
  /** What the real screen reader on this machine said. */
  real: { reader: string; phrases: string[] };
}

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
 * the walk halfway down the page. It stops when the reader says nothing, when it says the same
 * thing three times in a row (the end of the page, for readers that repeat there), or after
 * `maxSteps`.
 */
export async function readWithRealReader(reader: ScreenReader, maxSteps: number) {
  const phrases = [withoutReaderHints(await reader.lastSpokenPhrase())];
  while (phrases.length < maxSteps) {
    await reader.next({ capture: true });
    const phrase = withoutReaderHints(await reader.lastSpokenPhrase());
    if (!phrase) break;
    phrases.push(phrase);
    const [a, b, c] = phrases.slice(-3);
    if (phrases.length >= 3 && a === b && b === c) break;
  }
  return phrases.filter(Boolean);
}

const cell = (phrase = "") => phrase.replaceAll("|", "\\|").replaceAll("\n", " ");

/**
 * Words a screen reader adds about what something is, where it is or how to use it, not what the
 * page says. Each reader words these its own way ("heading level 1 Workspace" against "Workspace,
 * heading, level 1"), so they are left out when phrases are compared.
 */
const READER_WORDS = new Set([
  "a",
  "an",
  "article",
  "banner",
  "blank",
  "button",
  "checkbox",
  "checked",
  "collapsed",
  "complementary",
  "content",
  "contentinfo",
  "current",
  "document",
  "edit",
  "end",
  "expanded",
  "field",
  "footer",
  "form",
  "group",
  "heading",
  "image",
  "in",
  "item",
  "items",
  "landmark",
  "level",
  "link",
  "list",
  "listitem",
  "main",
  "navigation",
  "not",
  "of",
  "page",
  "paragraph",
  "pressed",
  "region",
  "search",
  "searchbox",
  "selected",
  "text",
  "textbox",
  "the",
  "toggle",
  "unlabeled",
  "web"
]);

/** What the page itself says in a phrase: its words, less the reader's own. */
export function pageWords(phrase: string): Set<string> {
  const words = phrase.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return new Set(words.filter((word) => word && !READER_WORDS.has(word)));
}

/**
 * What the page says in a real reader's phrase. VoiceOver adds a list's size ("list 3 items") and
 * ends a list item with its position ("1 of 2"); both are the reader's, so they are dropped first.
 */
export function realPageWords(phrase: string): Set<string> {
  return pageWords(phrase.replace(/\b\d+ items?\b/g, "").replace(/\s\d+ of \d+$/, ""));
}

export interface Agreement {
  /** The real reader's phrases that say something of the page's own. */
  compared: number;
  /** Of those, the phrases this reader also says. */
  heard: number;
  /** The real reader's phrases this reader does not say. */
  missed: string[];
}

/**
 * How much of what the real reader said this reader also says: a real phrase counts as heard when
 * one of this reader's phrases holds every word of it that the page says. Order and the reader's
 * own words do not count. A rough measure; the side-by-side table is the evidence.
 */
export function agreement(real: string[], reader: string[]): Agreement {
  const readerWords = reader.map(pageWords);
  const compared = real.filter((phrase) => realPageWords(phrase).size > 0);
  const missed = compared.filter((phrase) => {
    const words = [...realPageWords(phrase)];
    return !readerWords.some((said) => words.every((word) => said.has(word)));
  });
  return { compared: compared.length, heard: compared.length - missed.length, missed };
}

const percent = ({ compared, heard }: Agreement) =>
  compared === 0 ? "—" : `${Math.round((heard / compared) * 100)}%`;

/**
 * Both transcripts as Markdown: what ran where, how much of the real reader the virtual reader also
 * says, then one row per step in reading order. Rows line up by step, not by element, since each
 * reader groups a page's content its own way.
 */
export function sideBySide({ page, recordedAt, environment, virtual, real }: ReaderComparison) {
  const score = agreement(real.phrases, virtual);
  const rows = Array.from(
    { length: Math.max(virtual.length, real.phrases.length) },
    (_, step) => `| ${step + 1} | ${cell(virtual[step])} | ${cell(real.phrases[step])} |`
  );
  return [
    `# What each screen reader said: ${page}`,
    "",
    `Recorded ${recordedAt} on ${environment.platform} ${environment.release}, with Guidepup ${environment.guidepup}; AEE's virtual reader speaks through ${environment.speechEngine}.`,
    "",
    `| Reader | Announcements | Says what ${real.reader} says |`,
    "| --- | ---: | ---: |",
    `| AEE's virtual screen reader | ${virtual.length} | ${percent(score)} (${score.heard} of ${score.compared}) |`,
    `| ${real.reader} | ${real.phrases.length} | |`,
    "",
    `A ${real.reader} phrase counts when the virtual reader has a phrase with every word of it that the page says; each reader's own words ("heading", "level", "end of list", a list position) and the order do not count. A rough measure; the table below is the evidence.`,
    "",
    `${real.reader} said, and AEE's virtual screen reader did not:`,
    "",
    ...(score.missed.length ? score.missed.map((phrase) => `- ${cell(phrase)}`) : ["- nothing"]),
    "",
    "Rows line up by step, not by element: each reader groups a page's content its own way.",
    "",
    `| Step | AEE's virtual screen reader | ${real.reader} |`,
    "| ---: | --- | --- |",
    ...rows,
    ""
  ].join("\n");
}

/** Writes the comparison to `dir` as comparison.json and comparison.md. */
export async function writeComparison(dir: string, comparison: ReaderComparison) {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  await writeFile(path.join(dir, "comparison.md"), sideBySide(comparison));
}
