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

test("a change inside a live region names the region: its nearest polite or assertive ancestor, with its text", () => {
  // <p aria-live="polite" aria-label="Clock">Time <span>10:00:01</span></p>
  // <div role="status"></div> <div aria-live="off">…</div>
  const tree = (time: string, status: string[], off: string) => {
    const clock = axNode(
      2,
      "paragraph",
      "Clock",
      { live: { type: "token", value: "polite" } },
      { parentId: "1", childIds: ["3", "4"] }
    );
    const label = axNode(3, "StaticText", "Time", {}, { parentId: "2" });
    // Chrome leaves the span out of what a screen reader perceives, but keeps it in the tree.
    const span = { ...axNode(4, "generic", ""), parentId: "2", childIds: ["5"], ignored: true };
    const timeText = axNode(5, "StaticText", time, {}, { parentId: "4" });
    const statusRegion = axNode(
      6,
      "status",
      "",
      { live: { type: "token", value: "polite" } },
      { parentId: "1", childIds: status.length ? ["7"] : [] }
    );
    const statusText = status.map((text) => axNode(7, "StaticText", text, {}, { parentId: "6" }));
    const silent = axNode(
      8,
      "generic",
      "",
      { live: { type: "token", value: "off" } },
      { parentId: "1", childIds: ["9"] }
    );
    const silentText = axNode(9, "StaticText", off, {}, { parentId: "8" });
    const page = axNode(1, "RootWebArea", "Shop", {}, { childIds: ["2", "6", "8"] });
    return {
      nodes: [page, clock, label, span, timeText, statusRegion, ...statusText, silent, silentText]
    };
  };

  const changes = diffAccessibilityTrees(
    tree("10:00:01", [], "3 items"),
    tree("10:00:02", ["Saved"], "4 items")
  );

  assert.deepEqual(changes?.liveRegions, [
    { nodeId: 2, role: "paragraph", name: "Clock", politeness: "polite", text: "Time 10:00:02" },
    { nodeId: 6, role: "status", politeness: "polite", text: "Saved" }
  ]);
  // The region marked off changed too, but a screen reader does not announce it.
  assert.equal(changes?.changes.length, 3);
});

test("a region that left the page is named with its text from before", () => {
  const region = (shown: boolean) =>
    shown
      ? [
          axNode(
            2,
            "alert",
            "",
            { live: { type: "token", value: "assertive" } },
            { parentId: "1", childIds: ["3"] }
          ),
          axNode(3, "StaticText", "Card declined", {}, { parentId: "2" })
        ]
      : [];
  const page = (shown: boolean) =>
    axNode(1, "RootWebArea", "Pay", {}, { childIds: shown ? ["2"] : [] });

  const changes = diffAccessibilityTrees(
    { nodes: [page(true), ...region(true)] },
    { nodes: [page(false)] }
  );

  assert.deepEqual(changes?.liveRegions, [
    { nodeId: 2, role: "alert", politeness: "assertive", text: "Card declined" }
  ]);
});

test("changes outside any live region name none", () => {
  const changes = diffAccessibilityTrees(
    { nodes: [axNode(1, "RootWebArea", "Shop", {}, { childIds: [] })] },
    {
      nodes: [
        axNode(1, "RootWebArea", "Shop", {}, { childIds: ["2"] }),
        axNode(2, "StaticText", "Welcome", {}, { parentId: "1" })
      ]
    }
  );
  assert.equal(changes?.liveRegions, undefined);
});
