# ADR 0006: Checks are measured per family, with their sample size, and "can't tell" is never a pass

**Status:** Accepted, 2026-11-18
**Origin:** new; from the 2026-11-14 technical improvement plan, workstream one, as the [master plan's decisions log](../MASTER-PLAN.md#decisions-log) trimmed it into M11 on 2026-11-15.

## Context

The test lab holds one known answer per issue: 14 issues in `site/test-lab-contract.json`, each on the lab page and fixed on its twin, across 10 registry concepts. That proves each check finds its own bug. It does not say how often a check finds a bug of its kind, or how often it reports one that is not there.

One score across all checks would hide that. If AEE found 13 of the lab's 14 issues, "93%" would read as good even if the one it missed was half of a family it handles badly. A rate on few cases also says little: at 20 cases a 95% interval is about 30 points wide (decisions log, 2026-11-15).

AEE already keeps "can't tell" apart from pass. Judgments are `pass`, `fail` or `unknown` (`common.schema.json`). An evidence record's capture is `ok`, `unsupported`, `no_signal`, `observer_error` or `timeout` (`evidence-record.schema.json`). A report row that cannot be decided reads "Needs review". [ADR 0003](0003-verdicts-are-deterministic.md) and the [architecture's invariants](../architecture.md#key-invariants) keep unknown, unsupported capture and observer errors apart from pass and fail. Measuring AEE's checks has to keep that too, or a check that gives up would look as good as one that is right.

## Decision

### 1. Results are per check family, each with its sample size

A check family is a group of bugs of one kind that one check looks for, for example accessible names or status messages. Families start from the registry concepts AEE has, and step 11.2 records each case's family.

Every measure of AEE's checks gives each family on its own, beside its sample size: the cases with a known bug, and the clean or inapplicable cases without one. This covers the eval output, CI, the benchmark page and the README. For example:

> Accessible names: found 18 of 20 known bugs, 1 false alarm on 20 clean pages, 1 undecided. n = 20 + 20.

There is no overall score, percentage or grade across families, and one family's rates are never averaged with another's. A count of cases may be totalled; a rate may not. A family with fewer than 20 cases shows its counts and "insufficient data", not a percentage, as step 11.3 sets.

### 2. `unknown`, `unsupported` and "needs review" never count as a pass

This holds on every surface and in every measure. An observer error or timeout is not a pass either: step 13.1 keeps infrastructure errors apart from accessibility results, and step 12.1 does the same for real screen readers.

When a case's outcome is one of these:

- **on a case with a known bug**, it is a miss: it counts against "found";
- **on a clean or inapplicable case**, it is neither a correct pass nor a false alarm. It is counted in an "undecided" column, shown for every family, so a check that often cannot decide shows it.

An AI specialist's answer is a suggestion, never a judge's outcome ([ADR 0003](0003-verdicts-are-deterministic.md)). It is scored on its own in the same runner (step 11.6), and never makes a case pass.

### 3. No new judge or concept lands without its benchmark cases

A new judge, or a new registry concept, comes in the same pull request as its benchmark cases. Each bug of its kind needs at least one case with the bug and one clean or inapplicable twin, in the case format step 11.2 defines. That is the same pair every check has had in the lab so far. A family then says "insufficient data" until it has 20 cases, and grows by mutation (step 11.5).

Each case's expected outcome is written with the case and never taken from a judge, so changing a judge cannot change what counts as right (step 11.2). Until step 11.2 lands, a lab issue with its fixed twin is the case ([ADR 0005](0005-registry-follows-act-rules-format.md)).

## Words

This record uses AEE's outcome words as they are today: `pass`, `fail` and `unknown` for judgments, `unsupported` for capture, "Needs review" in report rows, and ADR 0005's "no finding" for a case where nothing applies. Step 13.1 replaces them with one set (`passed`, `failed`, `inapplicable`, `unknown`, "needs review" and `unsupported`) on every surface. The rules here apply to both sets.

## How it is carried out

| Step | What it does for this decision                                                                                                                                          |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 11.2 | Each lab issue becomes a case with its family, expected outcome and expected element, on its own generated page; a case with a missing field fails validation.          |
| 11.3 | `npm run eval` writes a confusion matrix per family with intervals, and "insufficient data" under 20 cases; its unit tests cover empty families and `unknown` outcomes. |
| 11.4 | CI compares each case with the committed baseline and fails naming the cases and families that changed, never with only a total.                                        |
| 11.5 | Mutation operators grow four families to n ≥ 20 both ways.                                                                                                              |
| 11.6 | AI specialists are scored in the same runner, every attempt kept, apart from the judges.                                                                                |
| 11.7 | The benchmark page per release shows families, sample sizes, intervals, misses and what is not covered.                                                                 |
| 12.1 | Real-reader outcomes keep `unsupported` and `infrastructureError` apart from `failed`, and a required reader that did not run is never a pass.                          |
| 13.1 | One set of outcome words on every surface, with infrastructure errors apart.                                                                                            |

Gates compare each case with a baseline rather than fixed thresholds such as 90% and 5%, which at 20 cases would sit inside the interval (decisions log, 2026-11-15).

## Consequences

- A report says "Accessible names: found 18 of 20 known bugs, 1 false alarm, n = 20", never "AEE: 91%".
- A check that answers "can't tell" more often looks worse, not better: its misses and its undecided count show.
- Small families say "insufficient data" until they grow, instead of a percentage that would mislead.
- A new check costs more to add: its cases come first. The Forms and single-page app families start this way (steps 11.8 to 11.11).
