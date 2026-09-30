// Builds the homepage's story from site/features.json: the map of its chapters at the top, each
// chapter with its feature cards, and a "what's next" section of the master-plan milestones that
// still have open steps. The cards are committed in site/index.html; `npm run site:check` fails
// when they drift from either file, so a step that changes a feature or the plan updates its card
// in the same PR. The shots they show come from `npm run site:shots`.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import prettier from "prettier";

import { parsePlan } from "./master-plan.mjs";
import { escapeHtml, inline, replaceBetweenMarkers } from "./site-page.mjs";

const root = process.cwd();
const htmlPath = path.join(root, "site", "index.html");
const { tryLinks, internalMilestones, chapters, features } = JSON.parse(
  await readFile(path.join(root, "site", "features.json"), "utf8")
);
for (const { id, chapter } of features) {
  if (!chapters.some((candidate) => candidate.id === chapter)) {
    throw new Error(`Feature ${id} names chapter "${chapter}", which site/features.json lacks.`);
  }
}
// A milestone keeps its card until every step is done, so work under way never drops off the page.
const upcoming = parsePlan(
  await readFile(path.join(root, "docs", "MASTER-PLAN.md"), "utf8")
).filter(
  ({ id, steps }) => !Object.hasOwn(internalMilestones, id) && steps.some(({ done }) => !done)
);

const currentHtml = await readFile(htmlPath, "utf8");
const prettierConfig = (await prettier.resolveConfig(htmlPath)) ?? {};
const expectedHtml = await prettier.format(
  [
    ["story-map", renderStoryMap()],
    ["features", chapters.map(renderChapter).join("\n")],
    ["upcoming", renderUpcoming()]
  ].reduce(
    (html, [name, replacement]) => replaceBetweenMarkers(html, name, replacement),
    currentHtml
  ),
  { ...prettierConfig, parser: "html" }
);
const summary = `${chapters.length} chapters of ${features.length} feature cards and ${upcoming.length} upcoming milestone cards`;

if (process.argv.includes("--check")) {
  if (currentHtml !== expectedHtml) {
    throw new Error("The homepage story is stale: run npm run site:generate.");
  }
  process.stdout.write(`Verified ${summary}.\n`);
} else {
  await writeFile(htmlPath, expectedHtml);
  process.stdout.write(`Generated ${summary}.\n`);
}

function renderStoryMap() {
  return `<ol>
${chapters
  .map(
    ({ id, step, title }) =>
      `<li><a href="#${escapeHtml(id)}"><strong>${escapeHtml(step)}:</strong> ${escapeHtml(title)}</a></li>`
  )
  .join("\n")}
</ol>`;
}

function renderChapter({ id, step, title, intro }, index) {
  return `<section class="section chapter" id="${escapeHtml(id)}" aria-labelledby="${escapeHtml(id)}-title">
  <div class="section-heading">
    <div>
      <p class="eyebrow">Step ${index + 1} · ${escapeHtml(step)}</p>
      <h2 id="${escapeHtml(id)}-title">${escapeHtml(title)}</h2>
    </div>
    <p>${escapeHtml(intro)}</p>
  </div>
  <ul class="feature-grid">
${features
  .filter(({ chapter }) => chapter === id)
  .map(renderFeature)
  .join("\n")}
  </ul>
</section>`;
}

function renderFeature({ id, title, caption, alt, try: tryId, video }) {
  const tryLink = tryLinks[tryId];
  const media = video
    ? `<video controls preload="metadata" aria-labelledby="feature-${escapeHtml(id)}"><source src="shots/${escapeHtml(video.file)}" type="video/webm" />${
        video.captions
          ? `<track kind="captions" src="shots/${escapeHtml(video.captions)}" srclang="en" label="Steps" default />`
          : ""
      }</video>`
    : `<img src="shots/${escapeHtml(id)}.png" alt="${escapeHtml(alt)}" />`;
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

// Once every milestone is done there is nothing to announce, so the section goes too.
function renderUpcoming() {
  if (upcoming.length === 0) return "";
  return `<section class="section" id="next" aria-labelledby="next-title">
  <div class="section-heading">
    <div>
      <p class="eyebrow">What's next</p>
      <h2 id="next-title">Coming to AEE</h2>
    </div>
    <p>Each card is a milestone of the plan that still has steps open. <a href="roadmap.html">See the whole roadmap</a></p>
  </div>
  <ul class="feature-grid">
${upcoming.map(renderMilestone).join("\n")}
  </ul>
</section>`;
}

function renderMilestone({ id, title, outcome, steps }) {
  const state = steps.some(({ done }) => done) ? "In progress" : "Coming soon";
  return `<li class="feature-card coming-soon">
  <p class="coming-soon-label">${state} · ${escapeHtml(id)}</p>
  <h3>${inline(title)}</h3>
  <p>${inline(outcome)}</p>
</li>`;
}
