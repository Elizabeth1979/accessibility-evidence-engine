# Observer Lifecycle

## Current lifecycle

### 1. Run initialization

The caller resolves configuration, selected plugins, capture policy, release policy, environment metadata, checkpoint, and interaction. The run moves from `pending` to `running`.

### 2. Observer setup

Each selected observer receives the shared context. Network tracking, for example, attaches request and response listeners during setup. Setup runs concurrently across observers.

### 3. Before capture

Observers capture the baseline state for the interaction. Depending on the selected observers, this can include DOM, accessibility tree, focus, screenshot, or network evidence. Captures run concurrently within the phase.

### 4. Interaction execution

The Playwright adapter calls `performInteraction(...)`. Observers collect evidence but do not decide whether the action was accessible while it executes.

### 5. Stabilization

After the interaction resolves, `runAeeOnPage(...)` waits for `policy.capture.stabilizeAfterInteractionMs`. The current strategy is a fixed delay. It does not yet detect network idle, animation completion, or mutation silence.

The fixture CLI does not perform a live interaction and therefore does not add a stabilization wait.

### 6. After capture

Observers capture post-interaction state. DOM and network observers also derive simple change summaries from the before and after states.

### 7. Correlation

The engine sorts evidence records, collects unique artifact references, and builds an `EvidenceBundle` for the interaction and checkpoint.

### 8. Judgment and release policy

Non-release judges run concurrently against the normalized bundle. Release judges then receive those prior judgments and apply the configured severity, confidence, and unknown-result policy.

### 9. Teardown

Observer teardown runs in a `finally` block, including when execution fails. Network observers detach their page listeners here.

### 10. Reporting

After engine execution and teardown complete, the CLI or Playwright adapter validates applicable outputs and renders JSON and Markdown reports. When an output directory is configured, reports and raw artifacts are written below `<output-dir>/<run-id>/`.

## Observer contract

- Every observer declares a versioned manifest and capabilities.
- Capture results use explicit statuses such as `ok`, `unsupported`, `no_signal`, `observer_error`, and `timeout`.
- Large raw states can be attached as artifacts instead of embedded in evidence records.
- Judges receive normalized records and artifact references rather than direct page access.
- Network data is sanitized before artifact persistence, including logs from custom page adapters.

## Current limitations

The policy model declares `perObserverTimeoutMs` and `continueOnObserverError`, but the execution engine does not enforce those fields yet. Observer implementations convert many capture failures into `observer_error` records, while an unhandled setup, capture, or teardown exception can still reject the run.

DOM, accessibility-tree, focus, screenshot, and report output can contain sensitive page data. See [Evidence privacy](privacy.md) before sharing artifacts.
