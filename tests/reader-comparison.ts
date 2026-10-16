import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ScreenReader } from "@guidepup/guidepup";
import type { Page } from "@playwright/test";

import { createPortableVirtualScreenReader } from "@aee/playwright";

export interface ReaderComparison {
  page: string;
  recordedAt: string;
  environment: { platform: string; release: string; guidepup: string };
  /** What AEE's own virtual screen reader said. */
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
export async function readWithVirtualReader(page: Page): Promise<string[]> {
  const reader = createPortableVirtualScreenReader(page);
  const phrases: string[] = [];
  for (let entry = await reader.command("start"); entry.item;) {
    phrases.push(entry.announcement);
    entry = await reader.command("next-item");
  }
  return phrases;
}

/**
 * The real screen reader reads on from where it entered the page, one item per step. It stops
 * when it says nothing, when it says the same thing three times in a row (the end of the page,
 * for readers that repeat there), or after `maxSteps`.
 */
export async function readWithRealReader(reader: ScreenReader, maxSteps: number) {
  const phrases = [await reader.lastSpokenPhrase()];
  while (phrases.length < maxSteps) {
    await reader.next();
    const phrase = await reader.lastSpokenPhrase();
    if (!phrase.trim()) break;
    phrases.push(phrase);
    const [a, b, c] = phrases.slice(-3);
    if (phrases.length >= 3 && a === b && b === c) break;
  }
  return phrases.filter((phrase) => phrase.trim());
}

const cell = (phrase = "") => phrase.replaceAll("|", "\\|").replaceAll("\n", " ");

/**
 * Both transcripts as Markdown: a line on what ran where, then one row per step in reading order.
 * Rows line up by step, not by element, since each reader groups a page's content its own way.
 */
export function sideBySide({ page, recordedAt, environment, virtual, real }: ReaderComparison) {
  const rows = Array.from(
    { length: Math.max(virtual.length, real.phrases.length) },
    (_, step) => `| ${step + 1} | ${cell(virtual[step])} | ${cell(real.phrases[step])} |`
  );
  return [
    `# What each screen reader said: ${page}`,
    "",
    `Recorded ${recordedAt} on ${environment.platform} ${environment.release}, with Guidepup ${environment.guidepup}.`,
    "",
    `- AEE's virtual screen reader: ${virtual.length} announcements.`,
    `- ${real.reader}: ${real.phrases.length} announcements.`,
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
