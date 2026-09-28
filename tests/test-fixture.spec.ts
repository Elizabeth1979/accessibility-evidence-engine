import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test } from "@playwright/test";

test("an existing spec with only its import swapped produces findings", async () => {
  const testInfo = test.info();
  test.setTimeout(120_000);
  const original = await readFile("examples/playwright-fixture/existing.spec.ts", "utf8");
  const swapped = original.replace(
    'import { expect, test } from "@playwright/test";',
    'import { expect, test } from "@aee/cli/test";'
  );
  expect(swapped).not.toBe(original);
  // The spec runs as its own suite, from the repository root like the original.
  const suiteDir = testInfo.outputPath("suite");
  const config = path.join(suiteDir, "playwright.config.js");
  await mkdir(suiteDir, { recursive: true });
  await writeFile(path.join(suiteDir, "existing.spec.ts"), swapped, "utf8");
  // A state no page load reaches is checked only when the test names it.
  await writeFile(path.join(suiteDir, "dialog.spec.ts"), DIALOG_SPEC, "utf8");
  await writeFile(config, "module.exports = { testDir: __dirname };\n", "utf8");
  await promisify(execFile)(process.execPath, [
    require.resolve("@playwright/test/cli"),
    "test",
    `--config=${config}`,
    `--output=${path.join(suiteDir, "results")}`,
    "--reporter=line"
  ]);

  const existing = await readAssessment(suiteDir, "existing");
  expect(existing.profile).toBe("playwright-test");
  expect(existing.actions.map(({ driver, actionId }) => [driver, actionId])).toEqual([
    ["playwright-test", "checkpoint-1-after-goto"],
    ["playwright-test", "checkpoint-2-test-end"]
  ]);
  expect(existing.synthesis.findings.map(({ ruleId }) => ruleId)).toEqual(
    expect.arrayContaining(["button-name", "image-alt", "label", "link-name"])
  );

  const dialog = await readAssessment(suiteDir, "dialog");
  expect(dialog.actions.map(({ actionId }) => actionId)).toEqual([
    "checkpoint-1-after-setcontent",
    "checkpoint-2-dialog-open",
    "checkpoint-3-test-end"
  ]);
  // Only the checkpoint the test named saw the open dialog's image.
  expect(
    dialog.synthesis.findings.map(({ ruleId, checkpoints }) => [
      ruleId,
      checkpoints.map(({ actionId }) => actionId)
    ])
  ).toEqual([["image-alt", ["checkpoint-2-dialog-open"]]]);
});

const DIALOG_SPEC = `import { expect, test } from "@aee/cli/test";

test("the help dialog opens and closes", async ({ page, checkpoint }) => {
  await page.setContent(\`<!doctype html><html lang="en"><title>Help</title><main><h1>Help</h1>
    <button type="button" onclick="document.querySelector('dialog').showModal()">Open help</button>
    <dialog aria-label="Help"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">
      <form method="dialog"><button>Close</button></form></dialog></main></html>\`);
  await page.getByRole("button", { name: "Open help" }).click();
  await checkpoint("dialog open");
  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
});
`;

/** The one assessment a spec's test wrote; each checkpoint's own run report sits below it. */
async function readAssessment(suiteDir: string, spec: string) {
  const comments = (await findFiles(suiteDir, "aee-pr-comment.md")).filter((file) =>
    path.relative(suiteDir, file).startsWith(path.join("results", `${spec}-`))
  );
  expect(comments).toHaveLength(1);
  return JSON.parse(
    await readFile(path.join(path.dirname(comments[0]!), "aee-report.json"), "utf8")
  ) as {
    profile: string;
    actions: Array<{ driver: string; actionId: string }>;
    synthesis: { findings: Array<{ ruleId: string; checkpoints: Array<{ actionId: string }> }> };
  };
}

async function findFiles(directory: string, basename: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === basename)
    .map((entry) => path.join(entry.parentPath, entry.name));
}
