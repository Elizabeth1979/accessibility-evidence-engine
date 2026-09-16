# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are product owners, designers, developers, and accessibility reviewers evaluating a website or product flow. They need to understand accessibility risk, remediation priority, and likely effort without first reading raw audit artifacts.

## Product Purpose

The Accessibility Evidence Engine runs user-authored browser journeys and consolidates visual, DOM, accessibility-tree, focus, keyboard, pointer, virtual screen-reader, and Axe evidence into one reviewable assessment. Success means a reviewer can quickly understand the tested page's status, decide what to fix first, and inspect the evidence behind every conclusion.

## Positioning

The product correlates evidence from multiple testing modes at the same interaction checkpoint. It does not treat an automated rule result, screenshot, keyboard trace, or simulated screen-reader announcement as sufficient in isolation.

## Operating Context

Assessments run from the CLI against approved scenarios. Reports are portable, self-contained HTML with local JSON, image, video, transcript, DOM, accessibility-tree, and focus artifacts. Reports may contain sensitive captured data and require review before sharing.

## Capabilities and Constraints

- Testing scope is controlled by the user-authored scenario and must not be presented as universal WCAG conformance.
- Deterministic checks and remediation lead whenever possible.
- AI-generated interpretation or suggestions must be explicitly labeled and must never replace deterministic verification.
- The portable virtual screen reader is a semantic simulation, not VoiceOver, NVDA, or another physical assistive technology.
- Report questions must be answered from captured evidence or clearly identify when a new test or external AI service is required.

## Evidence on Hand

Each completed assessment can include before/after screenshots, interaction video and captions, DOM snapshots, accessibility-tree snapshots, focus state, keyboard/pointer comparisons, virtual screen-reader transcripts, Axe results, manifests, and structured integrated reports.

## Product Principles

- Lead with status, priority, remediation, and effort; keep implementation evidence available as supporting proof.
- Correlate evidence before describing a finding or recommending a fix.
- Preserve positive behavior results even when an independent issue blocks release.
- Make every conclusion traceable to the exact checkpoint and raw artifact.
- Never imply broader accessibility coverage than the approved scenario tested.

## Accessibility & Inclusion

The product targets WCAG 2.2 A/AA evaluation workflows. Its own report interface must be keyboard accessible, screen-reader understandable, responsive, and free of serious or critical automated accessibility violations.
