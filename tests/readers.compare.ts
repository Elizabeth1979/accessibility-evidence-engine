import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { screenReaderTest as test } from "@guidepup/playwright";
import { linuxRecord, macOSRecord, windowsRecord } from "@guidepup/record";

import {
  GUIDEPUP_VERSION,
  readWithRealReader,
  readWithVirtualReader,
  realReaderName,
  writeComparison
} from "./reader-comparison";
import {
  command,
  CommandLog,
  detail,
  osLocale,
  readerBuild,
  readerSettings,
  readerVersion,
  runnerImage
} from "./reader-run-details";

// The page to read: AEE_READERS_PAGE, a file or a URL, else the demo page.
const page = process.env.AEE_READERS_PAGE ?? "site/test-case.html";
const url = existsSync(page) ? pathToFileURL(path.resolve(page)).href : page;
const dir = path.join("test-results", "readers");
/** Room for the real reader to say more than the virtual one before the walk stops. */
const EXTRA_REAL_STEPS = 30;
/**
 * With AEE_READERS_RECORD set, the whole screen is recorded while the real reader reads, with
 * Guidepup's own recorder (ffmpeg): on Windows, NVDA's Speech Viewer shows each phrase as it is
 * spoken. Off by default, since recording a Mac's screen needs its own permission.
 */
const RECORDERS = { win32: windowsRecord, darwin: macOSRecord, linux: linuxRecord };
const record = process.env.AEE_READERS_RECORD
  ? RECORDERS[process.platform as keyof typeof RECORDERS]
  : undefined;

// Guidepup starts the real screen reader before the test and stops it after, and steps it into
// the page. Where it cannot start, the test fails with Guidepup's reason, and nothing is written:
// a comparison with one side missing compares nothing. A retry (`--retries`) tries again from the
// start, and the comparison says which attempt it came from.
test(`AEE's virtual screen reader and ${realReaderName()} read ${page}`, async ({
  page: browserPage,
  browser,
  screenReader,
  screenReaderStartOptions
}, testInfo) => {
  await browserPage.goto(url);
  const { phrases: virtual, speechEngine } = await readWithVirtualReader(browserPage);

  await mkdir(dir, { recursive: true });
  const stopRecording = record?.(path.resolve(dir, "real-reader.mp4"));
  const maxSteps = virtual.length + EXTRA_REAL_STEPS;
  const log = new CommandLog();
  // Guidepup's fixture started the reader with these options before the test.
  log.sent(command("start", screenReaderStartOptions));
  const { phrases, stoppedBecause, repeatedAtEnd } = await log
    .send(command("navigateToWebContent"), () => screenReader.navigateToWebContent())
    .then(() => readWithRealReader(screenReader, maxSteps, log))
    .finally(() => stopRecording?.());

  const reader = realReaderName();
  await writeComparison(dir, {
    page,
    recordedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      release: os.release(),
      guidepup: GUIDEPUP_VERSION,
      speechEngine,
      ...runnerImage(),
      browser: detail(
        browser.browserType().name(),
        "Playwright's browserType().name()",
        "Playwright names no browser"
      ),
      browserVersion: detail(
        browser.version(),
        "Playwright's browser.version()",
        "the browser reports no version"
      ),
      osLocale: osLocale(),
      browserLocale: detail(
        await browserPage.evaluate(() => navigator.language),
        "the browser's navigator.language",
        "the browser reports no language"
      )
    },
    virtual,
    real: {
      reader,
      readerVersion: await readerVersion(reader),
      readerBuild: readerBuild(screenReader.version),
      ...readerSettings(reader, () => screenReader.getSettings()),
      commands: log.commands,
      attempt: testInfo.retry + 1,
      retriesAllowed: testInfo.project.retries,
      phrases,
      stoppedBecause,
      repeatedAtEnd,
      maxSteps
    }
  });
  console.log(
    `Wrote ${path.join(dir, "comparison.md")}: AEE's virtual reader ${virtual.length} announcements, ${reader} ${phrases.length} (stopped: ${stoppedBecause}).`
  );
});
