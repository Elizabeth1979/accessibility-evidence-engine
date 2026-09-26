# CLAUDE.md

**Start here for toolkit work:** `docs/MASTER-PLAN.md` is the plan for consolidating all the accessibility repos into this engine. When asked to "continue the master plan", do the first unchecked step, tick it in the same PR, and log any decision there.

Product principles live in `PRODUCT.md`, the architecture in `docs/architecture.md`, and engine milestones in `docs/implementation-roadmap.md`.

## Before pushing

Run what CI runs: `npm run check`, `npm run format:check`, `npm run site:check`, `npm run lint`, `npm run test:unit`, and `npm run test:playwright` for browser changes.

## Rules

- No credentials, personal data, or proprietary page evidence anywhere in the repo, issues or PRs (see `CONTRIBUTING.md`). Examples must be generic.
- Deterministic detection first. AI only for registry-allowlisted cases, always labelled as AI, and it never passes or fails anything on its own.

## Working with the owner

- **Show, don't describe.** Send the owner what you see in the browser as you go. A screenshot (desktop and phone) for how a page looks; a video for anything that happens over time: keyboard tab stops, a screen reader reading the page, clicks and state changes. A screenshot plus a transcript is not enough there. `screen-reader-cli audit --record` makes the screen-reader video. The owner reads screenshots and videos, not code.
- **Say what you're on.** Before each piece of work, one short line: which page or file, and what you're changing in it. After it, one line on the result.
- **Test our own pages like a user, and report exactly what ran.** For any page change: axe in every state (default and all expanded, desktop and phone), a keyboard pass (tab order, visible focus, every control works) and a virtual screen-reader pass with `screen-reader-cli` (`audit file:///…`). Say what ran and what it cannot catch. axe "needs review" is not a pass; the gradient background makes axe skip colour contrast, so check the contrast ratios by hand. Never say "no accessibility issues"; say "axe found no violations in these states".
