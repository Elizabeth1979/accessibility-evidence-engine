// Builds Guidepup's virtual screen reader as one plain script for @aee/playwright to load into a
// page. Guidepup publishes it as an ES module, and a page's Content-Security-Policy can refuse to
// import a module; a plain script evaluated over the DevTools protocol runs on any page, which is
// how Deque's official @axe-core/playwright loads axe.
import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import { build } from "esbuild";

// Resolved from @aee/playwright, the package that depends on it and ships the built script.
const require = createRequire(
  path.resolve(import.meta.dirname, "../packages/playwright/package.json")
);
const entry = require.resolve("@guidepup/virtual-screen-reader/browser.js");
const packageDir = path.dirname(require.resolve("@guidepup/virtual-screen-reader/package.json"));
const { version } = JSON.parse(readFileSync(path.join(packageDir, "package.json"), "utf8"));
const outDir = path.resolve(import.meta.dirname, "../packages/playwright/dist");

mkdirSync(outDir, { recursive: true });
await build({
  entryPoints: [entry],
  bundle: true,
  format: "iife",
  // The page sees it as one global, named so no page script uses it.
  globalName: "__aeeGuidepupVirtualScreenReader",
  banner: {
    js: `/* @guidepup/virtual-screen-reader ${version}, MIT License: see guidepup-virtual-screen-reader.LICENSE */`
  },
  outfile: path.join(outDir, "guidepup-virtual-screen-reader.js"),
  logLevel: "warning"
});
copyFileSync(
  path.join(packageDir, "LICENSE"),
  path.join(outDir, "guidepup-virtual-screen-reader.LICENSE")
);
