# CLAUDE.md

**Start here for toolkit work:** `docs/MASTER-PLAN.md` is the plan for consolidating all the accessibility repos into this engine. When asked to "continue the master plan", do the first unchecked step, tick it in the same PR, and log any decision there.

Product principles live in `PRODUCT.md`, the architecture in `docs/architecture.md`, and engine milestones in `docs/implementation-roadmap.md`.

## Before pushing

Run what CI runs: `npm run check`, `npm run format:check`, `npm run site:check`, `npm run lint`, `npm run test:unit`, and `npm run test:playwright` for browser changes.

## Rules

- No credentials, personal data, or proprietary page evidence anywhere in the repo, issues or PRs (see `CONTRIBUTING.md`). Examples must be generic.
- High-quality code only: fix the root cause with the idiomatic solution. No workarounds or patches — no suppressions (`eslint-disable`, `@ts-ignore`, skipped tests), no copy-paste; reuse what exists (DRY). If the proper fix is out of scope, say so and record it rather than patching around it.
- Deterministic detection first. AI only for registry-allowlisted cases, always labelled as AI, and it never passes or fails anything on its own.

## Working with the owner

- **Show, don't describe.** Send the owner what you see in the browser as you go. A screenshot (desktop and phone) for how a page looks; a video for anything that happens over time: keyboard tab stops, a screen reader reading the page, clicks and state changes. A screenshot plus a transcript is not enough there. `screen-reader-cli audit --record` makes the screen-reader video. The owner reads screenshots and videos, not code.
- **Say what you're on.** Before each piece of work, one short line: which page or file, and what you're changing in it. After it, one line on the result. Every change the owner is told about comes with a GitHub link to each changed file (and the PR), so she sees the code, not a description of it.
- **Test our own pages like a user, and report exactly what ran.** For any page change: axe in every state (default and all expanded, desktop and phone), a keyboard pass with no screen reader running (the keyboard as an input device: every mouse target is a tab stop, including anything that reacts to hover; tab order follows the visual order; focus is visible; every mouse interaction gives the same result by keyboard) and a virtual screen-reader pass with `screen-reader-cli` (`audit file:///…`). Say what ran and what it cannot catch. axe "needs review" is not a pass; the gradient background makes axe skip colour contrast, so check the contrast ratios by hand. Never say "no accessibility issues"; say "axe found no violations in these states". For every finding, say how it was found (tool output, visual, design, DOM or accessibility tree) and the reasoning; `packages/ai-fixes/prompts/accessibility-engineer.md` is that method (find, fix, re-test).
