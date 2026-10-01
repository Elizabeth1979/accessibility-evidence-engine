import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// screen-reader-cli, the dev dependency that reads pages aloud: its virtual screen reader on any
// machine, and VoiceOver or NVDA through its Guidepup live bridge on a Mac or Windows machine.
const packageFile = require.resolve("screen-reader-cli/package.json");
const { bin, version } = JSON.parse(readFileSync(packageFile, "utf8")) as {
  bin: { screenreader: string };
  version: string;
};

export const SCREEN_READER_CLI_VERSION = version;

/** Runs `screenreader` with these arguments; resolves with its output, rejects when it fails. */
export function screenReaderCli(args: string[]) {
  return promisify(execFile)(
    process.execPath,
    [path.join(path.dirname(packageFile), bin.screenreader), ...args],
    { maxBuffer: 16 * 1024 * 1024 }
  );
}
