# ADR 0002: axe-core is the floor, not the product

**Status:** Accepted, 2026-09-27
**Origin:** accessibility-engine ADR 0003, carried over with a different product on top.

## Context

axe-core decides its rules reliably and cheaply: a missing name, a missing alt, a contrast ratio, invalid ARIA. Re-implementing those rules would waste effort, and AI adds nothing to them.

## Decision

Pinned axe-core (4.13) runs at every checkpoint, and its failures block release. The one exception is a rule axe tags as best practice with no WCAG tag: it is reported as advisory ("Best practice") and never blocks release. AEE does not re-implement axe rules.

AEE's own value sits on top of that floor:

- interaction evidence axe cannot see, taken at the same checkpoint: the keyboard and pointer sweep, focus movement, and the virtual screen reader;
- correlation of that evidence into one finding per problem, with its WCAG criteria and a11y-skills pattern;
- allowlisted AI where the wording of a fix depends on context ([ADR 0001](0001-ai-sees-evidence-only.md)).

## Consequences

- Upgrading axe is a deliberate change: the test lab's known answers must still hold.
- axe runs through `@aee/playwright` (`@axe-core/playwright`), and the axe observer in `@aee/observers` records its results; `@aee/core` never depends on it.
- An axe finding takes its WCAG criteria from axe's own tags. The remediation registry joins the rule to a concept, its a11y-skills pattern and its AI stance.
- **Changed from the original:** in accessibility-engine the product on top of axe was AI quality judging. Here it is correlated interaction evidence first and AI suggestions second.
