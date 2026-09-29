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
  // A test that takes the page but never loads one leaves nothing to check.
  await writeFile(path.join(suiteDir, "blank.spec.ts"), BLANK_SPEC, "utf8");
  await writeFile(path.join(suiteDir, "gradients.spec.ts"), GRADIENTS_SPEC, "utf8");
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

  expect(await assessmentComments(suiteDir, "blank")).toEqual([]);

  // The fixture checks pages with axe alone, and its rows say so instead of asking for a review.
  expect(existing.synthesis.status.map(({ id, result }) => [id, result]).slice(0, 2)).toEqual([
    ["keyboard", "Not in this run"],
    ["reader", "Not in this run"]
  ]);

  // Contrast axe could not decide over a gradient is measured from the pixels behind the text.
  const gradients = await readAssessment(suiteDir, "gradients");
  expect(gradients.verdict).toBe("fail");
  const contrast = gradients.synthesis.findings.find(({ ruleId }) => ruleId === "color-contrast");
  expect(contrast?.instances.map(({ selector }) => selector)).toEqual(["#pale"]);
  expect(contrast?.instances[0]?.detail).toMatch(
    /^Measured from the screenshot, the text has a contrast of 2\.\d+ to 2\.\d+ .*Expected contrast ratio of 4\.5:1$/
  );
  // What the pixels cannot settle is left for a person, each text once with why.
  expect(gradients.synthesis.undecidedContrast).toEqual([
    {
      selector: "#mixed",
      reason: expect.stringMatching(
        /^text over a gradient, measured at 1\.\d+:1 to 5\.\d+:1 against what is behind it, where 4\.5:1 is needed$/
      )
    },
    {
      selector: "#shadow",
      reason: "text over a gradient; not measured, as it has a text shadow or outline"
    }
  ]);
  const comment = await readFile((await assessmentComments(suiteDir, "gradients"))[0]!, "utf8");
  expect(comment).toContain("**Contrast left for a person (2):**");
  expect(comment).toContain("- `#shadow`: text over a gradient; not measured");
});

/** Four texts over gradients: one passes, one fails, and two are left for a person. */
const GRADIENTS_SPEC = `import { expect, test } from "@aee/cli/test";

test("text over gradients", async ({ page }) => {
  await page.setContent(\`<!doctype html><html lang="en"><title>Gradients</title>
    <style>div{padding:20px}#dark,#shadow{color:#fff}</style><main><h1>Gradients</h1>
    <div style="background:linear-gradient(90deg,#111,#333)"><p id="dark">White on dark</p></div>
    <div style="background:linear-gradient(90deg,#fff,#ddd)"><p id="pale" style="color:#aaa">Pale on pale</p></div>
    <div style="background:linear-gradient(90deg,#fff 0,#fff 60px,#000 61px);padding:20px 0">
      <p id="mixed" style="color:#888;width:200px">Grey across white and black</p></div>
    <div style="background:linear-gradient(90deg,#111,#333)">
      <p id="shadow" style="text-shadow:0 0 2px #000">Shadowed</p></div></main></html>\`);
  await expect(page.getByRole("heading")).toHaveText("Gradients");
});
`;

const BLANK_SPEC = `import { expect, test } from "@aee/cli/test";

test("reads the blank page without loading one", async ({ page }) => {
  expect(await page.evaluate(() => document.title)).toBe("");
});
`;

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

/** The assessments a spec's tests wrote, one PR comment each. */
async function assessmentComments(suiteDir: string, spec: string) {
  return (await findFiles(suiteDir, "aee-pr-comment.md")).filter((file) =>
    path.relative(suiteDir, file).startsWith(path.join("results", `${spec}-`))
  );
}

/** The one assessment a spec's test wrote; each checkpoint's own run report sits below it. */
async function readAssessment(suiteDir: string, spec: string) {
  const comments = await assessmentComments(suiteDir, spec);
  expect(comments).toHaveLength(1);
  return JSON.parse(
    await readFile(path.join(path.dirname(comments[0]!), "aee-report.json"), "utf8")
  ) as {
    profile: string;
    verdict: string;
    actions: Array<{ driver: string; actionId: string }>;
    synthesis: {
      status: Array<{ id: string; result: string }>;
      findings: Array<{
        ruleId: string;
        checkpoints: Array<{ actionId: string }>;
        instances: Array<{ selector: string; detail?: string }>;
      }>;
      undecidedContrast: Array<{ selector: string; reason: string }>;
    };
  };
}

async function findFiles(directory: string, basename: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === basename)
    .map((entry) => path.join(entry.parentPath, entry.name));
}
