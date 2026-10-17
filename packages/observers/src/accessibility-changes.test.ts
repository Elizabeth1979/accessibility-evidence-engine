import assert from "node:assert/strict";
import test from "node:test";

import { diffAccessibilityTrees } from "./accessibility-changes";

/** A node as CDP's `Accessibility.getFullAXTree` returns it. */
function axNode(
  backendDOMNodeId: number,
  role: string,
  name: string,
  properties: Record<string, unknown> = {},
  extra: Record<string, unknown> = {}
) {
  return {
    nodeId: String(backendDOMNodeId),
    ignored: false,
    role: { type: "role", value: role },
    name: { type: "computedString", value: name },
    properties: Object.entries(properties).map(([propertyName, value]) => ({
      name: propertyName,
      value
    })),
    backendDOMNodeId,
    ...extra
  };
}

test("a native checkbox ticked with Space changes checked, and is the focused element, not the page", () => {
  const checkbox = (checked: string) =>
    axNode(4, "checkbox", "Agree", {
      focusable: { type: "booleanOrUndefined", value: true },
      focused: { type: "booleanOrUndefined", value: true },
      checked: { type: "tristate", value: checked }
    });

  // Chrome marks the document focused too whenever the page has focus.
  const page = axNode(1, "RootWebArea", "Terms", {
    focused: { type: "booleanOrUndefined", value: true }
  });

  const changes = diffAccessibilityTrees(
    { nodes: [page, checkbox("false")] },
    { nodes: [page, checkbox("true")] }
  );

  assert.deepEqual(changes, {
    focusedBefore: { nodeId: 4, role: "checkbox", name: "Agree" },
    focusedAfter: { nodeId: 4, role: "checkbox", name: "Agree" },
    changes: [
      {
        nodeId: 4,
        role: "checkbox",
        name: "Agree",
        kind: "state",
        state: "checked",
        before: "false",
        after: "true"
      }
    ],
    truncated: false
  });
});

test("a disclosure names the panel it opens through aria-controls, even when only the after tree has it", () => {
  // Chrome lists `controls` only while the panel is rendered, so a closed panel has none.
  const before = {
    nodes: [
      axNode(5, "button", "More", {
        focused: { type: "booleanOrUndefined", value: true },
        expanded: { type: "booleanOrUndefined", value: false }
      })
    ]
  };
  const after = {
    nodes: [
      axNode(5, "button", "More", {
        focused: { type: "booleanOrUndefined", value: true },
        expanded: { type: "booleanOrUndefined", value: true },
        controls: {
          type: "idrefList",
          value: "panel",
          relatedNodes: [{ idref: "panel", backendDOMNodeId: 6 }]
        }
      }),
      axNode(6, "generic", ""),
      axNode(7, "StaticText", "Panel text"),
      axNode(8, "InlineTextBox", "Panel text")
    ]
  };

  const changes = diffAccessibilityTrees(before, after);

  assert.deepEqual(changes?.changes, [
    {
      nodeId: 5,
      role: "button",
      name: "More",
      kind: "state",
      state: "expanded",
      before: false,
      after: true
    },
    {
      nodeId: 6,
      role: "generic",
      kind: "shown",
      controlledBy: [{ nodeId: 5, role: "button", name: "More" }]
    },
    { nodeId: 7, role: "StaticText", name: "Panel text", kind: "shown" }
  ]);
});

test("a clock that ticks shows as its text node leaving and a new one arriving", () => {
  const changes = diffAccessibilityTrees(
    { nodes: [axNode(12, "StaticText", "10:00"), axNode(30, "button", "Save")] },
    { nodes: [axNode(13, "StaticText", "10:01"), axNode(30, "button", "Save")] }
  );

  assert.deepEqual(
    changes?.changes.map(({ name, kind }) => `${name} ${kind}`),
    ["10:01 shown", "10:00 hidden"]
  );
});

test("ignored nodes and a value that stays the same are not changes", () => {
  const slider = (value: number, ignoredLabel: boolean) => ({
    nodes: [
      axNode(40, "slider", "Volume", {}, { value: { type: "number", value } }),
      { ...axNode(41, "generic", "decoration"), ignored: ignoredLabel }
    ]
  });

  assert.deepEqual(diffAccessibilityTrees(slider(5, true), slider(5, true))?.changes, []);
  assert.deepEqual(
    diffAccessibilityTrees(slider(5, true), slider(6, true))?.changes.map(
      ({ state, before, after }) => [state, before, after]
    ),
    [["value", 5, 6]]
  );
});

test("a snapshot that is not a CDP accessibility tree is not compared", () => {
  assert.equal(diffAccessibilityTrees({ role: "WebArea" }, { nodes: [] }), undefined);
  assert.equal(diffAccessibilityTrees(null, { nodes: [] }), undefined);
});
