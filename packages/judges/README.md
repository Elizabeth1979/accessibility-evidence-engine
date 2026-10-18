# `@aee/judges`

Structure, keyboard, focus-management, change-response, and release-policy judges for [Accessibility Evidence Engine](https://github.com/Elizabeth1979/accessibility-evidence-engine).

The focus-management judge verifies explicit `inside-dialog`, `preserve`, and `target` expectations using deep focus evidence captured before and after an interaction.

The keyboard judge evaluates only user-authored actions. It applies a bounded role-aware Enter/Space activation matrix and an orientation-aware composite navigation matrix, using deep focus and observable response evidence: the pressed control's state in Chrome's accessibility tree and what it controls, focus, live-region announcements from Guidepup's virtual screen reader, and network activity. A change in the markup is supporting evidence only. Unsupported or context-dependent key combinations return `unknown` instead of being reported as failures. Focus that falls to a document's `<body>` while the page has focus counts as lost, unless that `<body>` is a frame's own tab stop; a Tab that disagrees with the predicted tab order is `unknown`, since the browser's Tab is the ground truth and the prediction a model of it.

The structure judge currently checks evidence completeness rather than full document structure, and a passing result is not WCAG certification.

See the [project README](https://github.com/Elizabeth1979/accessibility-evidence-engine#readme) for the capability matrix and limitations.
