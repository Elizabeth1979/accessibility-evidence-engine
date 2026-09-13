import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import prettier from "prettier";

const root = process.cwd();
const registryPath = path.join(root, "rules", "remediation-registry.json");
const schemaPath = path.join(
  root,
  "packages",
  "schemas",
  "json",
  "remediation-registry.schema.json"
);
const siteJsonPath = path.join(root, "site", "data", "remediation-registry.json");
const siteSchemaPath = path.join(root, "site", "data", "remediation-registry.schema.json");
const siteHtmlPath = path.join(root, "site", "index.html");
const startMarker = "<!-- remediation-registry:start -->";
const endMarker = "<!-- remediation-registry:end -->";

const registryText = await readFile(registryPath, "utf8");
const schemaText = await readFile(schemaPath, "utf8");
const registry = JSON.parse(registryText);
const rows = registry.entries.map(renderEntry).join("\n");
const currentHtml = await readFile(siteHtmlPath, "utf8");
const prettierConfig = (await prettier.resolveConfig(siteHtmlPath)) ?? {};
const expectedHtml = await prettier.format(replaceBetweenMarkers(currentHtml, rows), {
  ...prettierConfig,
  parser: "html"
});
const publicRegistry = {
  ...registry,
  $schema: "./remediation-registry.schema.json"
};
const expectedJson = await prettier.format(JSON.stringify(publicRegistry), {
  ...prettierConfig,
  parser: "json"
});
const expectedSchema = await prettier.format(schemaText, {
  ...prettierConfig,
  parser: "json"
});
const checkOnly = process.argv.includes("--check");

if (checkOnly) {
  const currentJson = await readFile(siteJsonPath, "utf8").catch(() => "");
  const currentSchema = await readFile(siteSchemaPath, "utf8").catch(() => "");
  const drift = [];

  if (currentHtml !== expectedHtml) drift.push("site/index.html registry table");
  if (currentJson !== expectedJson) drift.push("site/data/remediation-registry.json");
  if (currentSchema !== expectedSchema) {
    drift.push("site/data/remediation-registry.schema.json");
  }

  if (drift.length > 0) {
    throw new Error(`Generated site registry is stale: ${drift.join(", ")}`);
  }

  process.stdout.write(`Verified ${registry.entries.length} generated remediation entries.\n`);
} else {
  await writeFile(siteHtmlPath, expectedHtml);
  await writeFile(siteJsonPath, expectedJson);
  await writeFile(siteSchemaPath, expectedSchema);
  process.stdout.write(`Generated ${registry.entries.length} remediation entries for the site.\n`);
}

function renderEntry(entry) {
  const requirements = entry.requirements
    .map(
      (requirement) =>
        `<a href="${escapeAttribute(requirement.url)}">${escapeHtml(requirement.standard)} ${escapeHtml(requirement.requirementId)}</a>`
    )
    .join(", ");
  const detection = renderList(entry.deterministicDetection);
  const ai = entry.ai.allowed
    ? `<strong class="ai-label">AI-assisted</strong><span>${escapeHtml(entry.ai.purpose)}</span>`
    : `<strong>Deterministic only</strong><span>${escapeHtml(entry.ai.purpose)}</span>`;
  const verification = renderList(entry.verification);

  return `              <tr>
                <th scope="row">
                  <strong>${escapeHtml(entry.title)}</strong>
                  <span class="registry-status ${escapeAttribute(entry.implementationStatus)}">${escapeHtml(capitalize(entry.implementationStatus))}</span>
                  <span>${requirements}</span>
                </th>
                <td>${detection}</td>
                <td class="registry-ai">${ai}</td>
                <td>${verification}</td>
              </tr>`;
}

function renderList(items) {
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function replaceBetweenMarkers(source, replacement) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker);

  if (start === -1 || end === -1 || end < start) {
    throw new Error("Could not find remediation registry markers in site/index.html");
  }

  const contentStart = start + startMarker.length;
  return `${source.slice(0, contentStart)}\n${replacement}\n            ${source.slice(end)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value);
}

function capitalize(value) {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}
