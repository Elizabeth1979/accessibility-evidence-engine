# Accessibility report surface

This contract records the decision-oriented integrated report introduced for AEE. It applies only to
the generated HTML review surface; canonical evidence formats remain unchanged.

## Direction contract

**FORM seed:** `f94064e1` (`surface`, `operate`). The user’s explicit request pinned the composition,
so the seeded alternatives did not replace the requested status, visual-review, effort, conversation,
and annex structure.

**THESIS**

An accessibility triage room: the report should feel like a product review already in progress, not a
scanner export waiting to be interpreted.

**OWN-WORLD**

The world is an editorial review desk. Large decisive status language, evidence photography, compact
notations, ruled rows, and clear annotations turn captured browser states into an actionable review.
Decoration never substitutes for evidence.

**STORY**

The reviewer learns the scoped status, sees what passed and failed, gets the recommended fix order and
effort, compares the current evidence with a proposed change, and only then opens the technical annex.
The report can answer bounded questions from its own captured data at any point.

**FIRST VIEWPORT**

Show the scoped release decision without using a giant pass/fail score. Preserve the positive keyboard
and virtual-reader result beside confirmed issue count and focused effort. Keep “Ask this report” in
the same viewport, with an explicit local-evidence boundary.

**FORM**

- A compact report masthead names the assessed page and scope.
- Status and conversation share the decision area.
- A ruled health map describes tested experience areas in plain language.
- The fix review uses prioritized rows with current evidence, a proposed state, user impact, effort,
  video, and traceability controls.
- Technical DOM, accessibility-tree, focus, Axe, and raw artifacts live in the annex.
- Desktop rows become a linear mobile review without changing reading order or hiding evidence.

## Quality bar

The surface succeeds when a product owner can answer these within the first minute:

1. Is release blocked in the tested scope, and why?
2. Which tested experiences worked?
3. What should be fixed first?
4. What does the issue look like now, and what would change?
5. What is the focused implementation estimate?
6. Where is the proof behind the conclusion?

The visible finish must meet these criteria:

- affected regions are magnified or annotated rather than shown only as unreadable full-page thumbnails;
- proposed states are honest simulations, never falsely presented as implemented screenshots;
- display typography ships with the portable report and does not rely on the reviewer’s installed fonts;
- status language never becomes a universal accessibility percentage;
- conversational answers never exceed the authored test scope or upload evidence;
- all controls remain keyboard operable, screen-reader labeled, responsive, and free of serious or
  critical automated accessibility violations.
