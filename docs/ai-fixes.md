# AI Fix Proposals

`@aee/ai-fixes` turns captured UI context into a review-only accessible-name proposal. It is intentionally separate from accessibility judgment and release gating.

## Trust model

1. A scanner or reviewer identifies an unnamed control.
2. The caller supplies bounded UI context to a model provider.
3. The provider returns a label, rationale, and confidence as structured data.
4. AEE emits a proposed patch with `safety: "review"`.
5. A person reviews and applies or rejects it.
6. A new scanner and interaction run verify the accepted change.

An AI suggestion never counts as proof and is never applied automatically.

## Provider-neutral usage

```ts
import { proposeAccessibleLabelFix } from "@aee/ai-fixes";

const proposal = await proposeAccessibleLabelFix(
  {
    selector: "#delete-project",
    role: "button",
    iconDescription: "trash can",
    nearbyHeading: "Project Alpha",
    destinationText: "Delete Project Alpha? This action cannot be undone."
  },
  yourModelProvider
);
```

## OpenAI Responses provider

```ts
import { createOpenAiResponsesLabelProvider, proposeAccessibleLabelFix } from "@aee/ai-fixes";

const provider = createOpenAiResponsesLabelProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  model: process.env.AEE_LABEL_MODEL!
});
```

The adapter uses the Responses API with a strict JSON Schema and `store: false`. The API key and model are caller-supplied; the repository contains neither credentials nor a hidden default model. See the official [OpenAI Responses API reference](https://developers.openai.com/api/reference/cli/resources/responses/methods/create).

## Privacy

Model input can contain product names, nearby text, and destination or dialog copy. Minimize that context, use synthetic or test data, follow the selected provider's data-handling requirements, and never send captured production content without authorization.

The public demo uses a checked-in, reviewed Codex-authored proposal. Its artifact declares `liveModelCall: false` because CI and GitHub Pages do not receive API credentials.
