# `@aee/playwright`

Playwright and virtual-page adapters for [Accessibility Evidence Engine](https://github.com/Elizabeth1979/accessibility-evidence-engine), including `runAeeOnPage(...)`.

The package also provides focused runtime probes:

- `comparePointerAndKeyboardOutcomes(...)` runs pointer and keyboard paths from the same reset state and compares caller-captured outcomes.
- `verifyMotionControl(...)` requests a stop action and checks two later samples for zero active motion and a stable state.

These probes require explicit interaction, reset, and capture callbacks. They do not infer which controls should be equivalent or which motion is essential.

The consuming project provides Playwright. Generated evidence may contain sensitive page data; review the project's evidence-privacy guidance before sharing artifacts.

See the [Playwright integration guide](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/main/docs/playwright-integration.md) for examples and current limitations.
