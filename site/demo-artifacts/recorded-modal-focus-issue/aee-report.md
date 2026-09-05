# AEE Report

## Run Summary

| Field | Value |
| --- | --- |
| Schema version | 0.1.0 |
| Run ID | recorded-modal-focus-issue |
| Status | completed |
| Started | 2026-09-05T06:04:42.810Z |
| Finished | 2026-09-05T06:04:43.372Z |
| Environment mode | playwright-page |
| Policy | public-demo |
| Bundles | 1 |
| Evidence records | 6 |
| Judgments | 3 |
| Findings | 1 |
| Artifacts | 6 |
| Verdicts | pass 1, fail 2, unknown 0 |

## Triage

### Blocking Judgments

| Judge | Severity | Summary | Suggested Fix |
| --- | --- | --- | --- |
| release | high | Release gate failed because 1 blocking judgment met the current policy threshold. | Resolve the blocking accessibility judgments or relax the release policy intentionally. |
| focus-management | high | Dialog opened, but focus remained outside it. Before: button #delete-project "Delete Project Alpha". After: button #delete-project "Delete Project Alpha". | When the modal opens, move focus to an appropriate element inside it, such as its heading or least-destructive action. |

### Unresolved Signals

No unresolved judgments or observer gaps were detected.

### Suggested Fixes

- Resolve the blocking accessibility judgments or relax the release policy intentionally.
- When the modal opens, move focus to an appropriate element inside it, such as its heading or least-destructive action.

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
| Interaction ID | interaction:click:1788588282810 |
| Interaction | click |
| Target | button "Delete Project Alpha" |
| Checkpoint | public-demo-modal-focus-broken |
| URL | ./demo-fixture.html?label=fixed&focus=broken |
| Correlation strategy | observer-record-grouping |
| Participating observers | dom, focus, visual |
| Correlation notes | n/a |
| Records | 6 |
| Artifacts | 6 |
| Judgments | 3 |
| Findings | 1 |

### Evidence Records

| ID | Phase | Observer | Status | Confidence | Artifacts | Changes | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dom:before:1788588282812 | before | dom | ok | n/a | 1 | 0 | Captured DOM before state. |
| focus:before:1788588282812 | before | focus | ok | n/a | 1 | 0 | Captured focus before state (button #delete-project "Delete Project Alpha"). |
| visual:before:1788588282823 | before | visual | ok | n/a | 1 | 0 | Captured screenshot before state. |
| dom:after:1788588283342 | after | dom | ok | n/a | 1 | 1 | Captured DOM after state with observable markup changes. |
| focus:after:1788588283342 | after | focus | ok | n/a | 1 | 0 | Captured focus after state (button #delete-project "Delete Project Alpha"). |
| visual:after:1788588283362 | after | visual | ok | n/a | 1 | 0 | Captured screenshot after state. |

### Judgments

| ID | Verdict | Judge | Severity | Confidence | Evidence | Artifacts | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| focus-management:interaction:click:1788588282810 | fail | focus-management | high | 0.95 | 2 | 2 | Dialog opened, but focus remained outside it. Before: button #delete-project "Delete Project Alpha". After: button #delete-project "Delete Project Alpha". |
| change-response:interaction:click:1788588282810 | pass | change-response | info | 0.9 | 1 | 1 | Observed response signals after the click interaction (DOM changed). |
| release:interaction:click:1788588282810 | fail | release | high | 0.75 | 2 | 2 | Release gate failed because 1 blocking judgment met the current policy threshold. |

### Findings

| ID | Severity | Rule | Evidence | Artifacts | Message | Suggested Fix |
| --- | --- | --- | --- | --- | --- | --- |
| focus-management:interaction:click:1788588282810:dialog-focus-not-moved | high | dialog-initial-focus | 2 | 2 | The interaction opened a dialog but focus did not move inside it. | When the modal opens, move focus to an appropriate element inside it, such as its heading or least-destructive action. |

### Artifacts

| ID | Kind | Media Type | Path | Description |
| --- | --- | --- | --- | --- |
| dom:before:artifact | dom-snapshot | text/html | ./site/demo-artifacts/recorded-modal-focus-issue/artifacts/dom-before.html | n/a |
| focus:before:artifact | custom | application/json | ./site/demo-artifacts/recorded-modal-focus-issue/artifacts/focus-before.json | n/a |
| visual:before:artifact | screenshot | image/png | ./site/demo-artifacts/recorded-modal-focus-issue/artifacts/visual-before.png | n/a |
| dom:after:artifact | dom-snapshot | text/html | ./site/demo-artifacts/recorded-modal-focus-issue/artifacts/dom-after.html | n/a |
| focus:after:artifact | custom | application/json | ./site/demo-artifacts/recorded-modal-focus-issue/artifacts/focus-after.json | n/a |
| visual:after:artifact | screenshot | image/png | ./site/demo-artifacts/recorded-modal-focus-issue/artifacts/visual-after.png | n/a |
