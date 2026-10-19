// The one server for AEE's own test pages: the Playwright tests, the package check and the demo
// recording all serve a directory with it, so what it serves, and what it refuses, is tested here.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

import { serveDirectory } from "./serve-directory.mjs";

const temporaryRoot = mkdtempSync(path.join(tmpdir(), "aee-serve-directory-"));
const root = path.join(temporaryRoot, "site");
// A sibling whose name starts with the served directory's, which a bare prefix check would let
// through.
const sibling = path.join(temporaryRoot, "site-private");
let server;
let origin;

before(async () => {
  mkdirSync(path.join(root, "nested"), { recursive: true });
  mkdirSync(path.join(root, "empty"));
  mkdirSync(sibling);
  writeFileSync(path.join(root, "index.html"), "<!doctype html><title>Home</title>");
  writeFileSync(path.join(root, "nested", "index.html"), "<!doctype html><title>Nested</title>");
  writeFileSync(path.join(root, "two words.html"), "<!doctype html><title>Two words</title>");
  for (const extension of ["css", "js", "json", "svg", "png", "mp4", "webm", "md"]) {
    writeFileSync(path.join(root, `file.${extension}`), extension);
  }
  writeFileSync(path.join(temporaryRoot, "secret.txt"), "outside the served directory");
  writeFileSync(path.join(sibling, "secret.txt"), "outside the served directory");
  server = createServer(serveDirectory(root));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  rmSync(temporaryRoot, { recursive: true, force: true });
});

/**
 * Sends the path exactly as written: a browser would tidy `..` away before sending it. A request
 * that gets no answer fails after five seconds instead of hanging the run.
 */
function get(rawPath) {
  return new Promise((resolve, reject) => {
    const { hostname, port } = new URL(origin);
    const signal = AbortSignal.timeout(5000);
    request({ hostname, port, path: rawPath, signal }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => (body += chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode, type: response.headers["content-type"], body })
      );
    })
      .on("error", reject)
      .end();
  });
}

test("each file is served with the content type a browser needs for it", async () => {
  const expected = {
    "file.css": "text/css",
    "file.js": "text/javascript",
    "file.json": "application/json",
    "file.svg": "image/svg+xml",
    "file.png": "image/png",
    "file.mp4": "video/mp4",
    "file.webm": "video/webm",
    "file.md": "text/markdown",
    "index.html": "text/html"
  };
  for (const [file, type] of Object.entries(expected)) {
    const response = await get(`/${file}`);
    assert.equal(response.status, 200, file);
    assert.equal(response.type?.split(";")[0], type, file);
  }
  // A page's text is UTF-8, so its server says so.
  assert.match((await get("/index.html")).type ?? "", /^text\/html; ?charset=utf-8$/i);
});

test("a directory serves its index.html, as a site host does", async () => {
  assert.match((await get("/")).body, /<title>Home<\/title>/);
  assert.match((await get("/nested/")).body, /<title>Nested<\/title>/);
});

test("a file name with an encoded space is served", async () => {
  assert.match((await get("/two%20words.html")).body, /<title>Two words<\/title>/);
});

test("a missing file and a directory with no index are a 404", async () => {
  assert.equal((await get("/missing.html")).status, 404);
  assert.equal((await get("/empty/")).status, 404);
});

test("a file written after the server started is served as it is now", async () => {
  const late = path.join(root, "written-later.json");
  writeFileSync(late, '{"run":1}');
  assert.equal((await get("/written-later.json")).body, '{"run":1}');
  writeFileSync(late, '{"run":2, "longer":true}');
  assert.equal((await get("/written-later.json")).body, '{"run":2, "longer":true}');
});

test("no path leaves the served directory", async () => {
  for (const rawPath of [
    "/../secret.txt",
    "/nested/../../secret.txt",
    "/%2e%2e/secret.txt",
    "/..%2fsecret.txt",
    "/%2e%2e%2fsecret.txt",
    "/..%5csecret.txt",
    "/../site-private/secret.txt",
    "/%2e%2e%2fsite-private%2fsecret.txt"
  ]) {
    const response = await get(rawPath);
    assert.notEqual(response.status, 200, rawPath);
    assert.doesNotMatch(response.body, /outside the served directory/, rawPath);
  }
});

test("a malformed escape is a 404 and the server keeps serving", async () => {
  assert.equal((await get("/%E0%A4%A.html")).status, 404);
  assert.equal((await get("/index.html")).status, 200);
});
