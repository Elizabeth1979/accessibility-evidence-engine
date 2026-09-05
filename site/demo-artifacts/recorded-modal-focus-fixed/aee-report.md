# AEE Report

## Run Summary

| Field | Value |
| --- | --- |
| Schema version | 0.1.0 |
| Run ID | recorded-modal-focus-fixed |
| Status | completed |
| Started | 2026-09-05T06:04:43.440Z |
| Finished | 2026-09-05T06:04:43.990Z |
| Environment mode | playwright-page |
| Policy | public-demo |
| Bundles | 1 |
| Evidence records | 6 |
| Judgments | 3 |
| Findings | 0 |
| Artifacts | 6 |
| Verdicts | pass 3, fail 0, unknown 0 |

## Triage

No blocking judgments were detected.

### Unresolved Signals

No unresolved judgments or observer gaps were detected.

### Suggested Fixes

No explicit suggested fixes were emitted.

## Observer Coverage

| Observer | Records | OK | Unsupported | No Signal | Observer Error | Timeout | Artifacts |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dom | 2 | 2 | 0 | 0 | 0 | 0 | 2 |
| focus | 2 | 2 | 0 | 0 | 0 | 0 | 2 |
| visual | 2 | 2 | 0 | 0 | 0 | 0 | 2 |

## Artifact Summary

| Kind | Count |
| --- | --- |
| custom | 2 |
| dom-snapshot | 2 |
| screenshot | 2 |

## Bundle 1: `click` on button "Delete Project Alpha"

| Field | Value |
| --- | --- |
| Interaction ID | interaction:click:1788588283440 |
| Interaction | click |
| Target | button "Delete Project Alpha" |
| Checkpoint | public-demo-modal-focus-fixed |
| URL | ./demo-fixture.html?label=fixed&focus=fixed |
| Correlation strategy | observer-record-grouping |
| Participating observers | dom, focus, visual |
| Correlation notes | n/a |
| Records | 6 |
| Artifacts | 6 |
| Judgments | 3 |
| Findings | 0 |

### Evidence Records

| ID | Phase | Observer | Status | Confidence | Artifacts | Changes | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dom:before:1788588283441 | before | dom | ok | n/a | 1 | 0 | Captured DOM before state. |
| focus:before:1788588283442 | before | focus | ok | n/a | 1 | 0 | Captured focus before state (button #delete-project "Delete Project Alpha"). |
| visual:before:1788588283456 | before | visual | ok | n/a | 1 | 0 | Captured screenshot before state. |
| dom:after:1788588283976 | after | dom | ok | n/a | 1 | 1 | Captured DOM after state with observable markup changes. |
| focus:after:1788588283976 | after | focus | ok | n/a | 1 | 0 | Captured focus after state (button #cancel-delete "Cancel"). |
| visual:after:1788588283989 | after | visual | ok | n/a | 1 | 0 | Captured screenshot after state. |

### Judgments

| ID | Verdict | Judge | Severity | Confidence | Evidence | Artifacts | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| focus-management:interaction:click:1788588283440 | pass | focus-management | info | 0.95 | 2 | 2 | Focus moved from button #delete-project "Delete Project Alpha" to button #cancel-delete "Cancel" inside the opened dialog "Delete Project Alpha?". |
| change-response:interaction:click:1788588283440 | pass | change-response | info | 0.9 | 3 | 3 | Observed response signals after the click interaction (DOM changed, focus moved). |
| release:interaction:click:1788588283440 | pass | release | info | 0.75 | 6 | 0 | Release gate passed. No blocking judgments met the current policy threshold. |

### Findings

No findings were emitted for this bundle.

### Artifacts

| ID | Kind | Media Type | Path | Description |
| --- | --- | --- | --- | --- |
| dom:before:artifact | dom-snapshot | text/html | ./site/demo-artifacts/recorded-modal-focus-fixed/artifacts/dom-before.html | n/a |
| focus:before:artifact | custom | application/json | ./site/demo-artifacts/recorded-modal-focus-fixed/artifacts/focus-before.json | n/a |
| visual:before:artifact | screenshot | image/png | ./site/demo-artifacts/recorded-modal-focus-fixed/artifacts/visual-before.png | n/a |
| dom:after:artifact | dom-snapshot | text/html | ./site/demo-artifacts/recorded-modal-focus-fixed/artifacts/dom-after.html | n/a |
| focus:after:artifact | custom | application/json | ./site/demo-artifacts/recorded-modal-focus-fixed/artifacts/focus-after.json | n/a |
| visual:after:artifact | screenshot | image/png | ./site/demo-artifacts/recorded-modal-focus-fixed/artifacts/visual-after.png | n/a |
