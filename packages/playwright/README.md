# `@aee/playwright`

Playwright and virtual-page adapters for [Accessibility Evidence Engine](https://github.com/Elizabeth1979/accessibility-evidence-engine), including `runAeeOnPage(...)`.

The package also provides focused runtime probes:

- `comparePointerAndKeyboardOutcomes(...)` runs pointer and keyboard paths from the same reset state and compares caller-captured outcomes.
- `runInputComparison(...)` executes a user-authored pointer lane and keyboard lane in separate contexts with matching seeded browser storage and landing URLs, recaptures evidence after every declared action, and writes a schema-validated `interaction-trace.json`.
- `writeEvidenceManifest(...)` writes relative, SHA-256-indexed evidence with lane/action provenance and conservative privacy defaults; required omissions make the manifest partial.
- `aggregateEvidenceManifests(...)` verifies and re-hashes child-lane artifacts into one scenario-level manifest instead of trusting child checksums.
- `persistInteractionVideo(...)` finalizes a WebM lane recording with a schema-validated JSON action timeline and WebVTT captions.
- `verifyMotionControl(...)` requests a stop action and checks two later samples for zero active motion and a stable state.

These probes require explicit interaction, reset, and capture callbacks. They do not infer which controls should be equivalent or which motion is essential.

`runInputComparison(...)` and `runVirtualScreenReaderLane(...)` automatically record each active lane and write `video.webm`, `video.json`, `video.vtt`, and `manifest.json`. The manifest itself is not self-indexed because a file cannot contain a stable checksum of its own final bytes.

The consuming project provides Playwright. Generated evidence may contain sensitive page data; review the project's evidence-privacy guidance before sharing artifacts.

See the [Playwright integration guide](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/main/docs/playwright-integration.md) for examples and current limitations.
