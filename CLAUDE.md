# CLAUDE.md

**Start here for toolkit work:** `docs/MASTER-PLAN.md` is the plan for consolidating all the accessibility repos into this engine. When asked to "continue the master plan", do the first unchecked step, tick it in the same PR, and log any decision there.

Product principles live in `PRODUCT.md`, the architecture in `docs/architecture.md`, and engine milestones in `docs/implementation-roadmap.md`.

## Before pushing

Run what CI runs: `npm run check`, `npm run format:check`, `npm run site:check`, `npm run lint`, `npm run test:unit`, and `npm run test:playwright` for browser changes.

## Rules

- No credentials, personal data, or proprietary page evidence anywhere in the repo, issues or PRs (see `CONTRIBUTING.md`). Examples must be generic.
- Deterministic detection first. AI only for registry-allowlisted cases, always labelled as AI, and it never passes or fails anything on its own.
