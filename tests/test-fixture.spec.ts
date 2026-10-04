import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test, type TestInfo } from "@playwright/test";

import { serveDirectory, startHtmlServer } from "./scenario-helpers";

test("an existing spec with only its import swapped produces findings", async () => {
  const testInfo = test.info();
  test.setTimeout(120_000);
  const original = await readFile("examples/playwright-fixture/existing.spec.ts", "utf8");
  const swapped = original.replace(
    'import { expect, test } from "@playwright/test";',
    'import { expect, test } from "@aee/cli/test";'
  );
  expect(swapped).not.toBe(original);
  const { suiteDir, stdout } = await runSuite(testInfo, {
    existing: swapped,
    // A state no page load reaches is checked only when the test names it.
    dialog: DIALOG_SPEC,
    // A test that takes the page but never loads one leaves nothing to check.
    blank: BLANK_SPEC,
    gradients: GRADIENTS_SPEC,
    late: LATE_SPEC,
    shop: SHOP_SPEC
  });

  const existing = await readAssessment(suiteDir, "existing");
  expect(existing.profile).toBe("playwright-test");
  // The test still passes, so the terminal says where its accessibility verdict is.
  const reportLine = /^AEE: release blocked, \d+ fixes needed\. Report: (\S+)$/m.exec(stdout);
  expect(reportLine?.[1]).toMatch(/existing-.*\/aee\/aee-report\.html$/);
  await expect(readFile(reportLine![1]!, "utf8")).resolves.toContain("<h1>");
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

  // A checkpoint does nothing to the page, so it captures it once: there is no "before".
  expect(existing.artifacts.filter(({ path: file }) => /-before\./.test(file))).toEqual([]);
  // It captures the page once the app has drawn it: an image the app draws when its data arrives,
  // a second after the load, is seen by the load's own checkpoint, though the test moves on to
  // another page straight away.
  const late = await readAssessment(suiteDir, "late");
  expect(
    late.synthesis.findings.map(({ ruleId, checkpoints }) => [
      ruleId,
      checkpoints.map(({ actionId }) => actionId)
    ])
  ).toEqual([["image-alt", ["checkpoint-1-after-setcontent"]]]);
  // The report is called what the test is called, apostrophe and all.
  expect(late.name).toBe("a gallery the app draws after it's loaded");
  const [lateComment] = await assessmentComments(suiteDir, "late");
  await expect(
    readFile(path.join(path.dirname(lateComment!), "aee-report.html"), "utf8")
  ).resolves.toContain("<h1>a gallery the app draws after it&#39;s loaded</h1>");
  // An image with no text or id is called by what it is and its file, or counted when it has none.
  expect(late.synthesis.findings[0]?.instances.map(({ label }) => label)).toEqual([
    "Image fern.jpg"
  ]);
  expect(dialog.synthesis.findings[0]?.instances.map(({ label }) => label)).toEqual(["Image 1"]);

  // A file: page is not on the web, so it is checked with axe alone, and its rows say so.
  expect(existing.completeness.plannedChecks.skipped).toBe("no-web-page");
  expect(existing.synthesis.status.map(({ id, result }) => [id, result]).slice(0, 2)).toEqual([
    ["keyboard", "Not in this run"],
    ["reader", "Not in this run"]
  ]);

  // Where a passing test ends on a page, the page is swept by keyboard and mouse and read with the
  // virtual screen reader on the test's own page: the shop exists only through the test's route, so
  // a page of AEE's own could not load it.
  const shop = await readAssessment(suiteDir, "shop", "the shop sells one plant");
  expect(shop.synthesis.status.map(({ id, result }) => [id, result]).slice(0, 2)).toEqual([
    ["keyboard", "Fix required"],
    ["reader", "Fix required"]
  ]);
  expect(shop.synthesis.findings.map(({ ruleId }) => ruleId)).toEqual(
    expect.arrayContaining(["pointer-only", "button-name"])
  );
  const [shopComment] = await assessmentComments(suiteDir, "shop", "the shop sells one plant");
  const sweep = JSON.parse(
    await readFile(
      path.join(
        path.dirname(shopComment!),
        "test-keyboard-pointer-sweep",
        "keyboard-pointer-sweep.json"
      ),
      "utf8"
    )
  ) as { isolation: string; tabStops: unknown[] };
  expect(sweep.isolation).toBe("test-page");
  expect(sweep.tabStops.length).toBeGreaterThan(0);
  // The reader reads from the top to the end of the page, so every move lands on something.
  expect(shop.synthesis.reader).toEqual({ commands: 6, passed: 6, failed: 0, unknown: 0 });
  await expect(
    readFile(path.join(path.dirname(shopComment!), "aee-report.html"), "utf8")
  ).resolves.toContain("Read from the top, item by item: 12 items or the end of the page");
  // Its loads are not the test's: only the test's own load and its end are checkpoints.
  expect(
    shop.actions
      .filter(({ driver }) => driver === "playwright-test")
      .map(({ actionId }) => actionId)
  ).toEqual(["checkpoint-1-after-goto", "checkpoint-2-test-end"]);
  // Once per page in a run: another test ending there, with only a query added, is not checked
  // again and says where it was, and a test can turn the checks off.
  for (const [title, skipped, result] of [
    ["the shop sells one plant, seen again", "checked-in-another-test", "Checked in another test"],
    ["the basket, with the checks off", "turned-off", "Not in this run"]
  ] as const) {
    const other = await readAssessment(suiteDir, "shop", title);
    expect(other.completeness.plannedChecks.skipped).toBe(skipped);
    expect(other.synthesis.status.map(({ id, result }) => [id, result]).slice(0, 2)).toEqual([
      ["keyboard", result],
      ["reader", result]
    ]);
  }

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

test("the presses a test makes are watched for what they show and do not say", async () => {
  const testInfo = test.info();
  test.setTimeout(120_000);
  // Over http, as the lab is published: a page opened from a file cannot send a request.
  const server = await startHtmlServer(serveDirectory("site"));
  let suiteDir: string;
  try {
    ({ suiteDir } = await runSuite(testInfo, { lab: LAB_SPEC }, { AEE_LAB: server.origin }));
  } finally {
    await server.close();
  }
  const announcementFindings = async (title: string) =>
    (await readAssessment(suiteDir, "lab", title)).synthesis.findings
      .filter(({ ruleId }) => ruleId.endsWith("-not-announced"))
      .map(({ ruleId, instances }) => [ruleId, instances.map(({ label }) => label)]);

  // The test's own click on Archive shows a message no live region says; on Sync, a request fails
  // and the page shows and says nothing. The fixed page says both, so it gets neither.
  expect(await announcementFindings("archive on the demo page")).toEqual([
    ["status-not-announced", ["Project Alpha archived. You can restore it."]]
  ]);
  expect(await announcementFindings("sync on the demo page")).toEqual([
    ["failure-not-announced", ["Sync settings"]]
  ]);
  expect(await announcementFindings("archive on the fixed page")).toEqual([]);
  expect(await announcementFindings("sync on the fixed page")).toEqual([]);

  // The keyboard sweep is off, so the presses were the test's own, which AEE only watched.
  const archive = await readAssessment(suiteDir, "lab", "archive on the demo page");
  expect(archive.completeness.plannedChecks.skipped).toBe("turned-off");
  const [comment] = await assessmentComments(suiteDir, "lab", "archive on the demo page");
  const lane = JSON.parse(
    await readFile(
      path.join(path.dirname(comment!), "test-observed-presses", "keyboard-pointer-sweep.json"),
      "utf8"
    )
  ) as { pressedBy: string; activateControls: boolean; activated: string[] };
  expect(lane).toMatchObject({
    pressedBy: "test",
    activateControls: false,
    activated: ["#archive-project"]
  });
  await expect(
    readFile(path.join(path.dirname(comment!), "aee-report.html"), "utf8")
  ).resolves.toContain("1 press the test made, watched; AEE pressed nothing");
});

/**
 * The lab's Archive and Sync buttons, each clicked once by the test, which counts every press the
 * page gets, so AEE pressing anything would fail it.
 */
const LAB_SPEC = `import { expect, test } from "@aee/cli/test";

test.use({ aee: { keyboardAndReader: false } });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    for (const type of ["click", "keydown"]) {
      addEventListener(type, (event) => {
        if (event.isTrusted) document.documentElement.dataset.presses = String(Number(document.documentElement.dataset.presses ?? 0) + 1);
      }, true);
    }
  });
});

test.afterEach(async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("data-presses", "1");
});

for (const [name, query] of [["demo", ""], ["fixed", "?case=fixed"]]) {
  const status = (page) => page.locator("#action-status");

  test(\`archive on the \${name} page\`, async ({ page }) => {
    await page.goto(\`\${process.env.AEE_LAB}/test-case.html\${query}\`);
    await page.locator("#archive-project").click();
    await expect(status(page)).toHaveText("Project Alpha archived. You can restore it.");
  });

  test(\`sync on the \${name} page\`, async ({ page }) => {
    await page.goto(\`\${process.env.AEE_LAB}/test-case.html\${query}\`);
    const synced = page.waitForResponse("**/api/sync-settings");
    await page.getByRole("button", { name: "Sync settings" }).click();
    await synced;
    if (query) await expect(status(page)).toHaveText(/could not be synced/);
  });
}
`;

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

const LATE_SPEC = `import { test } from "@aee/cli/test";

test("a gallery the app draws after it's loaded", async ({ page }) => {
  // The gallery's photos arrive a second after the page loads, as from a slow server: far longer
  // than a checkpoint waits for the page to stop changing, so only waiting for the data sees them.
  await page.route("https://photos.test/gallery.json", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    await route.fulfill({ json: ["fern.jpg"], headers: { "access-control-allow-origin": "*" } });
  });
  await page.setContent(\`<!doctype html><html lang="en"><title>Gallery</title><main><h1>Gallery</h1>
    </main><script>fetch("https://photos.test/gallery.json").then((response) => response.json())
      .then((photos) => document.querySelector("main").insertAdjacentHTML("beforeend",
        photos.map((photo) => '<img src="https://photos.test/' + photo + '">').join("")));
    </script></html>\`);
  await page.setContent(\`<!doctype html><html lang="en"><title>Done</title><main><h1>Done</h1></main></html>\`);
});
`;

/**
 * A shop that exists only through the test's own route, with a mouse-only "Buy" and an icon button
 * with no name; its three tests run in order, in one worker.
 */
const SHOP_SPEC = `import { expect, test } from "@aee/cli/test";

const shop = \`<!doctype html><html lang="en"><title>Shop</title><header><h1>Shop</h1></header>
  <main><h2>Fern</h2><div class="buy" style="cursor:pointer" onclick="this.textContent='Added'">Buy</div>
  <button type="button"><svg aria-hidden="true" width="16" height="16"><circle cx="8" cy="8" r="6"/></svg></button>
  <a href="/basket">Basket</a></main></html>\`;

test.beforeEach(async ({ page }) => {
  await page.route("https://shop.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: shop })
  );
});

test("the shop sells one plant", async ({ page }) => {
  await page.goto("https://shop.test/");
  await expect(page.getByRole("heading", { name: "Fern" })).toBeVisible();
});

test("the shop sells one plant, seen again", async ({ page }) => {
  await page.goto("https://shop.test/?from=search");
  await expect(page.getByRole("heading", { name: "Fern" })).toBeVisible();
});

test.describe(() => {
  test.use({ aee: { keyboardAndReader: false } });
  test("the basket, with the checks off", async ({ page }) => {
    await page.goto("https://shop.test/basket");
    await expect(page.getByRole("heading", { name: "Shop" })).toBeVisible();
  });
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

/** Runs specs, by name, as a suite of their own, from the repository root like the originals. */
async function runSuite(
  testInfo: TestInfo,
  specs: Record<string, string>,
  env: Record<string, string> = {}
) {
  const suiteDir = testInfo.outputPath("suite");
  const config = path.join(suiteDir, "playwright.config.js");
  await mkdir(suiteDir, { recursive: true });
  for (const [name, spec] of Object.entries(specs)) {
    await writeFile(path.join(suiteDir, `${name}.spec.ts`), spec, "utf8");
  }
  await writeFile(config, "module.exports = { testDir: __dirname };\n", "utf8");
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      require.resolve("@playwright/test/cli"),
      "test",
      `--config=${config}`,
      `--output=${path.join(suiteDir, "results")}`,
      "--reporter=line"
    ],
    { env: { ...process.env, ...env } }
  );
  return { suiteDir, stdout };
}

/** The assessments a spec's tests wrote, one PR comment each; with a title, that test's only. */
async function assessmentComments(suiteDir: string, spec: string, title?: string) {
  const files = (await findFiles(suiteDir, "aee-pr-comment.md")).filter((file) =>
    path.relative(suiteDir, file).startsWith(path.join("results", `${spec}-`))
  );
  if (!title) return files;
  const named = await Promise.all(
    files.map(async (file) => {
      const report = JSON.parse(
        await readFile(path.join(path.dirname(file), "aee-report.json"), "utf8")
      ) as { name?: string };
      return report.name === title ? file : undefined;
    })
  );
  return named.filter((file) => file !== undefined);
}

/** The one assessment a spec's test wrote; each checkpoint's own run report sits below it. */
async function readAssessment(suiteDir: string, spec: string, title?: string) {
  const comments = await assessmentComments(suiteDir, spec, title);
  expect(comments).toHaveLength(1);
  return JSON.parse(
    await readFile(path.join(path.dirname(comments[0]!), "aee-report.json"), "utf8")
  ) as {
    name?: string;
    profile: string;
    verdict: string;
    completeness: { plannedChecks: { skipped?: string } };
    actions: Array<{ driver: string; actionId: string }>;
    artifacts: Array<{ path: string }>;
    synthesis: {
      status: Array<{ id: string; result: string }>;
      reader: { commands: number; passed: number; failed: number; unknown: number };
      findings: Array<{
        ruleId: string;
        checkpoints: Array<{ actionId: string }>;
        instances: Array<{ selector: string; label: string; detail?: string }>;
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
