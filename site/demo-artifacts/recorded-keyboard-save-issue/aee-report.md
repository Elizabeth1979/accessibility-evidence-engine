# AEE Report

## Run Summary

| Field | Value |
| --- | --- |
| Schema version | 0.1.0 |
| Run ID | recorded-keyboard-save-issue |
| Status | completed |
| Started | 2026-08-31T18:59:38.482Z |
| Finished | 2026-08-31T18:59:39.077Z |
| Environment mode | playwright-page |
| Policy | public-demo |
| Bundles | 1 |
| Evidence records | 6 |
| Judgments | 3 |
| Findings | 2 |
| Artifacts | 6 |
| Verdicts | pass 0, fail 3, unknown 0 |

## Triage

### Blocking Judgments

| Judge | Severity | Summary | Suggested Fix |
| --- | --- | --- | --- |
| release | high | Release gate failed because 2 blocking judgments met the current policy threshold. | Resolve the blocking accessibility judgments or relax the release policy intentionally. |
| change-response | high | No observable response followed the enter interaction on button "Save changes". | Ensure the enter interaction activates the target and produces an observable response such as DOM, focus, or network activity. |
| keyboard | high | Keyboard enter produced no observable activation response for button #real-save "Save changes". | Ensure enter activates the focused control and produces an observable response. |

### Unresolved Signals

No unresolved judgments or observer gaps were detected.

### Suggested Fixes

- Resolve the blocking accessibility judgments or relax the release policy intentionally.
- Ensure the enter interaction activates the target and produces an observable response such as DOM, focus, or network activity.
- Ensure enter activates the focused control and produces an observable response.

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

## Bundle 1: `enter` on button "Save changes"

| Field | Value |
| --- | --- |
| Interaction ID | interaction:enter:1788202778482 |
| Interaction | enter |
| Target | button "Save changes" |
| Checkpoint | public-demo-broken |
| URL | http://127.0.0.1:4173/?recording=1&implementation=broken |
| Correlation strategy | observer-record-grouping |
| Participating observers | dom, focus, visual |
| Correlation notes | n/a |
| Records | 6 |
| Artifacts | 6 |
| Judgments | 3 |
| Findings | 2 |

### Evidence Records

| ID | Phase | Observer | Status | Confidence | Artifacts | Changes | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dom:before:1788202778485 | before | dom | ok | n/a | 1 | 0 | Captured DOM before state. |
| focus:before:1788202778486 | before | focus | ok | n/a | 1 | 0 | Captured focus before state (button #real-save "Save changes"). |
| visual:before:1788202778525 | before | visual | ok | n/a | 1 | 0 | Captured screenshot before state. |
| dom:after:1788202779032 | after | dom | ok | n/a | 1 | 1 | Captured DOM after state with no observable markup changes. |
| focus:after:1788202779033 | after | focus | ok | n/a | 1 | 0 | Captured focus after state (button #real-save "Save changes"). |
| visual:after:1788202779069 | after | visual | ok | n/a | 1 | 0 | Captured screenshot after state. |

### Judgments

| ID | Verdict | Judge | Severity | Confidence | Evidence | Artifacts | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| keyboard:interaction:enter:1788202778482 | fail | keyboard | high | 0.9 | 2 | 2 | Keyboard enter produced no observable activation response for button #real-save "Save changes". |
| change-response:interaction:enter:1788202778482 | fail | change-response | high | 0.9 | 4 | 4 | No observable response followed the enter interaction on button "Save changes". |
| release:interaction:enter:1788202778482 | fail | release | high | 0.75 | 4 | 4 | Release gate failed because 2 blocking judgments met the current policy threshold. |

### Findings

| ID | Severity | Rule | Evidence | Artifacts | Message | Suggested Fix |
| --- | --- | --- | --- | --- | --- | --- |
| keyboard:interaction:enter:1788202778482:activation-no-response | high | keyboard-activation-response | 2 | 2 | Expected enter to activate the focused control, but no focus, DOM, or network response was observed. | Ensure enter activates the focused control and produces an observable response. |
| change-response:interaction:enter:1788202778482:no-response | high | interaction-response-observable | 4 | 4 | Expected enter to trigger a visible, focus, or network response, but no supported observer detected one. | Ensure the enter interaction activates the target and produces an observable response such as DOM, focus, or network activity. |

### Artifacts

| ID | Kind | Media Type | Path | Description |
| --- | --- | --- | --- | --- |
| dom:before:artifact | dom-snapshot | text/html | ./site/demo-artifacts/recorded-keyboard-save-issue/artifacts/dom-before.html | n/a |
| focus:before:artifact | custom | application/json | ./site/demo-artifacts/recorded-keyboard-save-issue/artifacts/focus-before.json | n/a |
| visual:before:artifact | screenshot | image/png | ./site/demo-artifacts/recorded-keyboard-save-issue/artifacts/visual-before.png | n/a |
| dom:after:artifact | dom-snapshot | text/html | ./site/demo-artifacts/recorded-keyboard-save-issue/artifacts/dom-after.html | n/a |
| focus:after:artifact | custom | application/json | ./site/demo-artifacts/recorded-keyboard-save-issue/artifacts/focus-after.json | n/a |
| visual:after:artifact | screenshot | image/png | ./site/demo-artifacts/recorded-keyboard-save-issue/artifacts/visual-after.png | n/a |
