import { appendFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { test } from "@playwright/test";

import { readersSideBySide, type ReaderComparison } from "./reader-comparison";

// The folder holding the comparison.json that `npm run readers:compare` wrote on each machine:
// AEE_READERS_RUNS, else test-results/readers-runs. Each may sit at any depth: GitHub's
// download-artifact gives each attachment its own folder when there are several, and puts a single
// one's files straight in the folder.
const runs = process.env.AEE_READERS_RUNS ?? path.join("test-results", "readers-runs");
const out = path.join("test-results", "readers", "combined.md");

// Puts every real reader that ran next to AEE's virtual reader in one table. In GitHub Actions the
// table is also added to the run's summary, so it shows on the run's page without a download.
test("every real reader that ran, next to AEE's virtual reader", async () => {
  const files = (await readdir(runs, { recursive: true }))
    .filter((file) => path.basename(file) === "comparison.json")
    .sort();
  if (files.length === 0) throw new Error(`No comparison.json found under ${runs}.`);
  const comparisons = await Promise.all(
    files.map(
      async (file) => JSON.parse(await readFile(path.join(runs, file), "utf8")) as ReaderComparison
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
