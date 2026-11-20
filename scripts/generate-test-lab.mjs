// Builds site/test-lab.html from site/test-lab-contract.json, the same file the lab tests read,
// so the page can never promise more than the tests check. Runs at deploy time (pages.yml),
// after the build, and refuses a contract that does not match its schema; the output is not
// committed.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { escapeHtml, renderSitePage } from "./site-page.mjs";
import { issuePageUrl, loadTestLabContract } from "./test-lab-contract.mjs";

const root = process.cwd();
const contract = loadTestLabContract();
const { pages, issuePage, issues } = contract;

await writeFile(
  path.join(root, "site", "test-lab.html"),
  renderSitePage({
    title: "Test lab",
    stylesheets: ["test-lab.css"],
    mainClass: "lab",
    body: `      <h1>Test lab</h1>
      <p class="lede">
        A practice page with known accessibility issues, the same page fixed, and each issue on a
        page of its own.
      </p>
      <p>
        On every change, the engine is run against these pages. It must find every issue on the
        first page, each issue alone on its own page, and nothing on the fixed page. The data is
        fictional, and reloading a page resets it.
      </p>
      <ul class="lab-pages">
${[...Object.values(pages), { ...issuePage, url: "#issues-heading" }].map(renderPageLink).join("\n")}
      </ul>
      <h2 id="issues-heading">The issues on the demo page</h2>
      <div class="registry-table-wrap" tabindex="0" role="region" aria-labelledby="issues-heading">
        <table class="registry-table">
          <caption>
            Each issue, who it affects, how the engine checks for it, and whether it finds it today
          </caption>
          <thead>
            <tr>
              <th scope="col">Issue</th>
              <th scope="col">Who it affects</th>
              <th scope="col">How the engine checks</th>
              <th scope="col">Found today?</th>
            </tr>
          </thead>
          <tbody>
${issues.map(renderIssue).join("\n")}
          </tbody>
        </table>
      </div>`
  })
);
const found = issues.filter(isFoundToday).length;
process.stdout.write(`Generated test lab: ${found} of ${issues.length} issues found today.\n`);

// The lab tests prove each of these: axe rules on the demo page, sweep findings from the
// keyboard and pointer sweep.
function isFoundToday(issue) {
  return Boolean(issue.axeRule || issue.sweepFinding);
}

function renderPageLink(page) {
  return `        <li>
          <a href="${escapeHtml(page.url)}">${escapeHtml(page.title)}</a>
          <p>${escapeHtml(page.summary)}</p>
        </li>`;
}

function renderIssue(issue) {
  const status = isFoundToday(issue)
    ? `<span class="registry-status available">Yes</span>`
    : `<span class="registry-status planned">Not yet</span> Planned in ${escapeHtml(issue.plannedStep)}`;
  return `            <tr id="issue-${escapeHtml(issue.id)}">
              <th scope="row">
                <a href="${escapeHtml(issuePageUrl(contract, issue))}">${escapeHtml(issue.title)}</a>
              </th>
              <td>${escapeHtml(issue.whoItHurts)}</td>
              <td>${escapeHtml(issue.check)}</td>
              <td>${status}</td>
            </tr>`;
}
