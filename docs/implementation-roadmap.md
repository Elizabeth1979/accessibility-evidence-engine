# Implementation Roadmap

This roadmap turns the evidence architecture into incremental, testable releases. Status reflects
the repository at the time this document was written.

## Milestone 1 — Evidence foundation (in progress)

- Version complete journeys, meaningful actions, checkpoints, and isolated active lanes.
- Continue correlating the implemented synchronized viewport image, full-page image, DOM,
  accessibility tree, and deep focus state before and after every action at scenario-report level.
- Preserve execution state, ACT-style rule outcome, and policy decision independently.
- Aggregate the implemented checksummed lane manifests into one scenario-level manifest with full rerun lineage.
- Produce integrated HTML, JSON, and Markdown reports.
- Implement CLI-compatible scenario input and `--open` / `--ci` behavior.

Exit test: a keyboard journey with two actions can be replayed; every report conclusion resolves to
same-checkpoint evidence and missing evidence cannot pass.

## Milestone 2 — Portable automated lanes (planned)

- Add pinned axe 4.13 capture with explicit resolved rules and full raw results.
- Expand cross-evidence semantic validation for the portable virtual-screen-reader lane. The Playwright driver, automatic dedicated-context orchestration, per-command recapture, origin enforcement, JSON/TXT transcript, focus-separation judge, and schemas are available.
- Expand the implemented user-authored pointer/hover and keyboard journey runner with role-aware keyboard matrices.
- Expand the implemented per-lane WebM persistence, JSON sidecars, and WebVTT captions with scenario-level retention policy.
- Enforce dependency-aware `untested` plus `blockedBy` behavior.

Exit test: one journey correlates keyboard, pointer/hover, virtual-reader, visual, DOM/AOM, focus,
axe, transcript, and video evidence without active-driver interference.

## Milestone 3 — Context specialists and verified fixes (planned)

- Implement provider-neutral specialists only for registry-allowlisted cases.
- Require full-page visual, full DOM, full accessibility tree, tool results, and stable input hashes.
- Label AI output in HTML, JSON, Markdown, and CLI; record prompt/model/provider provenance.
- Add the cross-evidence verifier and contradiction handling.
- Apply approved proposals only in an isolated worktree/branch and rerun the same journey.
- Implement `--fix`; never merge or deploy automatically.

Exit test: a missing button name is found by axe, worded contextually by a specialist, applied in
isolation, and deterministically verified with visual/DOM/AOM/screen-reader agreement.

## Milestone 4 — Optional AT fidelity (planned)

- Run VoiceOver and NVDA in separate OS-specific workers through Guidepup where supported.
- Preserve command and transcript evidence with OS, browser, AT, locale, and voice metadata.
- Compare real-AT results with the portable lane without treating them as interchangeable.

Exit test: unsupported AT environments remain explicit and never block the default Core profile
unless policy requires the AT-fidelity tier.

## Milestone 5 — Auditable learning loop (planned)

- Add immutable AI evaluation, correction, fix-verification, and evaluator-release schemas.
- Support reviewer dispositions, reason codes, sanitization, consent, case fingerprints, and
  original-versus-corrected provenance.
- Build per-specialist evaluation suites with protected holdouts.
- Gate prompt/model/example promotion on accuracy, citation validity, `cantTell` calibration,
  verified-fix rate, privacy, and regression slices.
- Canary versioned releases and support immediate rollback.

Exit test: a rejected AI proposal can become a sanitized eval fixture only after explicit consent;
a worse candidate cannot be promoted, and a prior evaluator release can be restored.
