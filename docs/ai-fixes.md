# AI Fix Proposals

`@aee/ai-fixes` provides deterministic routing for bounded, context-dependent accessibility questions and a review-only accessible-label proposal workflow. It is intentionally separate from accessibility judgment and release gating.

## When AI is allowed

The default is deterministic. A rule failure alone does not justify a model call. The current allowlist is:

- **Heading structure:** only when the intended semantic outline requires full-page content context. A missing `h1` or skipped level remains a deterministic finding.
- **Icon-only labels:** only when an unnamed control has no visible text and its product-specific purpose must be inferred from nearby UI or destination state.
- **Decorative classification:** only when deciding whether a visual adds unique meaning or merely reinforces adjacent content requires interpreting their visual relationship.

Use `routeContextualReview(...)` before any custom provider workflow. `proposeAccessibleLabelFix(...)` enforces the icon-label gate itself and does not call the provider when the case is routine or lacks bounded context.

## Trust model

1. A scanner or reviewer identifies an objective defect or ambiguous content decision.
2. The deterministic router confirms that visual meaning or broader page context is required.
3. The caller supplies only bounded UI context to a model provider.
4. The provider returns a suggestion, rationale, and confidence as structured data.
5. AEE emits a proposed patch with `safety: "review"`.
6. A person reviews and applies or rejects it.
7. A new scanner and interaction run verify the accepted change.

An AI suggestion never counts as proof and is never applied automatically.

## Palette-aware contrast repair

Contrast measurement and nearest-color selection do not require an LLM. `suggestPaletteContrastFix(...)` accepts a foreground, background, minimum ratio, and the project's existing named colors. It filters for passing colors, compares the remainder in OKLab space, and returns the closest token as a review-only proposal.

```ts
import { suggestPaletteContrastFix } from "@aee/ai-fixes";

const suggestion = suggestPaletteContrastFix({
  selector: ".secondary-copy",
  foreground: "#607a71",
  background: "#07110f",
  palette: [
    { name: "Text subtle", value: "#91aaa2" },
    { name: "Accent", value: "#70f0b4" }
  ]
});
```

The caller remains responsible for selecting the correct contrast threshold and reviewing the token in all component states.

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
