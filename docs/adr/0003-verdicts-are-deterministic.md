# ADR 0003: Verdicts are deterministic; AI sits beside them

**Status:** Accepted, 2026-09-27
**Origin:** accessibility-engine ADR 0004 ("a judge is a deterministic floor plus an AI judgment"), changed.

## Context

accessibility-engine let an AI judgment return FAIL, for example when an image has alt text that says nothing useful. That catches "the rule passes but the quality fails", which no static rule can. It also means a model's opinion decides whether a build passes.

## Decision

In AEE, judges are deterministic and read evidence only. They alone produce pass, fail and unknown, and the release judge alone decides release.

AI specialists run only for concepts the remediation registry allowlists. Their answers are suggestions, shown labelled "AI suggestion". They never change a judgment, a status row or the verdict.

Kept from the original: an unknown or advisory result never becomes a pass. Missing, unsupported or contradictory evidence stays unknown.

## How it is enforced

- The rule in the repository's `CLAUDE.md`: AI only for registry-allowlisted cases, always labelled as AI, and it never passes or fails anything on its own.
- The report writes AI answers into `remediation.ai` only. The test lab's done-when test for step 3.3 asserts that the page still fails while it shows the AI's name for the archive button.

## Consequences

- A build never passes or fails on a model's say.
- "Present but meaningless" names and alternatives are not failed automatically. They surface as AI suggestions for a person to judge.
- When a quality check can be made deterministic, it becomes a judge instead. Step 3.5 does this for text that looks like a heading but is not one, and for hover content with no focus equivalent.
