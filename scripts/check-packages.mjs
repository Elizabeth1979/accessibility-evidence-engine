import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const expectedPackages = [
  "@aee/cli",
  "@aee/core",
  "@aee/judges",
  "@aee/observers",
  "@aee/playwright",
  "@aee/reporter",
  "@aee/schemas"
];
const workspaceRoot = path.resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(path.join(tmpdir(), "aee-package-check-"));
const packDirectory = path.join(temporaryRoot, "packs");
const installDirectory = path.join(temporaryRoot, "consumer");

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
    JSON.stringify({ name: "aee-package-consumer", version: "1.0.0", private: true }, null, 2)
  );
  const tarballs = packages.map((entry) => path.join(packDirectory, entry.filename));
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", ...tarballs],
    {
      cwd: installDirectory,
      stdio: "pipe"
    }
  );

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

  process.stdout.write(`Verified and installed ${packages.length} package tarballs.\n`);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
