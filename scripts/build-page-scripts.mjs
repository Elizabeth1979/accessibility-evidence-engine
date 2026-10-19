// Builds the libraries @aee/playwright runs inside a page as plain scripts: Guidepup's virtual
// screen reader, tabbable for the page's tab order, and axe-core for its selectors. Guidepup and
// tabbable publish ES modules, and a page's Content-Security-Policy can refuse to import a module; a
// plain script evaluated over the DevTools protocol runs on any page, which is how Deque's official
// @axe-core/playwright loads axe. axe-core gets a global of its own, so AEE always uses the axe it
// pins, whichever axe a page loads itself.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { build } from "esbuild";

// Resolved from @aee/playwright, the package that depends on them and ships the built scripts.
const require = createRequire(
  path.resolve(import.meta.dirname, "../packages/playwright/package.json")
);
const outDir = path.resolve(import.meta.dirname, "../packages/playwright/dist");

// Each page sees a script as one global, named so no page script uses it.
const PAGE_SCRIPTS = [
  {
    packageName: "@guidepup/virtual-screen-reader",
    entry: "@guidepup/virtual-screen-reader/browser.js",
    globalName: "__aeeGuidepupVirtualScreenReader",
    outName: "guidepup-virtual-screen-reader"
  },
  {
    packageName: "tabbable",
    entry: "tabbable",
    globalName: "__aeeTabbable",
    outName: "tabbable"
  },
  {
    packageName: "axe-core",
    entry: "axe-core/axe.min.js",
    globalName: "__aeeAxe",
    outName: "axe"
  }
];

mkdirSync(outDir, { recursive: true });
for (const { packageName, entry, globalName, outName } of PAGE_SCRIPTS) {
  const packageDir = path.dirname(require.resolve(`${packageName}/package.json`));
  const { version, license } = JSON.parse(
    readFileSync(path.join(packageDir, "package.json"), "utf8")
  );
  await build({
    entryPoints: [require.resolve(entry)],
    bundle: true,
    format: "iife",
    globalName,
    banner: {
      js: `/* ${packageName} ${version}, ${license} License: see ${outName}.LICENSE */`
    },
    outfile: path.join(outDir, `${outName}.js`),
    logLevel: "warning"
  });
  copyFileSync(path.join(packageDir, "LICENSE"), path.join(outDir, `${outName}.LICENSE`));
}
