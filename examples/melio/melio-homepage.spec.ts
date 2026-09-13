import { expect, test } from "@playwright/test";
import { runAeeOnPage } from "@aee/playwright";

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
    observers: ["focus", "dom", "accessibility-tree", "visual"],
    judges: ["keyboard", "release"],
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
