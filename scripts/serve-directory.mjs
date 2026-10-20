import path from "node:path";

import sirv from "sirv";

/**
 * Serves the files in one directory over http, for AEE's own test pages: the Playwright tests, the
 * package check and the demo recording. sirv sets each file's content type, serves a directory's
 * index.html, and answers 404 for anything outside the directory or missing.
 *
 * Its dev mode reads each file when it is asked for, so a file a run writes or changes after the
 * server started is served as it is now. Without it, sirv lists the directory once at start-up.
 *
 * @param {string} root The directory to serve.
 * @returns {import("node:http").RequestListener}
 */
export function serveDirectory(root) {
  return sirv(path.resolve(root), { dev: true });
}
