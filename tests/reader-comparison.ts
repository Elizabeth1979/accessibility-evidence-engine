import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { SCREEN_READER_CLI_VERSION, screenReaderCli } from "./screen-reader-cli";

export interface ReaderComparison {
  page: string;
  recordedAt: string;
  environment: { platform: string; release: string; screenReaderCli: string };
  virtual: string[];
  /** What the real screen reader said, or why it could not run here. */
  real: { reader: string; phrases?: string[]; notRun?: string };
}

const REAL_READERS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "VoiceOver",
  win32: "NVDA"
};
/** More steps than the virtual reader's 92 announcements on the demo page. */
const REAL_READER_STEPS = "150";

/** The real screen reader this platform has, by name. */
export function realReaderName(platform: NodeJS.Platform = process.platform) {
  return REAL_READERS[platform] ?? "A real screen reader";
}

const cell = (phrase = "") => phrase.replaceAll("|", "\\|");

/**
 * Both transcripts as Markdown: a line on what ran where, then one row per step in reading order.
 * Rows line up by step, not by element, since each reader groups a page's content its own way.
 */
export function sideBySide({ page, recordedAt, environment, virtual, real }: ReaderComparison) {
  const realLine = real.phrases
    ? `${real.reader}: ${real.phrases.length} announcements.`
    : `${real.reader}: not run. ${real.notRun}`;
  const rows = Array.from(
    { length: Math.max(virtual.length, real.phrases?.length ?? 0) },
    (_, step) => `| ${step + 1} | ${cell(virtual[step])} | ${cell(real.phrases?.[step])} |`
  );
  return [
    `# What each screen reader said: ${page}`,
    "",
    `Recorded ${recordedAt} on ${environment.platform} ${environment.release}, with screen-reader-cli ${environment.screenReaderCli}.`,
    "",
    `- Virtual screen reader: ${virtual.length} announcements.`,
    `- ${realLine}`,
    "",
    "Rows line up by step, not by element: each reader groups a page's content its own way.",
    "",
    `| Step | Virtual screen reader | ${real.reader} |`,
    "| ---: | --- | --- |",
    ...rows,
    ""
  ].join("\n");
}

async function readAloud(args: string[]) {
  const { stdout } = await screenReaderCli([...args, "--json"]);
  return (JSON.parse(stdout) as { phrases: string[] }).phrases;
}

/**
 * Reads a page with the virtual screen reader and with the real one on this machine, through
 * screen-reader-cli, and writes both transcripts side by side to `dir`.
 */
export async function compareReaders(page: string, dir: string): Promise<ReaderComparison> {
  const virtual = await readAloud(["audit", page]);
  const real: ReaderComparison["real"] = { reader: realReaderName() };
  try {
    real.phrases = await readAloud(["live", "read", page, "--steps", REAL_READER_STEPS]);
  } catch (error) {
    // screen-reader-cli says on stderr why the real reader cannot run here.
    const { stderr, message } = error as { stderr?: string; message: string };
    real.notRun = (stderr?.trim() || message).replace(/\s+/g, " ");
  }
  const comparison: ReaderComparison = {
    page,
    recordedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      release: os.release(),
      screenReaderCli: SCREEN_READER_CLI_VERSION
    },
    virtual,
    real
  };
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  await writeFile(path.join(dir, "comparison.md"), sideBySide(comparison));
  return comparison;
}
