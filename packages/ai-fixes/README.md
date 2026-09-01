# `@aee/ai-fixes`

Review-only AI repair proposals grounded in captured accessibility context.

The package does not apply patches automatically. A model proposes a label and rationale, AEE marks the resulting patch as requiring review, and a fresh evidence run must verify the accepted change.

The OpenAI Responses provider requires the caller to supply an API key and model explicitly. Applications can inject another provider implementing the same interface.
