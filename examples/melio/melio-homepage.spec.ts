import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";
import { createPortableVirtualScreenReader, runAeeOnPage } from "@aee/playwright";

test("Melio homepage moves focus forward from Sign in", async ({ page }) => {
  await page.goto("https://melio.com/", {
    waitUntil: "domcontentloaded"
  });

  const signIn = page.getByRole("link", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible();
  await signIn.focus();

  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: "aee-output",
    checkpointName: "melio-homepage-sign-in",
    observers: ["focus", "dom", "accessibility-tree", "visual", "axe"],
    judges: ["keyboard", "axe", "release"],
    interaction: {
      kind: "tab",
      actor: "test",
      target: {
        role: "link",
        name: "Sign in"
      }
    },
    async performInteraction({ page }) {
      await page.keyboard.press("Tab");
    }
  });

  await expect(page.getByRole("link", { name: "Start now", exact: true }).first()).toBeFocused();
  console.log("AEE reports:", result.reporterFiles);
});

test("Melio homepage supports an isolated portable virtual-reader heading command", async ({
  page
}) => {
  await page.goto("https://melio.com/", {
    waitUntil: "domcontentloaded"
  });

  const reader = createPortableVirtualScreenReader(page);
  const result = await runAeeOnPage({
    page,
    projectRoot: process.cwd(),
    outputDir: "aee-output",
    virtualScreenReader: reader,
    checkpointName: "melio-homepage-virtual-reader-heading",
    observers: ["focus", "dom", "accessibility-tree", "visual", "axe", "virtual-screen-reader"],
    judges: ["screen-reader", "axe", "release"],
    interaction: {
      kind: "screen-reader-command",
      input: "next-heading",
      actor: "test"
    },
    async performInteraction() {
      await reader.command("next-heading");
    }
  });

  const transcriptPath = result.artifactFiles.find((filePath) =>
    filePath.endsWith("virtual-screen-reader-transcript-json-after.json")
  );
  expect(transcriptPath).toBeTruthy();
  const transcript = JSON.parse(await readFile(transcriptPath!, "utf8"));
  expect(transcript.entries).toEqual([
    expect.objectContaining({
      command: "next-heading",
      focusMoved: false,
      item: expect.objectContaining({ role: "heading" })
    })
  ]);
  console.log("AEE virtual-reader reports:", result.reporterFiles);
});
