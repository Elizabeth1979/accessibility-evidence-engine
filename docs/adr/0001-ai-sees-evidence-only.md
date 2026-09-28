# ADR 0001: AI sees evidence only, never the live page

**Status:** Accepted, 2026-09-27
**Origin:** accessibility-engine ADR 0002, carried over unchanged in spirit.

## Context

AI helps word fixes: a name for an icon-only button, a text alternative for an image. A model that could reach the live page could act on it (click, type, submit), and its answer could not be replayed or checked against anything.

## Decision

The AI package, `@aee/ai-fixes`, reads only evidence the engine has already captured and hands to it. It depends on `@aee/core` and a model SDK, never on a browser driver.

- **Captured first.** `@aee/playwright` records what a specialist needs with the axe result (the nearest heading in the element's section, the text around it, icon and image markup, a link's destination), and only for rules whose registry concept has a specialist.
- **Cited.** Every answer names the evidence fields it relies on (`citedEvidenceIds`). An answer that cites a field it was not given is rejected.
- **Sent only when asked.** `aee run` sends page evidence to a model only when `AEE_LLM_PROVIDER` names one. An API key that happens to be set is not consent.

## How it is enforced

- `scripts/graph-guard.test.mjs`, in `npm run test:unit`, fails when a package's dependencies differ from the graph in [architecture.md](../architecture.md), when a package imports something it does not declare, or when any package outside `@aee/playwright` and the packages built on it can reach a browser driver.
- `packages/ai-fixes/src/specialists.ts` checks every answer against the evidence it was given.
- `aeeRunModelProvider` in `packages/cli/src/scenario-runner.ts` returns the stub unless `AEE_LLM_PROVIDER` is set, and a unit test holds it to that.

## Consequences

- An AI answer can be checked against the evidence in the report it appears in.
- When the evidence lacks something, the answer says so rather than looking for it. The image specialist, for example, does not see the image yet (parked in the master plan's Later list).
- Capture has to record enough context up front: a specialist cannot ask for more.
- **Changed from the original:** in accessibility-engine the AI also judged. Here it only suggests; see [ADR 0003](0003-verdicts-are-deterministic.md).
