import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { test } from "@playwright/test";

import { readersSideBySide, type ReaderComparison } from "./reader-comparison";

// The folder holding one folder per real reader's run, each with the comparison.json that
// `npm run readers:compare` wrote on that machine: AEE_READERS_RUNS, else test-results/readers-runs.
const runs = process.env.AEE_READERS_RUNS ?? path.join("test-results", "readers-runs");
const out = path.join("test-results", "readers", "combined.md");

// Puts every real reader that ran next to AEE's virtual reader in one table. In GitHub Actions the
// table is also added to the run's summary, so it shows on the run's page without a download.
test("every real reader that ran, next to AEE's virtual reader", async () => {
  const folders = (await readdir(runs, { withFileTypes: true })).filter((entry) =>
    entry.isDirectory()
  );
  const comparisons = await Promise.all(
    folders.map(
      async ({ name }) =>
        JSON.parse(
          await readFile(path.join(runs, name, "comparison.json"), "utf8")
        ) as ReaderComparison
    )
  );
  const markdown = readersSideBySide(comparisons);
  await mkdir(path.dirname(out), { recursive: true });
  await writeFile(out, markdown);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, markdown);
  console.log(
    `Wrote ${out}: ${comparisons.map(({ real }) => real.reader).join(" and ")} next to AEE's virtual reader.`
  );
});
