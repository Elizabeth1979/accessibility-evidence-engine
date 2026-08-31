# AEE Report

## Run Summary

| Field | Value |
| --- | --- |
| Schema version | 0.1.0 |
| Run ID | recorded-keyboard-save |
| Status | completed |
| Started | 2026-08-31T17:25:26.417Z |
| Finished | 2026-08-31T17:25:27.209Z |
| Environment mode | playwright-page |
| Policy | public-demo |
| Bundles | 1 |
| Evidence records | 8 |
| Judgments | 3 |
| Findings | 0 |
| Artifacts | 8 |
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
| accessibility-tree | 2 | 2 | 0 | 0 | 0 | 0 | 2 |
| dom | 2 | 2 | 0 | 0 | 0 | 0 | 2 |
| focus | 2 | 2 | 0 | 0 | 0 | 0 | 2 |
| visual | 2 | 2 | 0 | 0 | 0 | 0 | 2 |

## Artifact Summary

| Kind | Count |
| --- | --- |
| accessibility-tree | 2 |
| custom | 2 |
| dom-snapshot | 2 |
| screenshot | 2 |

## Bundle 1: `enter` on button "Save changes"

| Field | Value |
| --- | --- |
| Interaction ID | interaction:enter:1788197126416 |
| Interaction | enter |
| Target | button "Save changes" |
| Checkpoint | public-demo-save |
| URL | http://127.0.0.1:4173/?recording=1 |
| Correlation strategy | observer-record-grouping |
| Participating observers | dom, focus, accessibility-tree, visual |
| Correlation notes | n/a |
| Records | 8 |
| Artifacts | 8 |
| Judgments | 3 |
| Findings | 0 |

### Evidence Records

| ID | Phase | Observer | Status | Confidence | Artifacts | Changes | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dom:before:1788197126426 | before | dom | ok | n/a | 1 | 0 | Captured DOM before state. |
| focus:before:1788197126426 | before | focus | ok | n/a | 1 | 0 | Captured focus before state (button #real-save "Save changes"). |
| accessibility-tree:before:1788197126439 | before | accessibility-tree | ok | n/a | 1 | 0 | Captured accessibility tree before state. |
| visual:before:1788197126457 | before | visual | ok | n/a | 1 | 0 | Captured screenshot before state. |
| dom:after:1788197127169 | after | dom | ok | n/a | 1 | 1 | Captured DOM after state with observable markup changes. |
| focus:after:1788197127169 | after | focus | ok | n/a | 1 | 0 | Captured focus after state (button #real-save "Save changes"). |
| accessibility-tree:after:1788197127181 | after | accessibility-tree | ok | n/a | 1 | 0 | Captured accessibility tree after state. |
| visual:after:1788197127201 | after | visual | ok | n/a | 1 | 0 | Captured screenshot after state. |

### Judgments

| ID | Verdict | Judge | Severity | Confidence | Evidence | Artifacts | Summary |
| --- | --- | --- | --- | --- | --- | --- | --- |
| keyboard:interaction:enter:1788197126416 | pass | keyboard | info | 0.9 | 1 | 1 | Keyboard enter produced observable activation signals (DOM changed). Focus stayed on button #real-save "Save changes". |
| change-response:interaction:enter:1788197126416 | pass | change-response | info | 0.9 | 1 | 1 | Observed response signals after the enter interaction (DOM changed). |
| release:interaction:enter:1788197126416 | pass | release | info | 0.75 | 8 | 0 | Release gate passed. No blocking judgments met the current policy threshold. |

### Findings

No findings were emitted for this bundle.

### Artifacts

| ID | Kind | Media Type | Path | Description |
| --- | --- | --- | --- | --- |
| dom:before:artifact | dom-snapshot | text/html | ./site/demo-artifacts/recorded-keyboard-save/artifacts/dom-before.html | n/a |
| focus:before:artifact | custom | application/json | ./site/demo-artifacts/recorded-keyboard-save/artifacts/focus-before.json | n/a |
| accessibility-tree:before:artifact | accessibility-tree | application/json | ./site/demo-artifacts/recorded-keyboard-save/artifacts/accessibility-tree-before.json | n/a |
| visual:before:artifact | screenshot | image/png | ./site/demo-artifacts/recorded-keyboard-save/artifacts/visual-before.png | n/a |
| dom:after:artifact | dom-snapshot | text/html | ./site/demo-artifacts/recorded-keyboard-save/artifacts/dom-after.html | n/a |
| focus:after:artifact | custom | application/json | ./site/demo-artifacts/recorded-keyboard-save/artifacts/focus-after.json | n/a |
| accessibility-tree:after:artifact | accessibility-tree | application/json | ./site/demo-artifacts/recorded-keyboard-save/artifacts/accessibility-tree-after.json | n/a |
| visual:after:artifact | screenshot | image/png | ./site/demo-artifacts/recorded-keyboard-save/artifacts/visual-after.png | n/a |
