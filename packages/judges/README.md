# `@aee/judges`

Structure, keyboard, focus-management, change-response, and release-policy judges for [Accessibility Evidence Engine](https://github.com/Elizabeth1979/accessibility-evidence-engine).

The focus-management judge verifies explicit `inside-dialog`, `preserve`, and `target` expectations using deep focus evidence captured before and after an interaction.

The keyboard judge evaluates only user-authored actions. It applies a bounded role-aware Enter/Space activation matrix and an orientation-aware composite navigation matrix, using deep focus and observable response evidence. Unsupported or context-dependent key combinations return `unknown` instead of being reported as failures.

The structure judge currently checks evidence completeness rather than full document structure, and a passing result is not WCAG certification.

See the [project README](https://github.com/Elizabeth1979/accessibility-evidence-engine#readme) for the capability matrix and limitations.
