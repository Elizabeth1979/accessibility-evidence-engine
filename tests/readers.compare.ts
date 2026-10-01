import path from "node:path";

import { expect, test } from "@playwright/test";

import { compareReaders } from "./reader-comparison";

// The page to read: AEE_READERS_PAGE, a file or a URL, else the demo page.
const page = process.env.AEE_READERS_PAGE ?? "site/test-case.html";
const dir = path.join("test-results", "readers");

test(`the virtual and the real screen reader read ${page}`, async () => {
  const { real, virtual } = await compareReaders(page, dir);
  console.log(
    `Wrote ${path.join(dir, "comparison.md")}: virtual reader ${virtual.length} announcements, ${real.reader} ${real.phrases ? `${real.phrases.length} announcements` : "not run"}.`
  );
  // A comparison with one side missing compared nothing, so it is never a pass.
  expect(real.notRun, `${real.reader} did not run`).toBeUndefined();
});
