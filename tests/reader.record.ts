import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { test } from "@playwright/test";

import { recordVirtualReader } from "./reader-recording";

// The page to read: AEE_READERS_PAGE, a file or a URL, else the demo page.
const page = process.env.AEE_READERS_PAGE ?? "site/test-case.html";
const url = existsSync(page) ? pathToFileURL(path.resolve(page)).href : page;
const dir = path.join("test-results", "reader");

test(`AEE's virtual screen reader reads ${page} on video`, async ({ browser }) => {
  await mkdir(dir, { recursive: true });
  const video = path.join(dir, "reading.webm");
  const text = path.join(dir, "reading.txt");
  await recordVirtualReader(browser, url, video, text);
  console.log(`Wrote ${video} and ${text}.`);
});
