# ADR 0005: The remediation registry follows the ACT Rules Format's shape

**Status:** Accepted, 2026-09-27
**Origin:** new; the master plan names it with the carried-over ADRs.

## Context

Each concept in `packages/schemas/json/remediation-registry.json` joins WCAG criteria, axe rules, the evidence it needs, the AI allowlist, verification steps and an a11y-skills pattern. The W3C's [ACT Rules Format](https://www.w3.org/TR/act-rules-format/) is the shared shape for writing accessibility test rules, so that different tools reach the same outcome on the same content.

## Decision

Each registry entry mirrors the parts of an ACT rule:

| ACT Rules Format                                                                  | Registry                                                                                                    |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Unique identifier and rule name                                                   | `id`, `title`                                                                                               |
| Accessibility requirements mapping                                                | `requirements`, each marked `primary`, `secondary` or `detection` (the axe rules that detect it)            |
| Input aspects                                                                     | `requiredEvidence`                                                                                          |
| Applicability                                                                     | `applicability`                                                                                             |
| Expectations                                                                      | `deterministicDetection` and `verification`                                                                 |
| Test cases                                                                        | the test lab's known answers, `site/test-lab-contract.json`: a page with the issues and the same page fixed |
| Outcomes: passed, failed, inapplicable (implementation reports add "cannot tell") | pass, fail, no finding, unknown; unknown is never a pass                                                    |

The registry adds what ACT does not cover: `ai` (the allowlist and its specialist), `patterns` (a11y-skills) and `implementationStatus`.

`ruleKind` says how far an entry has got. Every entry is `aee-act-compatible` today. `act-rule` is kept for an entry that meets the format in full: written expectations for each test target, assumptions, accessibility support notes, and ACT-style test cases with expected outcomes. Until then AEE does not call its rules ACT rules, as [evidence-run-layout.md](../evidence-run-layout.md) already says.

## Consequences

- A new concept fills the same parts, and its known answers go into the test lab.
- Graduating an entry to an ACT rule adds parts; it changes none.
- AEE's outcomes can be written as an ACT implementation report later without re-mapping them.
