// Builds the homepage's feature cards from site/features.json, and its "what's next" cards from
// the master-plan milestones that still have open steps. The cards are committed in site/index.html;
// `npm run site:check` fails when they drift from either file, so a step that changes a feature
// or the plan updates its card in the same PR. The shots they show come from `npm run site:shots`.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import prettier from "prettier";

import { parsePlan } from "./master-plan.mjs";
import { escapeHtml, inline, replaceBetweenMarkers } from "./site-page.mjs";

const root = process.cwd();
const htmlPath = path.join(root, "site", "index.html");
const { tryLinks, internalMilestones, features } = JSON.parse(
  await readFile(path.join(root, "site", "features.json"), "utf8")
);
// A milestone keeps its card until every step is done, so work under way never drops off the page.
const upcoming = parsePlan(
  await readFile(path.join(root, "docs", "MASTER-PLAN.md"), "utf8")
).filter(
  ({ id, steps }) => !Object.hasOwn(internalMilestones, id) && steps.some(({ done }) => !done)
);

const currentHtml = await readFile(htmlPath, "utf8");
const prettierConfig = (await prettier.resolveConfig(htmlPath)) ?? {};
const expectedHtml = await prettier.format(
  replaceBetweenMarkers(currentHtml, "features", renderCards()),
  { ...prettierConfig, parser: "html" }
);
const summary = `${features.length} feature cards and ${upcoming.length} upcoming milestone cards`;

if (process.argv.includes("--check")) {
  if (currentHtml !== expectedHtml) {
    throw new Error("The homepage feature cards are stale: run npm run site:generate.");
  }
  process.stdout.write(`Verified ${summary}.\n`);
} else {
  await writeFile(htmlPath, expectedHtml);
  process.stdout.write(`Generated ${summary}.\n`);
}

function renderCards() {
  return `<ul class="feature-grid">
${features.map(renderFeature).join("\n")}
</ul>
<h3 class="coming-soon-title">What's next</h3>
<ul class="feature-grid">
${upcoming.map(renderMilestone).join("\n")}
</ul>`;
}

function renderFeature({ id, title, caption, alt, try: tryId, video }) {
  const tryLink = tryLinks[tryId];
  const media = video
    ? `<video controls preload="metadata" aria-labelledby="feature-${escapeHtml(id)}"><source src="shots/${escapeHtml(video.file)}" type="video/webm" />${
        video.captions
          ? `<track kind="captions" src="shots/${escapeHtml(video.captions)}" srclang="en" label="Steps" default />`
          : ""
      }</video>`
    : `<img src="shots/${escapeHtml(id)}.png" alt="${escapeHtml(alt)}" loading="lazy" />`;
  // A shot is a crop of a wide report, so the card also links to it at full size.
  const mediaLink = video
    ? `<a href="shots/${escapeHtml(video.text)}">${escapeHtml(video.textLabel)}</a>`
    : `<a href="shots/${escapeHtml(id)}.png">Open the shot full size</a>`;
  return `<li class="feature-card">
  <h3 id="feature-${escapeHtml(id)}">${escapeHtml(title)}</h3>
  ${media}
  <p>${escapeHtml(caption)}</p>
  <p class="feature-links">${mediaLink}<a href="${escapeHtml(tryLink.href)}">${escapeHtml(tryLink.label)}</a></p>
</li>`;
}

function renderMilestone({ id, title, outcome, steps }) {
  const state = steps.some(({ done }) => done) ? "In progress" : "Coming soon";
  return `<li class="feature-card coming-soon">
  <p class="coming-soon-label">${state} · ${escapeHtml(id)}</p>
  <h4>${inline(title)}</h4>
  <p>${inline(outcome)}</p>
</li>`;
}
