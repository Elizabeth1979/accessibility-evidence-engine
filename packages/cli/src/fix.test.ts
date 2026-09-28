import assert from "node:assert/strict";
import test from "node:test";

import { applyFix, fixAttributeForRule, type FixProposal } from "./fix";

const closeButton: FixProposal = {
  selector: "#close",
  attribute: "aria-label",
  value: 'Close the "Sign up" dialog & return'
};

test("each allowlisted naming rule maps to the attribute that carries its name", () => {
  assert.equal(fixAttributeForRule("button-name"), "aria-label");
  assert.equal(fixAttributeForRule("image-alt"), "alt");
  assert.equal(fixAttributeForRule("color-contrast"), undefined);
});

test("HTML: adds the attribute to the one element with the id and keeps every other byte", () => {
  const source = `<!doctype html>\n<p class="x">Hi</p>\n<button id="close" class="icon"><svg></svg></button>\n<button id="other"></button>\n`;
  const result = applyFix(closeButton, source, "page.html");
  assert.equal(result.applied, true);
  assert.equal(
    result.source,
    source.replace(
      '<button id="close" class="icon">',
      '<button id="close" class="icon" aria-label="Close the &quot;Sign up&quot; dialog &amp; return">'
    )
  );
});

test("HTML: replaces an attribute that is already there, and places one in a void tag", () => {
  const replaced = applyFix(
    { selector: "#logo", attribute: "alt", value: "Acme home" },
    `<img id="logo" alt='old' src="a.png" />`,
    "index.htm"
  );
  assert.equal(replaced.source, `<img id="logo" alt="Acme home" src="a.png" />`);
  const inserted = applyFix(
    { selector: "#logo", attribute: "alt", value: "Acme home" },
    `<img id="logo" src="a.png" />`,
    "index.html"
  );
  assert.equal(inserted.source, `<img id="logo" src="a.png" alt="Acme home" />`);
});

test("HTML: finds an element inside a template, and a `>` inside a quoted value does not fool it", () => {
  const source = `<template><button title="a > b" id="close"></button></template>`;
  assert.equal(
    applyFix({ ...closeButton, value: "Close" }, source, "a.html").source,
    `<template><button title="a > b" id="close" aria-label="Close"></button></template>`
  );
});

test("HTML: declines, unchanged, without an id selector or a single element with the id", () => {
  const source = `<button id="close"></button><button id="twice"></button><button id="twice"></button>`;
  for (const [selector, reason] of [
    [".toolbar > button", "only an #id selector"],
    ["#missing", 'no element has id "missing"'],
    ["#twice", '2 elements have id "twice"']
  ] as const) {
    const result = applyFix({ ...closeButton, selector }, source, "a.html");
    assert.equal(result.applied, false, selector);
    assert.equal(result.source, source);
    assert.match(result.detail, new RegExp(`${reason}.*Apply by hand: set aria-label=`));
  }
});

test("JSX: adds the attribute after the element name, found by a parse", () => {
  const source = `export const Close = () => (\n  <IconButton id="close" onClick={close}>\n    <XIcon />\n  </IconButton>\n);\n`;
  const result = applyFix({ ...closeButton, value: "Close" }, source, "Close.jsx");
  assert.equal(
    result.source,
    source.replace(`<IconButton id="close"`, `<IconButton aria-label="Close" id="close"`)
  );
});

test("TSX: replaces a string attribute, and a value-less one, with type syntax in the file", () => {
  const source = `const size: number = 16;\nexport const A = () => <img id="logo" alt="old" width={size as number} />;\n`;
  assert.equal(
    applyFix({ selector: "#logo", attribute: "alt", value: "Acme home" }, source, "Logo.tsx")
      .source,
    source.replace(`alt="old"`, `alt="Acme home"`)
  );
  assert.equal(
    applyFix(
      { selector: "#logo", attribute: "alt", value: "Acme" },
      `<img id="logo" alt />`,
      "a.js"
    ).source,
    `<img id="logo" alt="Acme" />`
  );
});

test("JSX: declines an expression, a dynamic id, a duplicate and a file that does not parse", () => {
  const cases: Array<[string, string]> = [
    [`<button id="close" aria-label={label} />`, "its aria-label is an expression"],
    [`<button id={"close"} />`, 'no element has id "close"'],
    [`<><a id="close" /><b id="close" /></>`, '2 elements have id "close"'],
    [`<button id="close">`, "the file does not parse"]
  ];
  for (const [source, reason] of cases) {
    const result = applyFix(closeButton, source, "View.jsx");
    assert.equal(result.applied, false, source);
    assert.equal(result.source, source);
    assert.match(result.detail, new RegExp(reason));
  }
});

test("any other kind of file is declined rather than guessed at", () => {
  const result = applyFix(closeButton, `<template><button id="close" /></template>`, "A.vue");
  assert.equal(result.applied, false);
  assert.match(result.detail, /A\.vue is not an HTML, JavaScript, JSX or TSX file/);
});
