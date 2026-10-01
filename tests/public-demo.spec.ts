import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { parsePlan } from "../scripts/master-plan.mjs";

const demoUrl = pathToFileURL(path.resolve("site/index.html")).href;
const howUrl = pathToFileURL(path.resolve("site/how-it-works.html")).href;

interface Chapter {
  id: string;
  step: string;
  title: string;
}

interface Feature {
  id: string;
  chapter: string;
  title: string;
  video?: { file: string; captions?: string; text: string };
}

async function readFeatureList() {
  return JSON.parse(await readFile("site/features.json", "utf8")) as {
    tryLinks: Record<string, { href: string }>;
    internalMilestones: Record<string, string>;
    chapters: Chapter[];
    features: Feature[];
  };
}

test("the homepage tells one story, from the problem to the fix", async ({ page }) => {
  const { chapters, features } = await readFeatureList();
  await page.goto(demoUrl);

  await expect(page).toHaveTitle("Accessibility Evidence Engine");
  await expect(
    page.getByRole("heading", {
      level: 1,
      name: "Find the accessibility problems your tests walk past."
    })
  ).toBeVisible();
  await expect(page.getByText(/not a complete WCAG scanner/i)).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Primary navigation" })).toBeAttached();
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeAttached();

  // The map at the top names the chapters in the order the page tells them.
  await expect(
    page
      .getByRole("navigation", { name: "From problem to fix" })
      .getByRole("list")
      .getByRole("link")
  ).toHaveText(chapters.map(({ step, title }) => `${step}: ${title}`));
  await expect(page.locator("#story > section h2")).toHaveText(chapters.map(({ title }) => title));
  // Each chapter holds its own feature cards, in the order site/features.json lists them.
  for (const { id, title } of chapters) {
    await expect(
      page.getByRole("region", { name: title }).getByRole("heading", { level: 3 })
    ).toHaveText(features.filter(({ chapter }) => chapter === id).map((feature) => feature.title));
  }
});

test("what's next has a card for every milestone not yet done, and goes once all are", async ({
  page
}) => {
  const { internalMilestones } = await readFeatureList();
  const milestones = parsePlan(await readFile("docs/MASTER-PLAN.md", "utf8"));
  const upcoming = milestones.filter(
    ({ id, steps }) => !Object.hasOwn(internalMilestones, id) && steps.some(({ done }) => !done)
  );
  await page.goto(demoUrl);

  await expect(page.getByRole("region", { name: "Coming to AEE" })).toHaveCount(
    upcoming.length > 0 ? 1 : 0
  );
  // Work under way keeps its card; a finished milestone and housekeeping never get one.
  for (const { id, steps } of milestones) {
    const label = page.getByText(new RegExp(`· ${id}$`));
    if (upcoming.some((milestone) => milestone.id === id)) {
      await expect(label).toHaveText(
        `${steps.some(({ done }) => done) ? "In progress" : "Coming soon"} · ${id}`
      );
    } else {
      await expect(label).toHaveCount(0);
    }
  }
});

test("every claim on the homepage links to a shot or a live page that exists", async ({ page }) => {
  const { tryLinks, features } = await readFeatureList();
  // Publishing builds the roadmap and the test lab from the plan and the lab contract.
  for (const script of ["generate-roadmap.mjs", "generate-test-lab.mjs"]) {
    execFileSync(process.execPath, [path.join("scripts", script)]);
  }
  // It also makes the shots, and `npm run site:shots` fails when one the feature list names is
  // missing, so a shot link is sound when the feature list names it.
  const shots = new Set([
    ...Object.values(tryLinks).map(({ href }) => href),
    ...features.flatMap(({ id, video }) =>
      (video ? [video.file, video.text, video.captions ?? []].flat() : [`${id}.png`]).map(
        (file) => `shots/${file}`
      )
    )
  ]);
  await page.goto(demoUrl);

  for (const part of await page.locator("main section").all()) {
    await expect(part.locator("a[href]").first(), await part.innerText()).toBeAttached();
  }
  for (const card of await page.locator("#story .feature-card").all()) {
    await expect(card.locator(".feature-links a")).toHaveCount(2);
  }
  const hrefs = await page
    .locator("a[href]")
    .evaluateAll((links) => links.map((link) => link.getAttribute("href")!));
  for (const href of new Set(hrefs)) {
    if (href.startsWith("#")) {
      await expect(page.locator(href), href).toHaveCount(1);
    } else if (href.startsWith("https://")) {
      expect(href).toMatch(/^https:\/\/github\.com\/Elizabeth1979\//);
    } else if (href.startsWith("shots/")) {
      expect(shots.has(href), href).toBe(true);
    } else {
      const [file, fragment] = href.split("#");
      const html = await readFile(path.join("site", file!), "utf8");
      if (fragment) expect(html, href).toContain(`id="${fragment}"`);
    }
  }
});

for (const viewport of [
  { name: "desktop", width: 1280, height: 900 },
  { name: "phone", width: 390, height: 844 }
]) {
  test(`the homepage passes axe and works by keyboard on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(demoUrl);

    const results = await new AxeBuilder({ page }).analyze();
    expect(results.violations.map(({ id }) => id)).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true
    );

    // Tab reaches every link and video in the order they appear, each with a visible focus ring.
    // A video's own controls are several stops in a row; they count as that one video, and the
    // browser rings each of them itself, inside the video, where page styles cannot reach.
    const focusable = page.locator("a[href], video");
    const expected = await focusable.evaluateAll((elements) =>
      elements.map((element) => element.outerHTML)
    );
    const reached: string[] = [];
    for (let stops = 0; reached.length < expected.length && stops < 200; stops += 1) {
      await page.keyboard.press("Tab");
      const focused = await page.evaluate(() => {
        const active = document.activeElement!;
        const style = getComputedStyle(active);
        return {
          html: active.outerHTML,
          visible: style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0
        };
      });
      if (reached.at(-1) === focused.html) continue;
      expect(focused.visible, focused.html).toBe(true);
      reached.push(focused.html);
    }
    expect(reached).toEqual(expected);
  });
}

test("the How it works page has no axe violations or prohibited ARIA attributes", async ({
  page
}) => {
  await page.goto(howUrl);

  const results = await new AxeBuilder({ page }).analyze();
  const seriousViolations = results.violations.filter(({ impact }) =>
    ["serious", "critical"].includes(impact ?? "")
  );
  const prohibitedAria = [...results.violations, ...results.incomplete].filter(
    ({ id }) => id === "aria-prohibited-attr"
  );

  expect(seriousViolations).toEqual([]);
  expect(prohibitedAria).toEqual([]);
});

test("evidence flow renders a branching graph with a text equivalent", async ({ page }) => {
  await page.goto(howUrl);

  const graph = page.getByRole("img", { name: /flowchart of the AEE architecture/i });
  await expect(graph).toBeVisible();
  await expect(graph).toHaveAttribute("src", "diagrams/aee-evidence-pipeline.svg");
  await expect(graph).toHaveJSProperty("complete", true);
  await expect(page.locator(".workflow-stage")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open the graph full size" })).toHaveAttribute(
    "href",
    "diagrams/aee-evidence-pipeline.svg"
  );

  await page.getByText("Read the graph as six text steps").click();
  await expect(page.getByText(/run pointer, keyboard, virtual-reader/i)).toBeVisible();
  await expect(page.getByText(/run deterministic rules first/i)).toBeVisible();
  await expect(
    page.getByRole("link", { name: /artifact contract and Mermaid source/i })
  ).toHaveAttribute("href", /docs\/evidence-run-layout\.md$/);
});

test("generated remediation table stays readable and identifies AI boundaries", async ({
  page
}) => {
  await page.goto(howUrl);

  const registry = page.getByRole("region", { name: "Remediation registry table" });
  await expect(registry.getByRole("table")).toBeVisible();
  await expect(registry.getByRole("row")).toHaveCount(9);
  await expect(registry.getByText("Missing or unsuitable accessible name")).toBeVisible();
  await expect(registry.getByText("Status messages are announced")).toBeVisible();
  await expect(registry.getByText("Text and component color contrast")).toBeVisible();
  await expect(registry.getByText("AI-assisted", { exact: true })).toHaveCount(4);
  await expect(page.getByRole("link", { name: "JSON registry" })).toHaveAttribute(
    "href",
    "data/remediation-registry.json"
  );
});

test("slideshow shows only one focused before-and-after example", async ({ page }) => {
  await page.goto(howUrl);

  await expect(
    page.getByRole("heading", { name: "One issue. One before. One after." })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Give an icon-only button a useful name" })
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Make the semantic outline match the visual structure" })
  ).toBeHidden();
  await expect(page.locator("#examples video")).toHaveCount(0);
  await expect(page.locator(".issue-fix-summary, .evidence-grid")).toHaveCount(0);

  await page.getByRole("button", { name: "Headings", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Give an icon-only button a useful name" })
  ).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Make the semantic outline match the visual structure" })
  ).toBeVisible();
  await expect(page.locator("#slideshow-status")).toHaveText("Example 2 of 6: Headings");
});

test("slideshow supports buttons and arrow-key navigation", async ({ page }) => {
  await page.goto(howUrl);

  const next = page.getByRole("button", { name: "Show next example" });
  await next.click();
  await next.click();
  await expect(
    page.getByRole("heading", { name: "Move focus into an opened modal" })
  ).toBeVisible();

  const animationPicker = page.getByRole("button", { name: "Animation", exact: true });
  await animationPicker.click();
  await animationPicker.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("heading", { name: "Give an icon-only button a useful name" })
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Icon label", exact: true })).toBeFocused();

  await page.getByRole("button", { name: "Show previous example" }).click();
  await expect(
    page.getByRole("heading", { name: "Verify that a Pause control really stops animation" })
  ).toBeVisible();
});

test("slideshow images and generated evidence agree", async ({ page }) => {
  await page.goto(howUrl);

  const [
    axeUnnamed,
    axeNamed,
    axeHeading,
    aiLabel,
    aiHeading,
    issueReport,
    fixedReport,
    paletteEvidence,
    hoverEvidence,
    motionEvidence
  ] = await Promise.all(
    [
      "axe-unnamed-icon.json",
      "axe-named-icon.json",
      "axe-heading-structure.json",
      "ai-label-suggestion.json",
      "ai-heading-suggestion.json",
      "recorded-modal-focus-issue/aee-report.json",
      "recorded-modal-focus-fixed/aee-report.json",
      "palette-contrast/evidence.json",
      "hover-keyboard/evidence.json",
      "motion-control/evidence.json"
    ].map(async (fileName) =>
      JSON.parse(await readFile(path.resolve(`site/demo-artifacts/${fileName}`), "utf8"))
    )
  );

  expect(axeUnnamed.violations.some((violation) => violation.id === "button-name")).toBe(true);
  expect(axeNamed.violations).toEqual([]);
  expect(aiLabel.routing.route).toBe("ai-review");
  expect(aiLabel.proposal.patches).toContain(
    '#delete-project: add aria-label="Delete Project Alpha"'
  );
  expect(axeHeading.violations).toEqual([]);
  expect(aiHeading.routing.route).toBe("ai-review");
  expect(aiHeading.proposal.after).toContain("  h2 Settings");
  expect(issueReport.run.results).toEqual({ pass: 1, fail: 2, unknown: 0 });
  expect(fixedReport.run.results).toEqual({ pass: 3, fail: 0, unknown: 0 });
  expect(paletteEvidence.currentRatio).toBeLessThan(4.5);
  expect(paletteEvidence.selectedRatio).toBeGreaterThanOrEqual(4.5);
  expect(paletteEvidence.selected.name).toBe("Text subtle");
  expect(hoverEvidence.before.verdict).toBe("fail");
  expect(hoverEvidence.after.verdict).toBe("pass");
  expect(motionEvidence.before.verdict).toBe("fail");
  expect(motionEvidence.after.verdict).toBe("pass");

  for (const image of await page.locator(".before-after img").all()) {
    await expect(image).toHaveAttribute("alt", /.+/);
    await expect(image).toHaveJSProperty("complete", true);
  }
});

test("evidence is readable in place and raw artifacts are downloads", async ({ page }) => {
  await page.goto(howUrl);

  await page.getByText("Read the evidence behind these examples").click();

  await expect(page.getByRole("heading", { name: "Icon label" })).toBeVisible();
  await expect(page.getByText('aria-label="Delete Project Alpha"')).toBeVisible();
  await expect(page.getByRole("heading", { name: "Heading hierarchy" })).toBeVisible();
  await expect(
    page.getByText(/missing relationship, not an invalid heading sequence/i)
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Modal focus" })).toBeVisible();
  await expect(page.getByText(/focused element is still its trigger/i)).toBeVisible();

  const rawLinks = page.locator(".raw-downloads a");
  await expect(rawLinks).toHaveCount(10);
  for (const link of await rawLinks.all()) {
    await expect(link).toHaveAttribute("download", "");
  }
});
