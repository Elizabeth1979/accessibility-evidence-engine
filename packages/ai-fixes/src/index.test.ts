import assert from "node:assert/strict";
import test from "node:test";

import {
  createOpenAiResponsesLabelProvider,
  proposeAccessibleLabelFix,
  routeContextualReview,
  suggestPaletteContrastFix
} from "./index";

const context = {
  selector: "#delete-project",
  role: "button",
  iconDescription: "trash can",
  nearbyHeading: "Project Alpha",
  nearbyText: "Manage project settings",
  destinationText: "Delete Project Alpha? This action cannot be undone."
};

test("proposeAccessibleLabelFix returns a review-only contextual patch", async () => {
  const fix = await proposeAccessibleLabelFix(context, {
    id: "test-model",
    async suggestLabel() {
      return {
        label: "Delete Project Alpha",
        rationale:
          "The trash icon and confirmation dialog identify the destructive project action.",
        confidence: 0.96
      };
    }
  });

  assert.equal(fix.safety, "review");
  assert.deepEqual(fix.patches, ['#delete-project: add aria-label="Delete Project Alpha"']);
  assert.match(fix.rationale ?? "", /verified rerun/i);
});

test("routine defects do not cross the AI review boundary", async () => {
  let providerCalled = false;

  await assert.rejects(
    proposeAccessibleLabelFix(
      { selector: "#save", role: "button", nearbyText: "Save" },
      {
        id: "must-not-run",
        async suggestLabel() {
          providerCalled = true;
          return { label: "Save", rationale: "Visible text already supplies it.", confidence: 1 };
        }
      }
    ),
    /AI review was not triggered.*not icon-only/i
  );
  assert.equal(providerCalled, false);
});

test("already-named icons and icons without bounded context do not call a provider", async () => {
  let providerCalls = 0;
  const provider = {
    id: "must-not-run",
    async suggestLabel() {
      providerCalls += 1;
      return { label: "Delete", rationale: "Unused.", confidence: 1 };
    }
  };

  await assert.rejects(
    proposeAccessibleLabelFix(
      {
        selector: "#delete",
        role: "button",
        currentAccessibleName: "Delete project",
        iconDescription: "trash can",
        nearbyText: "Project"
      },
      provider
    ),
    /already has an accessible name/i
  );
  await assert.rejects(
    proposeAccessibleLabelFix(
      { selector: "#mystery", role: "button", iconDescription: "unidentified symbol" },
      provider
    ),
    /No bounded UI context/i
  );
  assert.equal(providerCalls, 0);
});

test("only contextual heading and decorative decisions route to AI review", () => {
  assert.equal(
    routeContextualReview({
      kind: "heading-structure",
      hasFullPageContext: false,
      needsSemanticOutline: false
    }).route,
    "deterministic"
  );
  assert.equal(
    routeContextualReview({
      kind: "heading-structure",
      hasFullPageContext: true,
      needsSemanticOutline: true
    }).route,
    "ai-review"
  );
  assert.equal(
    routeContextualReview({
      kind: "decorative-classification",
      hasVisualContext: true,
      meaningDependsOnRelationship: true
    }).route,
    "ai-review"
  );
  assert.equal(
    routeContextualReview({ kind: "deterministic-rule", ruleId: "button-name" }).route,
    "deterministic"
  );
});

test("OpenAI Responses provider requests strict structured output", async () => {
  let requestBody: Record<string, unknown> | undefined;
  const provider = createOpenAiResponsesLabelProvider({
    apiKey: "test-key",
    model: "test-model",
    async fetch(_input, init) {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            label: "Delete Project Alpha",
            rationale: "The surrounding project card and confirmation copy establish intent.",
            confidence: 0.94
          })
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
  });

  const suggestion = await provider.suggestLabel(context);

  assert.equal(suggestion.label, "Delete Project Alpha");
  assert.equal(requestBody?.store, false);
  assert.equal(
    ((requestBody?.text as Record<string, unknown>)?.format as Record<string, unknown>)?.type,
    "json_schema"
  );
});

test("palette contrast fix selects the closest passing project color", () => {
  const suggestion = suggestPaletteContrastFix({
    selector: ".secondary-copy",
    foreground: "#607a71",
    background: "#07110f",
    palette: [
      { name: "Muted", value: "#607a71" },
      { name: "Text subtle", value: "#91aaa2" },
      { name: "Accent", value: "#70f0b4" },
      { name: "White", value: "#ffffff" }
    ]
  });

  assert.equal(suggestion.selected.name, "Text subtle");
  assert.ok(suggestion.currentRatio < 4.5);
  assert.ok(suggestion.selectedRatio >= 4.5);
  assert.equal(suggestion.proposal.safety, "review");
  assert.deepEqual(suggestion.proposal.patches, [".secondary-copy: set color: #91aaa2"]);
});

test("palette contrast fix refuses unnecessary or impossible proposals", () => {
  assert.throws(
    () =>
      suggestPaletteContrastFix({
        selector: "p",
        foreground: "#ffffff",
        background: "#000000",
        palette: [{ name: "White", value: "#ffffff" }]
      }),
    /already meets/i
  );
  assert.throws(
    () =>
      suggestPaletteContrastFix({
        selector: "p",
        foreground: "#777777",
        background: "#ffffff",
        palette: [{ name: "Still low", value: "#888888" }]
      }),
    /No supplied palette color/i
  );
});
