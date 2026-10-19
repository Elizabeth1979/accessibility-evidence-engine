// The site's inline markdown: what the roadmap and the feature list render from repo text.
import assert from "node:assert/strict";
import test from "node:test";

import { inline } from "./site-page.mjs";

test("renders code, bold, emphasis and links", () => {
  assert.equal(
    inline("Run `npm test`, **always**, _then_ read [the docs](https://example.com/docs)."),
    'Run <code>npm test</code>, <strong>always</strong>, <em>then</em> read <a href="https://example.com/docs">the docs</a>.'
  );
});

test("keeps bold and link syntax inside a code span as literal code", () => {
  assert.equal(
    inline("Type `**name**` or `[label](https://example.com)` as written."),
    "Type <code>**name**</code> or <code>[label](https://example.com)</code> as written."
  );
});

test("escapes raw HTML instead of passing it through", () => {
  assert.equal(
    inline('A <button onclick="x()">tag</button> & <b>bold</b>'),
    "A &lt;button onclick=&quot;x()&quot;&gt;tag&lt;/button&gt; &amp; &lt;b&gt;bold&lt;/b&gt;"
  );
});

test("resolves relative links against the file the text comes from", () => {
  const base = "https://example.com/repo/docs/plan.md";
  assert.equal(
    inline("See [the spec](spec.md), [later](#later) and [the site](https://example.org/).", base),
    'See <a href="https://example.com/repo/docs/spec.md">the spec</a>, <a href="https://example.com/repo/docs/plan.md#later">later</a> and <a href="https://example.org/">the site</a>.'
  );
  assert.equal(inline("[the spec](spec.md)"), '<a href="spec.md">the spec</a>');
});
