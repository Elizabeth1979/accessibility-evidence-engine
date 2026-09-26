// Builds site/roadmap.html from docs/MASTER-PLAN.md so the public roadmap can never drift
// from the plan. Runs at deploy time (pages.yml); the output is not committed.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const planPath = path.join(root, "docs", "MASTER-PLAN.md");
const outPath = path.join(root, "site", "roadmap.html");
const planUrl =
  "https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/main/docs/MASTER-PLAN.md";

const milestones = parsePlan(await readFile(planPath, "utf8"));
if (milestones.length === 0) throw new Error("No milestones found in docs/MASTER-PLAN.md");

const current = milestones.find((m) => m.steps.some((s) => !s.done));
const allSteps = milestones.flatMap((m) => m.steps);
const doneCount = allSteps.filter((s) => s.done).length;

await writeFile(outPath, renderPage());
process.stdout.write(`Generated roadmap: ${doneCount}/${allSteps.length} steps done.\n`);

export function parsePlan(markdown) {
  const result = [];
  for (const line of markdown.split("\n")) {
    const heading = line.match(/^### (M\d+) — (.+?)(?: \((.+)\))?$/);
    if (heading) {
      result.push({
        id: heading[1],
        title: heading[2],
        when: heading[3] ?? "",
        outcome: "",
        steps: []
      });
      continue;
    }
    const outcome = line.match(/^\*\*Outcome:\*\* (.+)$/);
    if (outcome && result.length > 0) {
      result.at(-1).outcome = outcome[1];
      continue;
    }
    const step = line.match(/^- \[( |x)\] \*\*(\d+\.\d+)\*\* (.+)$/);
    if (step && result.length > 0) {
      const [text, doneWhen = ""] = step[3].split(" _Done when:_ ");
      result.at(-1).steps.push({ id: step[2], done: step[1] === "x", text, doneWhen });
    }
  }
  return result;
}

function renderPage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Roadmap · AEE</title>
    <link rel="stylesheet" href="styles.css" />
    <link rel="stylesheet" href="roadmap.css" />
  </head>
  <body>
    <a class="skip-link" href="#main">Skip to content</a>
    <header class="site-header"><a href="index.html">Accessibility Evidence Engine</a></header>
    <main id="main" class="roadmap">
      <h1>Roadmap</h1>
      <p class="lede">${doneCount} of ${allSteps.length} steps done.${
        current ? ` Now: <strong>${current.id} — ${inline(current.title)}</strong>.` : ""
      }</p>
      <p>
        <label for="progress">Progress</label>
        <progress id="progress" max="${allSteps.length}" value="${doneCount}" aria-valuetext="${doneCount} of ${allSteps.length} steps done">${doneCount} of ${allSteps.length}</progress>
      </p>
      <nav class="glance" aria-label="Milestones at a glance">
        <ol class="overview">
${milestones.map(renderStation).join("\n")}
        </ol>
      </nav>
      <p>Generated from <a href="${planUrl}">the master plan</a> on every deploy. Open a milestone to see its steps.</p>
      <ol class="track">
${milestones.map(renderMilestone).join("\n")}
      </ol>
    </main>
  </body>
</html>
`;
}

function stateOf(m) {
  if (m.steps.every((s) => s.done)) return "done";
  return m === current ? "now" : "todo";
}

function renderStation(m) {
  const state = stateOf(m);
  const status = { done: "done", now: "you are here", todo: "to do" }[state];
  return `          <li class="station ${state}">
            <a href="#${m.id.toLowerCase()}"${state === "now" ? ' aria-current="step"' : ""}>
              <span class="m-id">${m.id}</span>
              <span class="s-title">${inline(m.title)}</span>
              <span class="visually-hidden">, ${status}</span>
            </a>
          </li>`;
}

function renderMilestone(m) {
  const done = m.steps.filter((s) => s.done).length;
  const state = stateOf(m);
  const label = { done: "Done", now: "You are here", todo: "" }[state];
  return `        <li class="milestone ${state}" id="${m.id.toLowerCase()}">
          <details${state === "now" ? " open" : ""}>
            <summary>
              <span class="m-id">${m.id}</span>
              <span class="m-title">${inline(m.title)}</span>
              ${label ? `<span class="m-tag">${label}</span>` : ""}
              <span class="m-count"><span aria-hidden="true">${done}/${m.steps.length}</span><span class="visually-hidden">${done} of ${m.steps.length} steps done</span></span>
              ${m.outcome ? `<span class="m-outcome">${inline(m.outcome)}</span>` : ""}
            </summary>
            ${m.when ? `<p class="m-when">${inline(m.when)}</p>` : ""}
            <ul class="steps">
${m.steps.map(renderStep).join("\n")}
            </ul>
          </details>
        </li>`;
}

function renderStep(s) {
  return `              <li class="${s.done ? "step-done" : "step-todo"}">
                <span class="step-id"><span class="visually-hidden">${s.done ? "Done:" : "To do:"} </span>${s.id}</span>
                <div>
                  <p>${inline(s.text)}</p>
                  ${s.doneWhen ? `<p class="done-when"><strong>Done when:</strong> ${inline(s.doneWhen)}</p>` : ""}
                </div>
              </li>`;
}

function inline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|\s)_([^_]+)_(?=\s|[.,;:]|$)/g, "$1<em>$2</em>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2">$1</a>');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
