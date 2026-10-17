import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { screenReaderTest as test } from "@guidepup/playwright";

import {
  GUIDEPUP_VERSION,
  readWithRealReader,
  readWithVirtualReader,
  realReaderName,
  writeComparison
} from "./reader-comparison";

// The page to read: AEE_READERS_PAGE, a file or a URL, else the demo page.
const page = process.env.AEE_READERS_PAGE ?? "site/test-case.html";
const url = existsSync(page) ? pathToFileURL(path.resolve(page)).href : page;
const dir = path.join("test-results", "readers");
/** Room for the real reader to say more than the virtual one before the walk stops. */
const EXTRA_REAL_STEPS = 30;

// Guidepup starts the real screen reader before the test and stops it after, and steps it into
// the page. Where it cannot start, the test fails with Guidepup's reason, and nothing is written:
// a comparison with one side missing compares nothing.
test(`AEE's virtual screen reader and ${realReaderName()} read ${page}`, async ({
  page: browserPage,
  screenReader
}) => {
  await browserPage.goto(url);
  const { phrases: virtual, speechEngine } = await readWithVirtualReader(browserPage);

  await screenReader.navigateToWebContent();
  const phrases = await readWithRealReader(screenReader, virtual.length + EXTRA_REAL_STEPS);

  await writeComparison(dir, {
    page,
    recordedAt: new Date().toISOString(),
    environment: {
      platform: process.platform,
      release: os.release(),
      guidepup: GUIDEPUP_VERSION,
      speechEngine
    },
    virtual,
    real: { reader: realReaderName(), phrases }
  });
  console.log(
    `Wrote ${path.join(dir, "comparison.md")}: AEE's virtual reader ${virtual.length} announcements, ${realReaderName()} ${phrases.length}.`
  );
});
