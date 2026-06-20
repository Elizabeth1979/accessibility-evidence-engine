# Observer Lifecycle

## Lifecycle phases

### 1. Run start

The engine resolves configuration, plugin manifests, release policy, and environment metadata. Observers can perform lightweight setup here, but not page capture.

### 2. Checkpoint before action

The engine can request a stable page snapshot before an interaction or assertion boundary. This is optional, but useful for initial page state and debugging.

### 3. Interaction before-capture

Observers registered for `before` capture gather baseline state. Examples include DOM snapshots, accessibility tree snapshots, focus location, and screenshot artifacts.

### 4. Interaction execution

The interaction engine performs the action. Observers do not decide whether the action was accessible during this step.

The current Playwright adapter exposes this as `performInteraction(...)`, which lets a test run a real action such as `page.keyboard.press("Tab")` between the `before` and `after` capture phases.

### 5. Interaction after-capture

Observers registered for `after` capture gather post-action state. This is the main phase used for change detection.

### 6. Stabilization

The engine optionally waits for configured settling conditions such as network quiet, animation completion, or mutation silence. This is necessary to reduce false negatives for dynamic interfaces.

### 7. Correlation

The engine converts raw evidence records into a normalized `EvidenceBundle` keyed by interaction, observer, and artifact identifiers.

### 8. Judgment

Judges read only the normalized bundle and emit judgments and findings. They should not directly query DOM APIs.

### 9. Reporting and fixes

Reporters render the run output. Fix providers can propose remediation plans grounded in the same evidence IDs.

### 10. Teardown

Observers release handles, flush buffers, and publish final diagnostics.

## Observer contract expectations

- Every observer must declare its capabilities.
- Every observer must surface explicit `status`.
- Every observer may attach artifacts instead of inlining large payloads.
- Observer errors should not abort the entire run unless policy explicitly demands it.
