import assert from "node:assert/strict";
import test from "node:test";

import { patternForAxeRule } from "@aee/schemas";

import { explain, indexRoutes, renderExplanation, withoutFrontMatter } from "./explain";

test("an axe rule id gets the pattern its report links to, with the WCAG criterion", () => {
  const button = explain("Button-Name");
  assert.equal(button.explainedAs, "axe rule");
  assert.equal(button.pattern, "buttons");
  assert.equal(button.url, patternForAxeRule("button-name")!.url);
  assert.deepEqual(button.requirements, ["WCAG 4.1.2 Name, Role, Value (A)"]);
  // The pattern itself, without the front matter meant for editors.
  assert.match(button.markdown, /^# Button and Clickable Element Accessibility\n/);
  assert.match(button.markdown, /## Implementation Checklist/);
});

test("an AEE finding id and a registry concept go through the registry too", () => {
  assert.deepEqual(
    [explain("pointer-only"), explain("accessible-name")].map(
      ({ explainedAs, pattern, requirements }) => [explainedAs, pattern, requirements[0]]
    ),
    [
      ["AEE finding", "focus-management", "WCAG 2.1.1 Keyboard (A)"],
      ["registry concept", "buttons", "WCAG 4.1.2 Name, Role, Value (A)"]
    ]
  );
});

test("a pattern name, or the UI element in words, is routed by the a11y-skills index", () => {
  assert.equal(explain("dialog-modal").explainedAs, "pattern");
  const dialog = explain("a modal dialog");
  assert.deepEqual([dialog.explainedAs, dialog.pattern], ["UI element", "dialog-modal"]);
  const button = explain("buttons");
  assert.equal(button.pattern, "buttons");
  const plain = explain("button");
  assert.equal(plain.pattern, "buttons");
  assert.ok(plain.alsoConsider.includes("menu-button"));
  assert.match(renderExplanation(plain), /^Also consider: .*menu-button/m);
});

test("with no match it says so and gives the general pattern, as the index says to", () => {
  const unknown = explain("xyzzy");
  assert.deepEqual([unknown.explainedAs, unknown.pattern], ["no match", "accessibility"]);
  assert.match(
    renderExplanation(unknown),
    /Nothing in the remediation registry or the a11y-skills index matched "xyzzy"/
  );
});

test("a symptom row that opens two patterns, or names one after other words, still routes", () => {
  // The index's rows "Tab order jumps around" → focus-management + landmarks, and
  // "axe: ARIA attribute not allowed / invalid role" → "the widget's own file, then accessibility".
  const tabOrder = explain("tab order jumps around");
  assert.deepEqual([tabOrder.pattern, tabOrder.alsoConsider], ["focus-management", ["landmarks"]]);
  assert.equal(explain("ARIA attribute not allowed").pattern, "accessibility");
});

test("the index is read as markdown, so any valid way of writing its table routes the same", () => {
  const usual = [
    "| If you are building… | Open |",
    "|---|---|",
    "| A modal dialog, drawer, overlay | [dialog-modal](dialog-modal.instructions.md) |",
    "| Tab order jumps around | [focus-management](focus-management.instructions.md) + [landmarks](landmarks.instructions.md) |"
  ].join("\n");
  // Windows line endings, no outer pipes, aligned columns, spaces after the last cell, and a
  // "./" link with a title: all valid GitHub markdown for the same table.
  const unusual = [
    "If you are building…            | Open",
    ":------------------------------ | :---",
    'A modal dialog, drawer, overlay | [dialog-modal](./dialog-modal.instructions.md "Modal dialogs")   ',
    "Tab order jumps around          | [focus-management](focus-management.instructions.md) + [landmarks](landmarks.instructions.md)"
  ].join("\r\n");

  const routed = indexRoutes(usual);
  assert.deepEqual(
    routed.map(({ pattern }) => pattern),
    ["dialog-modal", "focus-management", "landmarks"]
  );
  assert.deepEqual(indexRoutes(unusual), routed);
});

test("front matter is taken off however its lines end, and a later rule is kept", () => {
  const pattern = [
    "---",
    "description: Buttons",
    "applyTo: '**/*.html'",
    "---",
    "",
    "# Buttons",
    ""
  ];
  assert.equal(withoutFrontMatter(pattern.join("\n")), "# Buttons\n");
  assert.equal(withoutFrontMatter(pattern.join("\r\n")), "# Buttons\r\n");
  const noFrontMatter = "# Buttons\n\n---\n\nMore\n";
  assert.equal(withoutFrontMatter(noFrontMatter), noFrontMatter);
});
