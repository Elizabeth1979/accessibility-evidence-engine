# `@aee/ai-fixes`

Deterministic-first routing and review-only AI repair proposals grounded in captured accessibility context.

The package also exports `suggestPaletteContrastFix(...)`. It calculates contrast and OKLab color distance deterministically, considers only caller-supplied design tokens, and returns the closest passing token as a review-only proposal. It does not call an LLM for math that can be reproduced exactly.

AI review is allowlisted for semantic heading structure, icon-only labels, and decorative-versus-informative classification. Routine rule failures do not invoke a provider.

The package does not apply patches automatically. A model proposes a label and rationale, AEE marks the resulting patch as requiring review, and a fresh evidence run must verify the accepted change.

The OpenAI Responses provider requires the caller to supply an API key and model explicitly. Applications can inject another provider implementing the same interface.
