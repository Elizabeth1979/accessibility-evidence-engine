import assert from "node:assert/strict";
import test from "node:test";

import { patternForAxeRule } from "@aee/schemas";

import { explain, renderExplanation } from "./explain";

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
