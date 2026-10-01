// `npm run readers:compare -- [page]`: reads a page with the virtual screen reader and with the
// real one on this machine (VoiceOver on macOS, NVDA on Windows), through screen-reader-cli, and
// writes both transcripts side by side in test-results/readers/. The page defaults to the demo
// page. The real reader takes over the machine while it reads: leave the keyboard and mouse alone.
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { SCREEN_READER_CLI_VERSION, screenReaderCli } from "./screen-reader-cli.mjs";

const REAL_READERS = { darwin: "VoiceOver", win32: "NVDA" };
/** More steps than the virtual reader's 92 announcements on the demo page. */
const REAL_READER_STEPS = "150";

/** The real screen reader this platform has, by name. */
export function realReaderName(platform = process.platform) {
  return REAL_READERS[platform] ?? "A real screen reader";
}

const cell = (phrase) => (phrase ?? "").replaceAll("|", "\\|");

/**
 * Both transcripts as Markdown: a line on what ran where, then one row per step in reading order.
 * Rows line up by step, not by element, since each reader groups a page's content its own way.
 */
export function sideBySide({ page, recordedAt, environment, virtual, real }) {
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

async function readAloud(args) {
  const { stdout } = await screenReaderCli([...args, "--json"]);
  return JSON.parse(stdout).phrases;
}

async function main(page = "site/test-case.html") {
  const virtual = await readAloud(["audit", page]);
  const real = { reader: realReaderName() };
  try {
    real.phrases = await readAloud(["live", "read", page, "--steps", REAL_READER_STEPS]);
  } catch (error) {
    // screen-reader-cli says on stderr why the real reader cannot run here.
    real.notRun = (error.stderr?.trim() || error.message).replace(/\s+/g, " ");
  }
  const comparison = {
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
  const dir = path.join("test-results", "readers");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "comparison.json"), `${JSON.stringify(comparison, null, 2)}\n`);
  await writeFile(path.join(dir, "comparison.md"), sideBySide(comparison));
  console.log(`Wrote ${path.join(dir, "comparison.md")}.`);
  if (real.notRun) {
    console.error(`${real.reader} did not run: ${real.notRun}`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main(process.argv[2]);
}
