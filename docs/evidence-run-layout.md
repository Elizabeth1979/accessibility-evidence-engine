# Evidence Pipeline and Artifact Contract

This is the target Accessibility Evidence Engine (AEE) architecture. **Available**, **Partial**, and
**Planned** describe implementation status, not WCAG conformance. AEE rules use ACT-compatible
outcome semantics; a rule is called an “ACT Rule” only after it satisfies the
[ACT Rules Format](https://www.w3.org/TR/act-rules-format/).

The editable Mermaid source is
[`docs/diagrams/aee-evidence-pipeline.mmd`](diagrams/aee-evidence-pipeline.mmd).

```mermaid
flowchart TD
  define["1. Define journey and policy"] --> fork{"2. Fork isolated active lanes"}
  fork --> pointer["Pointer and hover"] & keyboard["Keyboard"] & virtual["Virtual screen reader"]
  fork -. optional .-> at["VoiceOver or NVDA"]
  pointer & keyboard & virtual & at --> before["3a. Synchronized before checkpoint"]
  before --> action["3b. One meaningful action"] --> after["3c. Synchronized after checkpoint"]
  after --> more{"More actions?"}
  more -->|Yes| before
  more -->|No| correlate["4. Correlate immutable evidence graph"]
  correlate --> judge["5a. Deterministic judges"] --> route{"Registry allows AI?"}
  route -->|No| verify["5c. Cross-evidence verification"]
  route -->|Yes| ai["5b. Labeled specialist AI output"] --> verify
  verify --> report["6. Integrated HTML, JSON, and Markdown report"]
```

## The execution model

1. **Define one complete journey.** Pin the URL, initial state, authorized actions, expected user
   outcomes, browser and tool versions, resolved axe rule IDs, evidence requirements, and privacy
   policy. The journey receives a stable digest.
2. **Fork active input lanes.** Pointer, keyboard, virtual screen reader, and optional real assistive
   technology use separate browser contexts. Two drivers must never move focus or mutate the same
   page.
3. **Checkpoint every meaningful action.** Passive observers capture a synchronized before state;
   the active lane performs one role-aware action; observers capture the after state. Tab, Enter,
   Space, selection, a committed text value, screen-reader navigation, submit, and hover are
   meaningful actions. Individual typing keys remain in the action trace without forcing a full
   checkpoint for every character.
4. **Correlate without flattening.** Join artifacts by run, lane, action, checkpoint, phase, target,
   and timestamp. Raw observer results remain immutable and independently inspectable.
5. **Judge deterministically, then route narrowly.** The remediation registry identifies required
   evidence, WCAG mappings, deterministic detection, the few allowlisted AI questions, and
   verification. AI output is clearly labeled, evidence-citing, provider-neutral, and advisory.
6. **Publish one integrated report.** HTML is the primary review surface; JSON is canonical for
   tools; Markdown works in GitHub. Findings link to raw evidence rather than copying it.

## Active drivers and passive observers

An active driver changes page state: pointer, keyboard, virtual screen reader, VoiceOver, or NVDA.
Each active lane owns its page and runs the same journey independently. VoiceOver and NVDA form an
optional AT-fidelity tier, not a core requirement.

Passive observers inspect a lane at a checkpoint without changing focus or application state:

| Observer           | Required output                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------- |
| Visual             | viewport PNG and full-page PNG with dimensions and capture metadata                                 |
| DOM                | full serialized DOM, computed target state, and target-specific derived view                        |
| Accessibility tree | full normalized tree plus a target-specific derived view                                            |
| Focus              | `document.activeElement`, deep active element, `aria-activedescendant`, visible focus, and AX focus |
| axe                | unmodified result sets, engine version, resolved rule IDs, tags, disabled rules, URL, and time      |
| Screen reader      | timestamped commands, phrases, item text, focus references, and assertions                          |
| Interaction        | raw key, pointer, hover, selection, authorization, and outcome trace                                |
| Video and network  | lane-spanning video/sidecar/captions and redacted network metadata                                  |

Visual comparison always uses the full page against the full DOM and full accessibility tree. A
target crop or subtree is a derived convenience, never the only evidence supplied to evaluation.

## Three independent result dimensions

Do not overload one `status` field:

| Dimension       | Example values                                             | Meaning                                 |
| --------------- | ---------------------------------------------------------- | --------------------------------------- |
| Execution state | `completed`, `blocked`, `observer-error`, `unsupported`    | Whether the step or observer ran        |
| Rule outcome    | `passed`, `failed`, `cantTell`, `inapplicable`, `untested` | ACT-style evaluation result             |
| Policy decision | `allow`, `warn`, `block`, `review`                         | What the configured release policy does |

If a prerequisite fails, dependent steps become `untested` with `blockedBy`; they do not become
passes. Retries are preserved as attempts, including flaky or contradictory results.

## Deterministic and AI responsibilities

[`rules/remediation-registry.json`](../rules/remediation-registry.json) is the canonical mapping from
issue to requirements, evidence, detection, optional AI contribution, and rerun verification. It is
validated by
[`packages/schemas/json/remediation-registry.schema.json`](../packages/schemas/json/remediation-registry.schema.json).
The public site table is generated from this file with `npm run site:generate`; CI uses
`npm run site:check` to prevent drift.

Examples of the boundary:

- axe deterministically finds an unnamed button; an accessible-name specialist may draft a useful
  name from synchronized context; the rerun recomputes the accessible name and exercises it.
- vision may locate complex foreground/background regions; deterministic code computes the WCAG
  ratio and the closest passing brand token.
- AI may compare visual and semantic heading hierarchy; deterministic extraction and screen-reader
  navigation verify the final outline.
- keyboard, focus movement, hover equivalence, and contrast ratios are exercised or calculated, not
  guessed by a model.

Exact generated text cannot be guaranteed byte-for-byte across all providers. AEE makes the process
reproducible where possible through deterministic routing, pinned prompt and specialist versions,
pinned model settings, structured output, input hashes, caching, and deterministic verification.

## Proposed run directory

```text
aee-output/<run-id>/
├── manifest.json
├── run.json
├── scenario.json
├── environment.json
├── report/
│   ├── aee-report.html
│   ├── aee-report.json
│   └── aee-report.md
├── lanes/<lane-id>/
│   ├── lane.json
│   ├── actions/<action-id>/interaction.json
│   ├── checkpoints/<checkpoint-id>/before/
│   │   ├── viewport.png
│   │   ├── full-page.png
│   │   ├── dom.html
│   │   ├── dom.json
│   │   ├── accessibility-tree.json
│   │   ├── focus.json
│   │   └── axe.json
│   ├── checkpoints/<checkpoint-id>/after/
│   │   └── ...same synchronized artifact types...
│   ├── transcript.json
│   ├── transcript.txt
│   ├── video.webm
│   ├── video.json
│   └── video.vtt
├── judgments/<rule-id>/<judgment-id>.json
├── ai/evaluations/<evaluation-id>.json
├── fixes/<proposal-id>/proposal.json
├── corrections/<correction-id>.json
└── verification/<verification-id>.json
```

See the [manifest example](examples/evidence-run-manifest.example.json).

## Artifact rules

- The canonical manifest indexes immutable artifacts with relative path, media type, SHA-256,
  provenance, lifecycle, lineage, and per-artifact privacy classification.
- Every binary has a JSON sidecar. Transcript JSON is canonical; TXT and WebVTT are projections.
- Images, axe JSON, interaction traces, and requested transcripts persist for every meaningful
  checkpoint. Video can be temporary for passing runs but persists for failure, review, and demo.
- Raw axe output includes passes, violations, incomplete, and inapplicable results. Pin axe version
  and the cumulative WCAG 2.0, 2.1, and 2.2 A/AA rule selection, including disabled-by-default
  choices.
- A verified rerun records its parent run, scenario digest, environment equivalence, intended
  differences, resolved findings, introduced findings, and all attempts.
- Evidence stays local/private by default. Export requires explicit selection, redaction, and a
  sharing review. A generated report must never silently upload authenticated page content.

## CLI target

```bash
aee run scenario.yml
aee run scenario.yml --open
aee run scenario.yml --at-fidelity
aee run scenario.yml --fix
aee run scenario.yml --ci
```

- `--open` opens the integrated HTML report.
- `--at-fidelity` schedules optional VoiceOver or NVDA lanes where supported.
- `--fix` creates proposals in an isolated worktree or branch, never merges or deploys, and reruns
  the same scenario.
- `--ci` is non-interactive, writes machine-readable output, and returns the configured policy exit
  code.

## Learning from corrections

Never overwrite an AI mistake. Preserve the original evaluation and append an approved correction
with reviewer disposition, evidence hashes, reason codes, privacy/consent, and verified-fix linkage.
Only sanitized and explicitly consented corrections may become immutable evaluation fixtures.

Candidates are tested offline against versioned per-specialist suites before promotion. Gate on
evidence citation validity, verdict accuracy, `cantTell` calibration, verified-fix rate, regressions,
privacy checks, and per-rule slices. Releases are versioned, approved, canaried, and reversible.

The [implementation roadmap](implementation-roadmap.md) separates this target from current code.
