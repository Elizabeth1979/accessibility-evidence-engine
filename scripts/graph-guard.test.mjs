// Architecture guard: the dependency graph in docs/architecture.md is a contract, every import a
// package ships is one it declares, and only the Playwright adapter and what builds on it can
// reach a browser. The AI and the judges see captured evidence, never the live page.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import test from "node:test";

import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const BROWSER_ADAPTER = "@aee/playwright";
/** Packages that drive a browser. Every Playwright wrapper also reaches playwright-core. */
const BROWSER_DRIVERS = [
  "playwright",
  "playwright-core",
  "@playwright/test",
  "puppeteer",
  "puppeteer-core",
  "selenium-webdriver",
  "webdriverio"
];

const workspaces = readdirSync(path.join(root, "packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((folder) => {
    const directory = path.join(root, "packages", folder.name);
    const manifest = readManifest(directory);
    return { directory, name: manifest.name, dependencies: declaredDependencies(manifest) };
  });
const documented = documentedGraph();

test("each package depends on exactly the @aee packages docs/architecture.md draws", () => {
  assert.deepEqual(
    [...documented.keys()].sort(),
    workspaces.map((workspace) => workspace.name).sort(),
    "The architecture graph must show every workspace package."
  );
  for (const workspace of workspaces) {
    assert.deepEqual(
      workspace.dependencies.filter((name) => documented.has(name)).sort(),
      documented.get(workspace.name).sort(),
      `${workspace.name}'s @aee dependencies differ from docs/architecture.md.`
    );
  }
});

for (const workspace of workspaces) {
  test(`${workspace.name} imports only what it declares`, () => {
    for (const file of shippedSourceFiles(workspace.directory)) {
      for (const specifier of importsOf(file)) {
        if (specifier.startsWith(".") || isBuiltin(specifier)) continue;
        assert.ok(
          workspace.dependencies.includes(packageName(specifier)),
          `${path.relative(root, file)} imports "${specifier}", which ${workspace.name} does not declare.`
        );
      }
    }
  });
}

for (const workspace of workspaces.filter(({ name }) => !drivesBrowser(name))) {
  test(`${workspace.name} cannot reach a browser driver`, () => {
    const drivers = [...installedClosure(workspace.directory)].filter((name) =>
      BROWSER_DRIVERS.includes(name)
    );
    assert.deepEqual(
      drivers,
      [],
      `${workspace.name} reaches ${drivers.join(", ")}; only ${BROWSER_ADAPTER} and the packages built on it may drive a browser.`
    );
  });
}

/** The nodes and edges of the mermaid graph under "Dependency graph" in docs/architecture.md. */
function documentedGraph() {
  const markdown = readFileSync(path.join(root, "docs/architecture.md"), "utf8");
  const mermaid = markdown.split("## Dependency graph")[1].split("```")[1];
  const names = new Map(
    [...mermaid.matchAll(/^\s*(\w+)\["([^"]+)"\]$/gm)].map(([, id, name]) => [id, name])
  );
  const graph = new Map([...names.values()].map((name) => [name, []]));
  for (const [, from, to] of mermaid.matchAll(/^\s*(\w+) --> (\w+)$/gm)) {
    graph.get(names.get(from)).push(names.get(to));
  }
  return graph;
}

/** True for the browser adapter and every package the architecture builds on it. */
function drivesBrowser(name) {
  return name === BROWSER_ADAPTER || documented.get(name).some(drivesBrowser);
}

/** Every package installing this one pulls in, by name: dependencies and peers, transitively. */
function installedClosure(directory) {
  const names = new Set();
  const pending = [directory];
  while (pending.length > 0) {
    const from = pending.pop();
    for (const name of declaredDependencies(readManifest(from))) {
      if (names.has(name)) continue;
      names.add(name);
      const installed = installedDirectory(name, from);
      if (installed) pending.push(installed);
    }
  }
  return names;
}

function readManifest(directory) {
  return JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8"));
}

/** What installing the package pulls in: its dependencies and the peers it expects. */
function declaredDependencies(manifest) {
  return Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies });
}

/** Node's lookup: the nearest node_modules/<name> at or above the requiring package. */
function installedDirectory(name, from) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, "node_modules", name);
    if (existsSync(path.join(candidate, "package.json"))) return candidate;
    if (directory === path.dirname(directory)) return undefined;
  }
}

/** The package's TypeScript sources, minus tests, which do not ship. */
function shippedSourceFiles(directory) {
  const source = path.join(directory, "src");
  return readdirSync(source, { recursive: true })
    .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .map((file) => path.join(source, file));
}

/** Every module a file loads: static imports, re-exports, type imports, import() and require(). */
function importsOf(file) {
  return ts
    .preProcessFile(readFileSync(file, "utf8"), true, true)
    .importedFiles.map((entry) => entry.fileName);
}

function isBuiltin(specifier) {
  return specifier.startsWith("node:") || builtinModules.includes(specifier);
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return (specifier.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1)).join("/");
}
