import assert from "node:assert/strict";
import test from "node:test";

import { createOpenAiResponsesLabelProvider, proposeAccessibleLabelFix } from "./index";

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
