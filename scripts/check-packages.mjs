import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { promisify } from "node:util";

const expectedPackages = [
  "@aee/ai-fixes",
  "@aee/cli",
  "@aee/core",
  "@aee/judges",
  "@aee/mcp",
  "@aee/observers",
  "@aee/playwright",
  "@aee/reporter",
  "@aee/schemas"
];
const workspaceRoot = path.resolve(import.meta.dirname, "..");
/** What the test lab's page loads. */
const CONTENT_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "text/javascript",
  ".svg": "image/svg+xml"
};
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "aee-package-check-"));
const packDirectory = path.join(temporaryRoot, "packs");
const installDirectory = path.join(temporaryRoot, "consumer");

// Playwright is a peer: a project keeps the Playwright it has, down to the oldest AEE works with.
const oldestPlaywright = /^\^(\d+\.\d+\.\d+)$/.exec(
  JSON.parse(readFileSync(path.join(workspaceRoot, "packages/cli/package.json"), "utf8"))
    .peerDependencies["@playwright/test"]
)?.[1];
assert.ok(oldestPlaywright, "@aee/cli's @playwright/test range must be ^ its oldest version.");

try {
  mkdirSync(packDirectory);
  mkdirSync(installDirectory);

  const packOutput = execFileSync(
    "npm",
    ["pack", "--workspaces", "--json", "--pack-destination", packDirectory],
    {
      cwd: workspaceRoot,
      encoding: "utf8"
    }
  );
  const packages = JSON.parse(packOutput);
  assert.equal(
    packages.length,
    expectedPackages.length,
    "Expected one tarball per workspace package."
  );
  assert.deepEqual(
    packages.map((entry) => entry.name).sort(),
    [...expectedPackages].sort(),
    "Packed an unexpected workspace package set."
  );

  // A release carries every package at one version, since each depends on the others exactly.
  assert.equal(
    new Set(packages.map((entry) => entry.version)).size,
    1,
    "Every package must share one version."
  );

  for (const entry of packages) {
    const files = entry.files.map((file) => file.path);
    assert.ok(files.includes("LICENSE"), `${entry.name} is missing LICENSE.`);
    assert.ok(files.includes("README.md"), `${entry.name} is missing README.md.`);
    assert.ok(files.includes("package.json"), `${entry.name} is missing package.json.`);
    assert.ok(files.includes("dist/index.js"), `${entry.name} is missing its runtime entry point.`);
    assert.ok(files.includes("dist/index.d.ts"), `${entry.name} is missing its type entry point.`);
    assert.equal(
      files.some((file) => file.includes(".test.")),
      false,
      `${entry.name} contains compiled tests.`
    );
    assert.equal(
      files.some((file) => file.endsWith(".d.ts.map")),
      false,
      `${entry.name} contains a declaration map without its source file.`
    );
    assert.equal(
      files.some((file) => file.startsWith("src/")),
      false,
      `${entry.name} contains unpackaged source files.`
    );
  }

  writeFileSync(
    path.join(installDirectory, "package.json"),
    JSON.stringify(
      {
        name: "aee-package-consumer",
        version: "1.0.0",
        private: true,
        devDependencies: { "@playwright/test": oldestPlaywright }
      },
      null,
      2
    )
  );
  // A project that has Playwright installs its own dependencies first, then adds AEE.
  const install = (...tarballs) =>
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", ...tarballs], {
      cwd: installDirectory,
      stdio: "pipe"
    });
  install();
  install(...packages.map((entry) => path.join(packDirectory, entry.filename)));

  const requireFromConsumer = createRequire(path.join(installDirectory, "package.json"));

  for (const packageName of expectedPackages) {
    const manifest = JSON.parse(
      readFileSync(requireFromConsumer.resolve(`${packageName}/package.json`), "utf8")
    );
    assert.equal(manifest.license, "Apache-2.0", `${packageName} has incorrect license metadata.`);
    assert.equal(manifest.engines?.node, ">=22", `${packageName} has an incorrect Node.js range.`);
    assert.equal(
      manifest.publishConfig?.access,
      "public",
      `${packageName} is not configured as public.`
    );
    assert.ok(manifest.exports?.["."], `${packageName} does not define its public entry point.`);
    assert.ok(
      requireFromConsumer(packageName),
      `${packageName} could not be required after installation.`
    );
  }

  const runSchema = requireFromConsumer("@aee/schemas/json/run.schema.json");
  assert.equal(runSchema.title, "AEE Run", "The public JSON Schema subpath is unavailable.");
  assert.equal(
    typeof requireFromConsumer("@aee/cli/test").test,
    "function",
    "The @aee/cli/test fixture subpath is unavailable."
  );

  // A spec in an ES module project imports the fixture by name, and Node sees only the names a
  // CommonJS file spells out, so check it the way such a spec does.
  writeFileSync(
    path.join(installDirectory, "fixture-check.mjs"),
    'import { expect, test } from "@aee/cli/test";\nif (typeof test !== "function" || typeof expect !== "function") process.exit(1);\n'
  );
  execFileSync(process.execPath, ["fixture-check.mjs"], { cwd: installDirectory, stdio: "pipe" });

  // Installing AEE into a project on the oldest Playwright leaves it there, with no second copy.
  const playwrights = JSON.parse(
    execFileSync("npm", ["query", "#playwright, #playwright-core, #@playwright/test"], {
      cwd: installDirectory,
      encoding: "utf8"
    })
  );
  assert.deepEqual(
    [...new Set(playwrights.map(({ name, version }) => `${name}@${version}`))].sort(),
    ["@playwright/test", "playwright-core", "playwright"].map(
      (name) => `${name}@${oldestPlaywright}`
    ),
    "Installing AEE changed the project's Playwright."
  );

  // And the fixture works on it: the example spec, with only its import swapped, runs there.
  const spec = readFileSync(
    path.join(workspaceRoot, "examples/playwright-fixture/existing.spec.ts"),
    "utf8"
  ).replace('from "@playwright/test"', 'from "@aee/cli/test"');
  writeFileSync(path.join(installDirectory, "existing.spec.ts"), spec);
  // The spec opens the demo page from the repository's site, which loads its script and styles.
  symlinkSync(path.join(workspaceRoot, "site"), path.join(installDirectory, "site"));
  execFileSync("npx", ["playwright", "install", "chromium"], {
    cwd: installDirectory,
    stdio: "inherit"
  });
  execFileSync("npx", ["playwright", "test", "--reporter=line"], {
    cwd: installDirectory,
    stdio: "inherit"
  });
  // The test's assessment sits next to its PR comment; each checkpoint's own report is below it.
  const results = path.join(installDirectory, "test-results");
  const [comment] = readdirSync(results, { recursive: true }).filter(
    (file) => path.basename(file) === "aee-pr-comment.md"
  );
  assert.ok(comment, `The fixture wrote no assessment on Playwright ${oldestPlaywright}.`);
  const report = JSON.parse(
    readFileSync(path.join(results, path.dirname(comment), "aee-report.json"), "utf8")
  );
  const rules = report.synthesis.findings.map(({ ruleId }) => ruleId);
  for (const rule of ["button-name", "image-alt", "label", "link-name"]) {
    assert.ok(
      rules.includes(rule),
      `The fixture missed ${rule} on Playwright ${oldestPlaywright}.`
    );
  }

  // And `aee run` works on it: the test lab's fixed page passes, as the Accessibility workflow
  // checks on the Playwright AEE is developed on, served at the address its scenario names.
  const site = createServer(async (request, response) => {
    const file = path.join(installDirectory, "site", new URL(request.url, "http://site").pathname);
    const body = await readFile(file).catch(() => undefined);
    response.writeHead(body ? 200 : 404, {
      "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream"
    });
    response.end(body);
  });
  await new Promise((resolve) => site.listen(4173, "127.0.0.1", resolve));
  const run = await promisify(execFile)(
    "npx",
    ["aee", "run", path.join(workspaceRoot, "examples/test-lab/scenario.yml"), "--output", "aee"],
    { cwd: installDirectory }
  ).finally(() => site.close());
  const { verdict, completeness } = JSON.parse(run.stdout);
  assert.deepEqual(
    { verdict, completeness },
    { verdict: "pass", completeness: "complete" },
    `aee run did not pass the test lab's fixed page on Playwright ${oldestPlaywright}.`
  );

  process.stdout.write(
    `Verified and installed ${packages.length} package tarballs, and ran the fixture and aee run on Playwright ${oldestPlaywright}.\n`
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
