# Home-grown code audit

**Question asked:** where else did AEE build its own version of something a maintained, well-tested tool already does, the way it once did with its own virtual screen reader?

**Short answer:** in three ways, all of them versions of the screen-reader mistake.

1. **Our own guess while the right answer is already in hand.** Several parts of AEE work out an element's role, name or state from the page's raw markup, even though Chrome's accessibility tree, which AEE already fetches, holds the correct answer. In one place the correct answer is captured and then never read.
2. **Keeping only part of what a tool gives us.** AEE asks Chrome or axe for the full picture and then keeps only role and name, or one line of English text, and drops states, descriptions, reasons and structured numbers.
3. **Scoring on what is easy to count.** The script that compares AEE's reader with VoiceOver still exists. It removes every role and state word before it compares, so "checked" and "not checked" score as the same thing. The AI naming score has a milder version of the same problem.

Most of the fixes don't add new tools. They point existing code at data AEE already collects.

**How this was checked.** Every package under `packages/`, everything in `scripts/`, and the test helpers in `tests/` were read in full, at commit [`1e48ed6`](https://github.com/Elizabeth1979/accessibility-evidence-engine/tree/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9). That commit is the branch of [Elizabeth1979/accessibility-evidence-engine#123](https://github.com/Elizabeth1979/accessibility-evidence-engine/pull/123), which moves the reader onto Guidepup. The reader itself was not re-audited; the glue around it was.

For each candidate tool, the claim was checked in that tool's current source code or documentation, not from memory. Short quotes and links are given with each item. Where something was run to prove it (for example, giving the built judges a ticked checkbox), the item says so. Where something could not be verified, the item says that too, and the full list is under "What this audit could not verify" at the end.

Nothing in the product was changed. Each "replace" below is a proposal for its own later piece of work.

**What "better" means here.** These are the owner's values, and every verdict is judged against them:

- the accessibility information is complete and correct, and more information beats less;
- NVDA and JAWS behaviour counts for more than VoiceOver's;
- behaviour is backed by the specs (WAI-ARIA, HTML-AAM, accname, WCAG);
- the maintenance burden is low.

Our own code existing is never counted as a merit. Where the evidence is a tie or partial, the verdict is a question for the owner, not a recommendation.

## Summary

Effort: **S** is under a day, **M** is one to three days, **L** is more.

| #   | Capability                                                        | Our code                                                       | Tested alternative                                                  | Verdict                           | Effort |
| --- | ----------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------- | ------ |
| A1  | Describe the focused element (role, name, dialog, widget)         | DOM guess in `playwright/src/index.ts`                         | Chrome's accessibility tree (CDP), already captured                 | Replace                           | S–M    |
| A2  | Name each control in the keyboard sweep                           | `aria-label` or visible text                                   | Chrome's accessibility tree (CDP)                                   | Replace                           | S–M    |
| A3  | Decide whether a key press "did something"                        | Did the page's HTML text change?                               | Chrome's state changes plus Guidepup's live announcements           | Replace                           | M      |
| A4  | Work out tab order and whether focus was lost                     | DOM-order list; `<body>` counts as focus                       | `tabbable`, or the real Tab walk the sweep already records          | Replace                           | M      |
| A5  | Decide an element's role for the AI (decorative image or not)     | Reads the `role` attribute only                                | Chrome's computed role; `dom-accessibility-api` as fallback         | Replace                           | S–M    |
| A6  | Record an element's states in the reader transcript               | Keeps 6 states, drops description and value                    | Every property Chrome returns                                       | Replace                           | S      |
| A7  | Know which roles must have a name                                 | Hand-written list (wrong in places)                            | `aria-query` `accessibleNameRequired`, or the matching axe result   | Built (`aria-query`, ARIA 1.2)    | S      |
| A8  | Index the accessibility tree; images left out                     | Keeps role, name and level; one "decorative" label; no iframes | Chrome's tree is the tool; stop dropping its data                   | Keep the tool, fix the glue       | S–M    |
| A9  | Read axe's results                                                | Regex on axe's English text; every rule "high"                 | axe's own structured data (`check.data`, `impact`, targets)         | Built (axe's structured data)     | S–M    |
| A10 | Which axe rules run                                               | Five WCAG A/AA rules silently skipped                          | Turn on axe's `experimental` tag                                    | Decided: run them (blocking open) | S      |
| A11 | Decide whether new text is announced                              | Own live-region rules                                          | Guidepup's live-region engine, or Chrome's live properties          | Question                          | M      |
| A12 | Point at an element (CSS selectors)                               | Three generators; some not unique                              | `@medv/finder`; axe's own targets                                   | Built (axe-core's own selectors)  | M      |
| A13 | Detect a visible focus indicator                                  | Own pixel diff, plus an outline-only guess                     | `pixelmatch`                                                        | Replace (one setting to decide)   | S      |
| A14 | Composite widgets: roles and expected keys                        | Hand-written role list and key table                           | Roles: `aria-query` or Chrome. Keys: no tool                        | Roles: question. Keys: keep       | S      |
| A15 | Reader jump commands (next heading, landmark, control)            | Rebuilt on top of "next"                                       | Guidepup's own `moveToNextHeading` and others                       | Question                          | S–M    |
| A16 | Colour and contrast maths                                         | Five hand-written copies                                       | `colorjs.io`                                                        | Replace                           | S      |
| A17 | Red flags on the Page view (empty heading, skipped level, no alt) | Separate checks from axe                                       | axe's `empty-heading`, `heading-order`, `image-alt`                 | Question                          | S      |
| A18 | Real screen reader                                                | Placeholder only                                               | `@guidepup/guidepup` with NVDA (installed, unused)                  | Built (real screen readers)       | L      |
| B1  | Compare AEE's reader with a real reader                           | Word-overlap score with role and state words removed           | `diff` (jsdiff) two-way alignment                                   | Replace, and one question         | S      |
| B2  | Score the AI's suggested names and alt text                       | Word overlap with one fixed answer                             | `promptfoo` rubric or similarity checks                             | Question                          | M      |
| B3  | Check the test lab's heading outline                              | Tag names (`H1`, `H2`)                                         | Playwright aria snapshots or `getByRole` heading levels             | Built (Playwright 1.64)           | S      |
| B4  | Remove VoiceOver's usage hints                                    | English regex                                                  | Guidepup start-up settings                                          | Question                          | S      |
| C1  | Call OpenAI and local models                                      | Hand-written `fetch`, broken for OpenAI                        | Official `openai` SDK                                               | Built (`openai` 7.28.0)           | S      |
| C2  | Validate evidence files                                           | Ajv with strict mode off; hand reading with quiet defaults     | Ajv defaults plus the existing validator                            | Strict mode built; C2b open       | S / M  |
| C3  | Give AI agents the findings (MCP)                                 | Shortened PR-comment text                                      | MCP structured output with the full report                          | Built (MCP structured output)     | S      |
| C4  | Post the PR comment                                               | Hand-written GitHub calls                                      | `@actions/github` plus `@octokit/plugin-retry`                      | Replace                           | S      |
| C5  | Read command-line options                                         | Three hand-written parsers                                     | Node's built-in `util.parseArgs`                                    | Built (`util.parseArgs`)          | S      |
| C6  | Write and test CSV                                                | Hand-written writer and test parser                            | `csv-stringify` and `csv-parse`                                     | Replace                           | S      |
| C7  | Fingerprint an approved plan                                      | Key sort that depends on the machine's language                | `canonicalize` (RFC 8785)                                           | Built (`canonicalize` 5.1.0)      | S      |
| C8  | TypeScript types for the schemas                                  | Written by hand                                                | `json-schema-to-typescript`                                         | Replace                           | M      |
| C9  | Check the published packages                                      | Own script                                                     | Add `publint` and `@arethetypeswrong/cli`; keep the end-to-end part | Replace part                      | S      |
| C10 | Guard the package dependency graph                                | Own test                                                       | `eslint-plugin-import-x`; `dependency-cruiser`                      | Question                          | S–M    |
| C11 | Serve test pages                                                  | Three copies of a file server                                  | One tested handler (`sirv` or `serve-handler`)                      | Replace after one check           | S      |
| C12 | Render markdown on the site                                       | Own inline renderer, with a bug                                | `marked.parseInline`, already installed                             | Built (`marked` 18.1.1)           | S      |
| C13 | Read the a11y-skills index                                        | Regex on markdown                                              | `marked` lexer and `yaml`                                           | Built (`marked` lexer, `yaml`)    | S      |
| C14 | Build the HTML report and its tabs                                | Template strings and a hand-written tabs widget                | A template library; `@github/tab-container-element`                 | Question                          | L / S  |
| C15 | Escape text for markdown and PR comments                          | Three different escapers                                       | `mdast-util-to-markdown`                                            | Question                          | M      |
| C16 | Watch the user's test presses                                     | Patches Playwright's internal methods                          | No public hook found                                                | Question                          | M      |

Kept as they are, because no tool covers them or they are thin glue: heading look-alikes, contrast settled from screenshot pixels, colour-only / text-in-image / hover-only / pointer-only checks, waiting for a quiet page, the reader-video overlay, the Guidepup bundle build, the local-model start script, the site generators, the core engine and release judge. The reasons are under "Kept" near the end.

## Suggested order for the replacements

These are proposals only. Each would be its own piece of work with its own PR, visuals and tests.

1. **B1, the reader comparison score.** It is the same mistake this audit was asked about, it still produces a headline number, and the fix is small.
2. **A1, A2 and A5, role and name from Chrome's tree.** One piece of work. The right data is already collected; the code just has to read it. This changes what the judges conclude, so it comes early.
3. **A6, A7 and A8, stop dropping information.** Keep every state, description, value and reason Chrome gives, and take the "must have a name" list from `aria-query`.
4. **A3, "did the press do something?"**, from Chrome's state changes and Guidepup's announcements.
5. **A4, tab order and lost focus.**
6. **A9, axe's structured results** instead of reading its English text. Built: severity follows axe's impact, contrast numbers come from `check.data`, and shadow-root targets keep their full path.
7. **C1, the OpenAI client.** Built: the old client failed on every reply shaped as the API sends it.
8. **C2, Ajv strict mode back on**, and evidence files validated by their schemas. This is a switched-off check, which the owner's rules forbid. Strict mode is built (C2a); validating the evidence files instead of reading them by hand (C2b) is still open.
9. **B3, the heading outline from the accessibility tree.** Built: the tag check counted a hidden heading and missed a `role="heading"` one.
10. **A12, selectors**, then **A13, the focus pixel diff**, then **A16, colour maths.** A12 is built: every selector is axe-core's own.
11. **C3, the full report for AI agents.** Built: an agent gets every finding in full as structured content, under AEE's own report schema.
12. **The small plumbing batch**, one PR each: C4, C5, C6, C7, C9, C11, C12, C13. C7 is built: a plan's digest no longer depends on the machine's language.
13. **C8, generated types.**

## Questions for the owner

Each of these is a tie or partial evidence, so it needs your call, not a recommendation.

**Decided on 17 October 2026.** No work has started on these yet.

- **A10, should the five experimental axe rules run? Yes.** Owner: "yes, why not". Still open: whether their failures block a release or only show as advice (listed below).
- **A18, real NVDA through Guidepup on a Windows runner: built.** Owner: "that will be great as a next step". The Real screen readers workflow runs it; see [docs/real-screen-readers.md](../real-screen-readers.md).

**Still open:**

- **A10.** Should failures from the five experimental axe rules block a release, or only be shown as advice?
- **A11.** For "was the new text announced?", which source should be the reference: Guidepup's live-region engine (complete for the ARIA live attributes, but appears to miss an alert inserted into a quiet parent) or Chrome's own live-region properties?
- **A13.** Should the focus pixel check count anti-aliased pixels? That decides whether a thin, soft focus ring can be missed.
- **A14.** For composite widget roles, `aria-query` and axe disagree on whether `listbox` is composite. Which list should AEE follow?
- **A15.** Should the reader's "next heading / next landmark" use Guidepup's own commands or Chrome's roles? And what should "next control" model: NVDA's F key, JAWS's F key, or something else?
- **A16.** `colorjs.io` is maintained by the CSS colour spec editors but is still version 0.x. Is that acceptable, or should `culori` be checked as well?
- **A17.** Should the Page view's red markers come from axe, so they match the Fix list, or stay a separate reader's-eye view?
- **B1.** What should AEE's reader be judged against: NVDA, Chrome's accessibility tree (aria snapshot), or W3C ARIA-AT assertions?
- **B2.** For the AI score: should names be short (APG's advice) while alt text can be full? And is an AI grader acceptable inside the test harness?
- **B4.** Should VoiceOver's hints be switched off through Guidepup's settings rather than cut out with a regex?
- **C10, C14, C15, C16.** These are maintenance trade-offs only. They are explained in their sections below.

---

## Part A: accessibility facts we work out ourselves

These carry the most risk, because they change what AEE tells people about a page.

### A1. Describing the focused element

**What it does.** When focus lands on something, AEE writes down what it is, so the judges can check "focus went to the Search field" or "focus stayed inside the dialog". AEE works this out from the markup:

- the name is `aria-label`, else the form field's `name` attribute, else the text inside;
- the role is the `role` attribute, else a 20-line table of tags;
- a dialog's name is one `aria-labelledby` id, else its first 120 characters of text.

**Example.** `<label for="q">Search</label><input id="q" name="q">` is reported as named **"q"**. "q" is the form field's internal name, which accname never uses. A test expecting "Search" fails.

Another example: an unlabelled `<div role="dialog">` is given its text as a name. ARIA says a dialog's name comes from the author only, so a real "dialog has no name" failure is hidden.

Also: `<img>`, `<h2>` and `<nav>` get no role at all, and the "focus indicator visible" check only looks at outline and box-shadow.

**Our code.**

- [`index.ts` 2262–2535](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/index.ts#L2262-L2535), about 270 lines: `getDialogContext`, `getElementSummary`, `focusableElements`, `getElementNodePath`, `getImplicitRole`.
- The judges use these fields to match role and name, the dialog, focus order and widget context ([`judges/src/index.ts` 494–495 and others](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/judges/src/index.ts#L494-L495)).

**The right answer is already collected and never read.** The same snapshot also asks Chrome for the focused element's role and name and stores them as `accessibilityFocus` ([`index.ts` 2519–2525](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/index.ts#L2519-L2525), fetched by `captureAccessibilityFocus` at line 2646). A search of every package found nothing that reads it.

**Tested alternative.** Chrome's accessibility tree, read over the DevTools protocol (CDP). This is Chrome's own implementation of HTML-AAM and accname, and it is the same tree NVDA and JAWS receive from Chrome.

- Each node carries role, name, description, value and properties (Playwright's bundled [`protocol.d.ts`](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#type-AXNode), `AXNode`).
- Those properties include `focused`, `modal`, `orientation`, `activedescendant`, `expanded`, `checked`, `labelledby` and `describedby`.
- Walking up a node's parents finds the dialog (with its computed name and `modal`) and the widget it belongs to.
- AEE's own code comment in [`accessibility-tree.ts` 47–51](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/accessibility-tree.ts#L47-L51) already says every part of the engine should read this tree "rather than inferring them from the DOM".

**Rejected alternatives:**

- Playwright's `ariaSnapshot` uses Playwright's own role engine, not Chrome's.
- axe's internal helpers (`axe.commons`) are described in axe's developer guide as internal, not a stable API.

**Verdict: replace** with Chrome's accessibility tree for role, name, description, states, dialog and widget context. Keep the small part that follows focus into shadow roots and iframes; that is glue.

**Effort:** S–M.

### A2. Naming controls in the keyboard sweep

**What it does.** Every finding from the keyboard and pointer sweep names the control it is about. The name is `aria-label`, else the visible text, cut to 80 characters. When that comes out empty, the report says **"a control with no name"**.

**Example.** These all come out unnamed or wrongly named, though a screen reader announces each one correctly:

- `<input type="submit" value="Save">`
- `<button aria-labelledby="x">`
- a link wrapping `<img alt="Home">`

So the report can claim "no name" for a control that has one.

**Our code.** [`keyboard-pointer-sweep.ts` 915–924](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/keyboard-pointer-sweep.ts#L915-L924) (`labelFor`). Verified in the source:

```
element.getAttribute("aria-label") ?? element.innerText ?? element.textContent
```

The same file already gets tab-stop names correctly from Chrome at [line 596](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/keyboard-pointer-sweep.ts#L596) (`describeFocusedElement`). So two different name sources sit side by side.

**Tested alternative.** Chrome's accessibility tree over CDP. The two calls are:

- `Accessibility.getPartialAXTree`, which AEE already wraps as `describeSelectedElement`;
- `Accessibility.queryAXTree`, which searches by accessible name and role ([CDP docs](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#method-queryAXTree)).

**Verdict: replace** with the name from Chrome's tree.

**Effort:** S–M. Each probe returns its elements, then Chrome is asked for their names.

### A3. Deciding whether a key press "did something"

**What it does.** When Enter or Space is pressed on a control, the judge passes only if one of these happened: focus moved, the page's HTML text changed, or a network request went out.

**Example, run and verified.** Pressing Space on a normal checkbox ticks it. Chrome's tree changed from `checked: false` to `checked: true`. But "checked" is not written into the HTML text, so the HTML did not change.

Given that evidence, the built judges said:

- _Keyboard space produced no observable activation response for input #c role=checkbox_, a **fail**;
- _No observable response followed the space interaction on checkbox_, a **fail**.

The opposite also happens: a ticking clock or an injected analytics tag changes the HTML, so a dead button can **pass**.

**Our code.**

- [`judges/src/index.ts` 1759–1871](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/judges/src/index.ts#L1759-L1871) (`collectActivationSignals`, `collectChangeResponseSignals`, `hasDomChange`).
- [`observers/src/index.ts` 305–393](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/observers/src/index.ts#L305-L393) (`captureDomRecord` compares the whole HTML string).

**Information already collected and ignored:**

- AEE already captures Chrome's accessibility tree before and after every interaction. Chrome reports `checked`, `expanded`, `pressed`, `selected` and the value; no judge compares them.
- Guidepup's virtual reader already turns live-region updates into spoken lines that start with `polite` or `assertive` (Guidepup source, `getLiveSpokenPhrase`). The judge never reads them, so status messages (WCAG 4.1.3) are invisible to it.

**Verdict: replace** the HTML-text signal with:

1. the change in Chrome's states for the pressed element;
2. Guidepup's live announcements.

Keep the HTML change only as supporting evidence, never as the deciding signal.

**Effort:** M.

### A4. Tab order and lost focus

**What it does.** To judge "Tab moved forward", AEE builds its own list of focusable elements in page order, with the selector `a[href], button, input, select, textarea, [tabindex], [contenteditable]`. It then checks that each Tab moves to a later item in that list.

**Example.** These cases go wrong:

- **Positive `tabindex`.** The browser correctly tabs to an element that sits earlier in the page, and the judge **fails** it as "wrong direction" (from the code).
- **Shadow DOM, iframes, and script-focused elements.** They are not in the list, so the judge passes at 0.75 confidence.
- **Focus falling to `<body>`**, run and verified. Moving from `button "Save"` to `body` gave _pass – Keyboard focus advanced forward … to body_. When nothing has focus, the browser reports `<body>` as focused. The "focus lost" check only looks for an empty value, so it never fires.

**Our code.**

- [`judges` 511–651](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/judges/src/index.ts#L511-L651) and [2315–2343](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/judges/src/index.ts#L2315-L2343).
- The list is built at [`playwright/src/index.ts` 2413–2450](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/index.ts#L2413-L2450).

**Tested alternative.** [`tabbable`](https://github.com/focus-trap/tabbable) 6.5.0 (released June 2026, from the focus-trap project).

- Its README says it returns nodes "in tab order", with positive `tabindex` first, "ordered by ascending `tabindex` and source order".
- It handles radio groups, disabled fieldsets, `inert`, closed `<details>`, and shadow DOM (with an option).
- It states its own limits: iframes, `<object>` and `<summary>` differ between browsers.
- axe's own focus helpers don't sort by `tabindex`.

**Verdict: replace** the home-made order with `tabbable`, injected the same way the Guidepup bundle is. Or use the real Tab sequence the keyboard sweep already records. Also:

- treat a disagreement between the browser and the prediction as "unknown", not "fail";
- treat `<body>` as lost focus.

**Effort:** M.

### A5. The element's role for the AI, and "is this image decorative?"

**What it does.** Before asking the AI about an image, AEE decides from the raw markup whether it is decorative. It checks for `role="presentation"`/`"none"`, `alt=""`, or `aria-hidden` on an ancestor. The AI's answer is then forced to agree.

The page context sent to the AI also takes its "role" from the `role` attribute only. So most elements have no role, and the CLI falls back to the tag name: `input` and `svg` get sent as if they were roles, and an `<a>` with no link target is called "link".

**Example.** `<img alt="" aria-label="Revenue chart">` is classed as decorative, and an AI answer saying "informative" is rejected.

ARIA's conflict rule says that when an element has a global ARIA attribute, or can take focus, the browser must ignore "presentation" and expose the real role ([WAI-ARIA §9.3](https://w3c.github.io/aria/#conflict_resolution_presentation_none)). So the image is not decorative to a screen reader.

**Our code.**

- [`ai-fixes/src/specialists.ts` 172 onwards](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/ai-fixes/src/specialists.ts#L172) (`imageRoleFromMarkup`).
- [`playwright/src/element-context.ts` 101–127](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/element-context.ts#L101-L127): the role attribute, `aria-hidden` only (no `inert`), and nearby headings taken from tags.
- [`cli/src/scenario-runner.ts` 2532–2533](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/scenario-runner.ts#L2532-L2533).

**Tested alternatives:**

- Chrome's computed role and "ignored" state from the accessibility tree.
- [`dom-accessibility-api`](https://github.com/eps1lon/dom-accessibility-api) 0.7.1 as a fallback when no tree is available. It is already installed with Guidepup. Its `getRole` implements the §9.3 conflict rule; its source links to that section.

**Verdict: replace.** Chrome first, because it matches what NVDA and JAWS get.

**Effort:** S–M.

### A6. States in the reader transcript

**What it does.** For each line the reader speaks, AEE also records the element's states. It keeps six: expanded, checked, selected, pressed, disabled and required. It drops the rest, and it drops the element's description and value entirely.

**Example.** For a text field with `aria-invalid="true"`, `readonly`, and a hint linked by `aria-describedby`, the spoken line from Guidepup still has all of this. The structured record the judges use loses "invalid", "read only" and the hint.

Other states that are dropped: busy, has popup, multi-selectable, modal, value text, min and max, autocomplete, keyboard shortcuts, role description and orientation.

**Our code.**

- [`virtual-screen-reader.ts` 478–501](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/virtual-screen-reader.ts#L478-L501).
- The local type for a Chrome node doesn't even declare `description` or `value` ([`accessibility-tree.ts` 17–28](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/accessibility-tree.ts#L17-L28)).

**Tested alternative.** Chrome already returns all of these as node properties ([CDP `AXPropertyName`](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#type-AXPropertyName)).

**Verdict: replace** the hand-picked list with every property, plus description and value.

**Effort:** S.

### A7. Which roles must have a name

**What it does.** A hand-written list decides when the reader report says "announced without a name".

**Example.**

- The list includes `tab`, which ARIA doesn't require to be named.
- It leaves out roles that ARIA does require to be named: meter, progressbar, radiogroup, tree, treegrid, grid, table, tabpanel, tooltip, region, column and row headers, and the graphics roles.

So an unlabelled progress bar is never reported.

**Our code.** [`virtual-screen-reader.ts` 141–153](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/virtual-screen-reader.ts#L141-L153), used by the report in `scenario-runner.ts`.

**Tested alternatives:**

- **[`aria-query`](https://github.com/A11yance/aria-query).** Each role has an `accessibleNameRequired` flag, and querying it returns all the roles listed above. Its last release was September 2024, so it moves slowly; check its ARIA 1.3 coverage first.
- **axe rules.** axe already has a rule for most of these roles (`button-name`, `link-name`, `aria-meter-name`, `aria-progressbar-name`, `aria-tooltip-name` and others). The matching axe result could be attached instead.

**Verdict: replace** with `aria-query`'s flag, or link to the matching axe rule.

**Built.** The owner chose WAI-ARIA 1.2. The reader now takes the roles from `aria-query` 5.3.2's `accessibleNameRequired`, with Chrome's `image` read as ARIA's `img`. Checked against the ARIA 1.2 Recommendation's source (w3c/aria, branch `2023-06_REC`): `aria-query` has every role ARIA 1.2 marks "Accessible Name Required: True" except `form`, which ARIA 1.2 marks True and `aria-query` marks false. That gap changes nothing AEE reports, because Chrome exposes an unnamed form (and an unnamed region) as a generic container, so the reader never reads one as a form. axe's own role table (`axe.utils.getStandards().ariaRoles`) was not used: it leaves out 13 of ARIA 1.2's roles, among them heading, region, table, tree and tabpanel, and adds `toolbar`, which ARIA 1.2 does not require to be named.

**Effort:** S.

### A8. Indexing the accessibility tree, and images that are left out

**What it does.** AEE reads Chrome's tree, which is the right tool, but then throws parts of it away:

- **The tree index** keeps only role, name and heading level. It then passes a check if _any_ node anywhere has the same three values. Because the reader's role and name also come from Chrome, this "agreement" check mostly compares Chrome with itself.
- **The element map** turns every reason Chrome gives for leaving an image out into one word, "decorative". An image hidden by `aria-hidden="true"` or `inert` looks the same as one with `alt=""`.
- **Iframes are missing.** The tree is fetched without a frame, so Chrome returns the top frame only (the protocol docs say "If omitted, the root frame is used"). The page snapshot also reads only its first document. So anything inside an iframe is missing from the tree, the element map, the heading look-alikes and the reader's role lookups.

**Example.**

- A sign-up form inside an iframe is invisible to these parts of AEE.
- A hidden but important chart image is reported as "decorative".

**Our code.**

- [`observers` 478–543](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/observers/src/index.ts#L478-L543) and [`judges` 1455–1474](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/judges/src/index.ts#L1455-L1474).
- [`element-map.ts` 59–85](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/element-map.ts#L59-L85).
- [`accessibility-tree.ts` 53–55 and 149](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/accessibility-tree.ts#L53-L55).

**The part that is genuinely useful.** The check that Guidepup's spoken line contains Chrome's name is real. In Playwright's Chromium, Guidepup uses `dom-accessibility-api` rather than Chrome, so this compares two engines.

**Verdict: keep the tool, fix the glue:**

- index whole nodes by their id;
- compare the same node, including states and description;
- keep the exact ignore reason;
- walk every frame;
- reword the pass message to say what is really checked.

**Effort:** S for the data, M for iframes.

### A9. Reading axe's results

**What it does.** axe returns structured results: colours, contrast ratio, required ratio, impact, and the exact element path, including through shadow DOM. AEE throws most of that away and reads numbers back out of axe's English sentence instead.

**Example.**

- The required contrast ratio is found with the regex `/Expected contrast ratio of ([0-9.]+):1/`. That breaks as soon as axe runs in another language.
- Every axe rule becomes severity "high", whatever axe's own impact is.
- An element inside a shadow root has the path `["#host", "button"]`. AEE joins it into `"#host,button"`, which means two different elements to CSS, so later matching fails.
- AEE's own pixel contrast check writes its result into axe's English wording, only for the report to read it back out with a regex.

**Our code.**

- [`scenario-runner.ts` 2019–2022](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/scenario-runner.ts#L2019-L2022), [4179–4181](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/scenario-runner.ts#L4179-L4181), [4301–4339](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/scenario-runner.ts#L4301-L4339) and 1636.
- [`judges` 1480–1605](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/judges/src/index.ts#L1480-L1605).

**Tested alternative.** axe-core's own structured output.

- In axe 4.13's source, the contrast check records `fgColor`, `bgColor`, `contrastRatio`, `fontSize`, `fontWeight` and `expectedContrastRatio` as data.
- axe's type file declares `impact`, `ancestry`, `any`/`all`/`none` with `data` and `relatedNodes`, and targets as nested arrays for shadow DOM ([axe API docs](https://github.com/dequelabs/axe-core/blob/develop/doc/API.md#results-object)).
- ADR 0002 already says findings take their WCAG criteria from axe's tags.

**Verdict: replace** the text parsing with axe's structured fields, typed with axe's own `axe.d.ts`. Keep targets as arrays, and carry axe's impact and tags into each finding.

**Built.** Each of the four problems had a test that failed on the old code first, and passes now:

- **Severity.** A judge test with four rules of each impact got "high" for all four. axe's observer now records each blocking rule's impact (`meta.violationImpacts`), and the axe judge maps it one step for each: critical to `critical`, serious to `high`, moderate to `medium`, minor to `low`. A rule with no impact keeps `high`. The judgment stays `high` and fails on any WCAG violation, so the release gate decides exactly as before. Checked in axe 4.14 in Chromium: each of its 105 rules has one impact, so a rule's severity is the same at every checkpoint.
- **Contrast.** A report test whose axe message and failure summary are in French, with large text needing 3:1, gave no numbers and no proposed colour on the old code. The report now reads axe's `fgColor`, `bgColor`, `contrastRatio`, `expectedContrastRatio`, `fontSize` and `fontWeight` (axe-core 4.14's `color-contrast` check, checked in its source), through one reader in [`playwright/src/axe-results.ts`](../../packages/playwright/src/axe-results.ts) that the pixel measurement uses too. All three regular expressions on axe's text are gone.
- **AEE's pixel measurement.** It no longer rewrites axe's message. The report says it in AEE's words from `aeeContrast`'s numbers.
- **Shadow DOM.** A real-browser test with an unnamed button in a shadow root located the host, 800 by 150 pixels, instead of the 40 by 30 button; a report test turned `[["#app-shell", "button.icon"]]` into `#app-shell,button.icon`. The element is now found by walking each shadow root, the report writes `#app-shell >>> button.icon`, and each affected element keeps axe's whole target array.

Left as follow-ups: AEE's pixel contrast check still measures only texts in the top document's own tree, and the page around an element is captured for the AI only for those; an element inside a frame or a shadow root gets none (it used to get the frame's or the host's, a different element). axe's `tags` already reach each finding (ADR 0002).

**Effort:** S–M.

### A10. axe rules that silently don't run

**What it does.** AEE asks axe for every WCAG 2.0–2.2 A/AA rule. But axe leaves out rules tagged `experimental` unless you ask for that tag by name; its source sets `tagExclude = [ 'experimental', 'deprecated' ]`.

Checked against axe 4.13.0: five WCAG A/AA rules are experimental, so they never run in AEE:

- `label-content-name-mismatch`, for WCAG 2.5.3 "Label in Name". axe implements W3C ACT rule 2ee8b8 with it.
- `p-as-heading` (1.3.1)
- `css-orientation-lock` (1.3.4)
- `td-has-header` (1.3.1)
- `table-fake-caption` (1.3.1)

Meanwhile, the pass message says axe found nothing "in the cumulative WCAG 2.0/2.1/2.2 A/AA rule selection" ([`judges` 1595](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/judges/src/index.ts#L1595)).

**Example.** A button that shows "Send" but is named "Submit form" breaks WCAG 2.5.3 for speech-input users. AEE never checks it.

**Our code.** [`observers` 759–761](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/observers/src/index.ts#L759-L761).

**Verdict: decided on 17 October 2026, run them.** The owner said "yes, why not". Running them gives more information. Still a question for the owner: axe calls them experimental, so should their failures block a release or be shown as advice? Until they run, the pass message should name what was left out.

**Effort:** S.

### A11. Was the new text announced?

**What it does.** The keyboard sweep decides whether new text on the page would be announced. It uses its own selector list for live regions, plus its own rule for alerts and for text linked to the focused control.

It ignores:

- `aria-atomic`;
- `aria-relevant`, so removals never count;
- `aria-busy`;
- a nested `aria-live="off"`;
- `inert`.

**Example.** A status region marked `aria-busy="true"` while loading is treated as announcing each partial update. A screen reader waits for it to finish.

**Our code.** [`keyboard-pointer-sweep.ts` 1110–1277](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/keyboard-pointer-sweep.ts#L1110-L1277).

**Tested alternatives, and why it is a tie:**

- **Guidepup's live-region engine.** It implements `aria-live`, `aria-atomic`, `aria-relevant` and the built-in defaults: alert and status are atomic, timer is off. It logs `polite:` / `assertive:` lines.
  - Reading its source, it takes the live setting from the _parent_ of the change. So an alert inserted into a quiet container appears to say nothing, while NVDA and JAWS in Chrome do announce it. Our code handles that case.
- **Chrome's own live-region properties** (`live`, `atomic`, `relevant`, `busy`, `root` in [`AXPropertyName`](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/#type-AXPropertyName)). This is the calculation real screen readers get their events from. But AEE would still need its own "what was added" logic around it.

**Verdict: question for the owner.** Which should be the reference: Guidepup's engine (spec-complete, with one gap that matters for NVDA and JAWS) or Chrome's properties (closer to NVDA and JAWS, with more glue to keep)?

**Effort:** M.

### A12. Pointing at an element (selectors)

**What it does.** AEE writes CSS selectors so a report can point at "this element". There are three home-made generators, and two of them can point at the wrong element.

**Example.**

- One stops after 8 steps up the page. On a deeply nested page, its selector starts in the middle of the page and can match a different element first.
- One has no position at all, so two list items next to each other get the same selector.
- The third ignores shadow DOM.
- Separately, for axe results AEE keeps only the first part of a shadow-DOM or iframe path, so the report describes the host or the iframe, not the element.

**Our code.**

- [`accessibility-tree.ts` 169–188](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/accessibility-tree.ts#L169-L188).
- [`index.ts` 2476–2494](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/index.ts#L2476-L2494) and 2569.
- [`keyboard-pointer-sweep.ts` 907–914](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/keyboard-pointer-sweep.ts#L907-L914).

**Tested alternatives:**

- [`@medv/finder`](https://github.com/antonmedv/finder) 4.0.2 promises "Unique CSS selectors per page". Its docs don't mention shadow DOM or iframes, so that part stays open whichever way AEE goes.
- [`css-selector-generator`](https://github.com/fczbkk/css-selector-generator) 3.9.4 is the second candidate.
- For axe results, use axe's own full target arrays.

**Verdict: replace** the in-page generators with `@medv/finder`. Remove the 8-step cap, and keep axe's targets whole.

**Built, with axe-core's own generator instead of `@medv/finder`.** The choice was measured in Chromium on a generic page: two lists built the same way, ten levels deep, a button in a component's open shadow root, and 1,500 cards (4,545 elements).

- `@medv/finder` 4.0.2 runs in the page, but has no path through shadow roots. For the button in the shadow root it returns `button`, which selects a different button in the page. On the deep lists it found nothing in its default 1 second and fell back to a full positional path; given 50 seconds, it crashed with "Maximum call stack size exceeded" after 1.6.
- `css-selector-generator` 3.9.4 also gives only the part inside the shadow root.
- axe-core's generator (`new axe.utils.DqElement(element).selector`, after `axe.setup`, both in axe 4.14's `axe.d.ts`) gave `section:nth-child(3) > div > … > li:nth-child(2) > button` and `["order-card", "button"]`, the very strings `axe.run` put in its `target`. One index served 300 elements of the 4,545-element page in 67 ms; indexing again for each element took 62 ms each, so AEE indexes once per call.

One shared function in the page ([`element-selectors.ts`](../../packages/playwright/src/element-selectors.ts)) now replaces all three generators. axe-core is loaded as a plain script under its own global, and the page's own `window.axe` is put back. A shadow root is written `#host >>> button`, with `describeAxeTarget` from A9. Four tests in [`tests/element-selectors.spec.ts`](../../tests/element-selectors.spec.ts) failed on the old code, and pass now:

- **The reader:** both lists' buttons had the same two eight-step paths, which select the first list's.
- **The element map:** the same, and the shadow root's image had a path that selects nothing.
- **The focus observer:** the path for all four list buttons was the same, and the shadow root's button was `div > button`, another button in the page.
- **The sweep:** its positional path never matched axe's for the same button.

Verdicts are unchanged. Which report fields change is in the changelog. Left open: Guidepup's reader reads no shadow root at all (guidepup/virtual-screen-reader#183), and a frame inside a shadow root still cannot be left out of axe's run, since axe's `exclude` takes no shadow path from AEE yet.

**Follow-up, built: the focus judge compares elements, not selector text.** With axe's shorter paths, the focus judge's text comparison of a scenario's selector with the focused element's `nodePath` became wrong both ways. On a page with two identical Save buttons, the first in an embedded frame and the second in the page, a focus action on the page's `button` that ended on the frame's button passed, since that button's path in its own document is also `button`. And `form > button[type="submit"]` failed on the very button axe writes as `#save`. The focus observer now resolves the target's selector with Playwright, as the action did, and records in `requestedTarget` whether that element is the one with focus: it is the active element of its document or shadow root and of each one above (checked in the page, `root.activeElement === element`), and the chain of active elements the capture followed through closed shadow roots and frames ([`dom-focus.ts`](../../packages/playwright/src/dom-focus.ts)) ends with it. A selector that selects no element or several, or an element in a cross-origin frame, is recorded as `unresolved` with the reason, and the judge says `unknown` with it. Four tests in [`tests/element-selectors.spec.ts`](../../tests/element-selectors.spec.ts) and one in the judges' unit tests failed on the text comparison and pass now: the frame's button (passed, now fails), `#save` written another way (failed, now passes), a button in an open shadow root (failed, now passes; its host requested instead still fails), and a selector that selects two buttons (failed, now unknown). Which verdicts can change is in the changelog.

**Effort:** M.

### A13. Detecting a visible focus indicator

**What it does.** For WCAG 2.4.7, the sweep compares a screenshot of a control before and after focus. A pixel counts as changed if any colour channel moves by more than 32, and four changed pixels count as "visible". A second check elsewhere only looks for an outline or box-shadow, so it misses focus shown by a background, border or underline.

**Example.** A thin, light focus ring can fall under the fixed threshold. A focus style that changes the background is called "no indicator" by the second check.

**Our code.**

- [`keyboard-pointer-sweep.ts` 621–643](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/keyboard-pointer-sweep.ts#L621-L643).
- `focusIndicator` in [`index.ts` 2388](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/index.ts#L2388).

**Tested alternative.** [`pixelmatch`](https://github.com/mapbox/pixelmatch) 8.0.0 (October 2026).

- It offers "a perceptual color difference metric" and returns the number of changed pixels.
- It ignores anti-aliased pixels by default; an `includeAA` option counts them.
- Playwright's own image comparer is internal, not a public API.

**Verdict: replace** the pixel diff with `pixelmatch`, and drop the outline-only check or label it clearly.

**Open setting for the owner:** whether to count anti-aliased pixels, so a soft one-pixel ring is not missed.

**Effort:** S.

### A14. Composite widgets: roles and expected keys

**What it does.** Hand-written tables say which roles are composite widgets (tablist, menu, grid and so on) and which keys each should answer to (arrow keys, Home and End, Enter and Space).

**Example.**

- `treegrid` is missing.
- A native `<select>` and a group of native radio buttons are not treated as widgets.
- A horizontal listbox is still expected to use up and down arrows.

These gaps give "unknown" rather than wrong verdicts.

**Our code.**

- [`index.ts` 2198–2216](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/index.ts#L2198-L2216).
- [`judges` 653–688](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/judges/src/index.ts#L653-L688), 1907–1998 and 2025–2117.

**Evidence:**

- **Roles.** `aria-query` and axe both list `treegrid` as composite, but they disagree on `listbox`. Chrome's tree reports `orientation`.
- **Keys: no tool covers this, checked.**
  - axe's keyboard rules are about skip links, tabindex, nesting and scrollable areas, not widget keys.
  - `aria-query` has no keyboard data.
  - The W3C ACT rules list has no widget-keyboard rule.
  - The APG test suite is a repository, not a library.

**Verdict:**

- **Roles: question for the owner**, because the two lists disagree.
- **Keys: keep.** No tool covers widget keyboard behaviour. Cite the APG pattern for each row of the table.

**Effort:** S.

### A15. Reader jump commands, and "current"

**What it does.** AEE builds "next heading", "next landmark" and "next control" by stepping one item at a time and asking Chrome for each role. It also writes `aria-current` straight from the attribute.

**Example.**

- AEE's landmark list leaves out `figure`, which Guidepup's includes.
- AEE's "next control" stops at links and form fields. That matches neither NVDA's F key nor JAWS's F key (form fields, no links).
- `aria-current="foo"`, which is invalid, becomes "current foo".

**Our code.** [`virtual-screen-reader.ts` 110–138 and 283–350](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/virtual-screen-reader.ts#L110-L138), and 496–501.

**Tested alternative.** Guidepup 0.32.1 has `moveToNextHeading`, `moveToNextLandmark`, `moveToNextLink` and heading levels 1 to 6, from its type definitions. It has no "next control" command, and it maps valid `aria-current` values to phrases such as "current page".

**Verdict: question for the owner.** Guidepup's commands agree with what it speaks. AEE's use Chrome's roles, which are closer to NVDA and JAWS in Chrome, and they allow an exact "undo" for peeking ahead. Which one wins? And what should "next control" model?

**Effort:** S–M.

The Guidepup pin is still justified: 0.33.0 is out (September 2026), but guidepup/virtual-screen-reader#250 is still open.

### A16. Colour and contrast maths

**What it does.** The WCAG luminance and contrast formula, colour mixing for fix suggestions, and OKLab conversion are each written by hand, in five places.

**Example.** The contrast fix preview only understands six-digit hex colours. A colour given as `rgb()` or with transparency can't be previewed.

**Our code.**

- [`scenario-runner.ts` 4341–4369](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/scenario-runner.ts#L4341-L4369).
- [`ai-fixes/src/index.ts` 80–145 and 368–440](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/ai-fixes/src/index.ts#L80-L145).
- `keyboard-pointer-sweep.ts` 1394 and `contrast-measurement.ts` 289.

AEE's formula matches axe's exactly, so the numbers are right today. This is a maintenance issue, not a correctness one.

**Tested alternative.** [`colorjs.io`](https://colorjs.io/) 0.7.1 (July 2026), maintained by the CSS Color spec editors.

- Its source has `contrastWCAG21`, citing WCAG technique G18.
- It has `mix()`, which mixes in any colour space.
- It parses any CSS colour.
- Its docs don't mention blending a transparent colour onto a background, so that step stays ours.

**Verdict: replace** the five copies with `colorjs.io`.

**Question for the owner:** it is still version 0.x. If that matters, check `culori` too (not verified here).

**Effort:** S.

### A17. Red flags on the Page view

**What it does.** The Page view colours headings and images red for "empty heading", "skips from H2 to H4" and "no alt". These come from AEE's own checks on the element map, not from axe, and they don't change any verdict.

**Example.** The Page view can show a red marker that the Fix list, which comes from axe, doesn't mention, or the other way round.

**Our code.** [`scenario-runner.ts` 4703–4747](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/scenario-runner.ts#L4703-L4747).

**Tested alternative.** axe's `empty-heading`, `heading-order` and `image-alt` results, which are already in the same run.

**Verdict: question for the owner.** Is this view meant as a separate, reader's-eye outline, or should its markers come from axe so the two always agree?

**Effort:** S.

### A18. A real screen reader

**What it does.** The `guidepup-screen-reader` observer is a placeholder marked unsupported. All screen-reader evidence comes from the virtual reader, which is not NVDA or JAWS.

**Our code.** [`observers` 42–48 and 243–258](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/observers/src/index.ts#L42-L48).

**Tested alternative.** `@guidepup/guidepup` 0.36.3 is already installed. Its [README](https://github.com/guidepup/guidepup) says it drives NVDA on Windows, Orca on Linux and VoiceOver on macOS. It does not drive JAWS.

**Verdict: decided on 17 October 2026 and built the same day.** The owner said "that will be great as a next step". Real NVDA output fits the owner's priorities best. The Real screen readers workflow runs NVDA on a GitHub Windows runner, and VoiceOver on a Mac runner when ticked, next to AEE's virtual reader ([docs/real-screen-readers.md](../real-screen-readers.md)). Guidepup does not drive JAWS; JAWS's own Remote Command Server speaks W3C AT-Driver and W3C ARIA-AT runs it in CI, but it needs a paid licence, so JAWS is left as an open question.

**Effort:** L.

---

## Part B: how AEE measures itself

This is exactly where the original mistake happened.

### B1. The score comparing AEE's reader with a real reader

**What it does.** `npm run readers:compare` walks a page with AEE's reader and with the real reader on the machine, then writes a headline score, "Says what VoiceOver says". To score, it:

1. turns each line into a set of words;
2. removes a fixed list of "reader words";
3. counts a real line as "heard" if any one virtual line contains all its remaining words.

**The problem, verified in the source.** The removed words include every role and state: `button`, `link`, `heading`, `checkbox`, `checked`, `not`, `expanded`, `collapsed`, `pressed`, `selected`, `current` and more ([`tests/reader-comparison.ts` 96–148](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/tests/reader-comparison.ts#L96-L148)).

The scoring functions were copied unchanged and run on these pairs:

| Real reader said                     | AEE's reader said                | Score                 |
| ------------------------------------ | -------------------------------- | --------------------- |
| Email updates, checkbox, not checked | checkbox, Email updates, checked | heard                 |
| Menu, collapsed, button              | button, Menu, expanded           | heard                 |
| Bold, toggle button, not pressed     | toggle button, Bold, pressed     | heard                 |
| Save, button                         | link, Save                       | heard                 |
| button (no name)                     | Archive project, button          | left out of the score |

So the score cannot see a wrong role, a reversed state or a missing name. Those are the things a screen-reader user depends on most.

It also has other gaps:

- It only looks one way. Anything AEE's reader says that the real one doesn't is never shown, whether it is extra correct information or a mistake.
- When the real walk is cut off, the report doesn't say so.
- On a Mac, the benchmark is VoiceOver, which the owner ranks below NVDA and JAWS.

**Our code.**

- [`tests/reader-comparison.ts` 89–206](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/tests/reader-comparison.ts#L89-L206).
- `tests/readers.compare.ts` and `playwright.readers.config.ts`. That config's comment still mentions a third reader that no longer exists.

**Tested alternatives:**

- **[`diff` (jsdiff)](https://github.com/kpdecker/jsdiff) 9.0.0.** `diffWords` and `diffArrays` mark every part of two texts as added, removed or common, so nothing is thrown away and role and state words stay in.
- **Playwright aria snapshots** ([docs](https://playwright.dev/docs/aria-snapshots)). They check role, name and state per element against the browser's own tree rather than against VoiceOver's wording.
- **W3C ARIA-AT / AT Driver** ([AT Driver draft](https://w3c.github.io/at-driver/)). This is the spec-backed way to state what each reader _should_ say. Its automation harness supports only NVDA and VoiceOver today and has no releases.
- **`@guidepup/playwright` `nvdaTest`** is already installed, for NVDA on Windows.

**Verdict:**

- **Replace** the word-overlap score with a two-way jsdiff alignment that keeps role and state words. List what each reader said that the other didn't, and say why the real walk stopped. Effort S.
- **Question for the owner:** what should AEE's reader be judged against? (a) NVDA on Windows, (b) Chrome's accessibility tree, or (c) ARIA-AT-style assertions, which are spec-backed but whose tooling is immature. Effort M for (a) or (b), L for (c).

### B2. The AI naming score

**What it does.** `npm run score:ai` scores the AI's suggested names and alt text by how many words they share with one fixed answer. It removes filler words and a trailing "s" first. The README publishes the result: the free model "scored 48% and 50%".

**Example.**

- The README itself admits that a good chart description in other words scored 21%, and pasted junk text scored 15%.
- Extra words lower the score as much as missing ones. For alt text, that works against "more information beats less".
- The plural trimming is broken (tested): "processes" becomes "processe" and "process" becomes "proces", so they don't match.

**Our code.** [`tests/ai-score.ts` 41–157](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/tests/ai-score.ts#L41-L157), `tests/ai-score.score.ts` and `playwright.score.config.ts`.

**Tested alternative.** [`promptfoo`](https://www.promptfoo.dev/docs/configuration/expected-outputs/) 0.124.1 (October 2026).

- `llm-rubric` "Grades text … against a rubric".
- `similar` uses meaning (embeddings), not shared words.
- It also has deterministic checks and a latency check.
- It can use the local Ollama model as the grader, and can wrap AEE's own model provider.

**Verdict: question for the owner.** The tool covers the need. The open questions are what "right" means:

- short names (APG says "one to three words is sufficient" for many elements) against fuller alt text;
- one fixed answer against a rubric built from WCAG techniques;
- whether an AI grader is acceptable inside the test harness, given AEE's rule that AI never passes or fails anything on its own.

Until then, the published percentages overstate what the number shows.

**Effort:** M.

### B3. The test lab's heading outline

**What it does.** A test checks the lab page's headings as a list of tag names, such as `H1, H2, H3, H2`.

**Example.** A `<div role="heading" aria-level="2">` is missed, and a hidden `<h2>` is counted. The test passes today only because the lab page uses plain tags.

**Our code.** [`tests/test-lab.spec.ts` 46–48](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/tests/test-lab.spec.ts#L46-L48), with the expected outline in `site/test-lab-contract.json`.

**Tested alternative.** Playwright's `toMatchAriaSnapshot`, where headings carry a `level` ([docs](https://playwright.dev/docs/aria-snapshots)), or `getByRole('heading', { level })`.

**Verdict: replace.** It is spec-backed and records more about each heading.

**Built.** The gap was real. A new test page with an `<h1>`, a `<div role="heading" aria-level="2">`, an `aria-hidden` `<h2>`, an `<h3 role="presentation">` and an empty `<h2>` failed on the old check: it listed `H1, H2, H3, H2`, counting the hidden heading and the one with its role removed, and missing the `role="heading"` one, while a screen reader lists three headings. The check now reads the headings from the accessibility tree with Playwright 1.64's `getByRole("heading")`, which leaves out what is hidden from assistive technology, and checks each one's level with `toMatchAriaSnapshot` and its exact accessible name with `toHaveAccessibleName`; the name is checked on its own because an aria snapshot with a name of `""` matches any name. The expected outline in `site/test-lab-contract.json` now gives each heading's level and name, such as `{ "level": 2, "name": "Projects" }`, so it also catches a renamed or emptied heading; the Page view's tests read their "H1", "H2" labels from the same levels. The fixture lives in the test file, so the public lab page is unchanged. The lab's two pages use plain heading tags, so their outline was already right; this guards the check, not the pages.

**Effort:** S.

### B4. Removing VoiceOver's usage hints

**What it does.** Before comparing, the real reader's lines have VoiceOver's hints cut off with an English regex: everything from ". To click", ". To select", ". To begin" and similar.

**Example.** A page sentence like "Choose a plan. To begin, pick a size." loses its second half on the real reader's side.

**Our code.** [`tests/reader-comparison.ts` 55–67](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/tests/reader-comparison.ts#L55-L67).

**Tested alternative.** Guidepup accepts screen-reader settings at start-up (`StartOptions.settings`), exposed in `@guidepup/playwright` as `screenReaderStartOptions`. The exact VoiceOver setting that turns hints off was not verified.

**Verdict: question for the owner.** Switch hints off through Guidepup's supported settings (key unverified), or keep the regex?

**Effort:** S.

### Also found (not a tool question)

The public demo's "story" images contain some fixed text that does not come from a measurement:

- the hover story always shows "Tooltip shown";
- the palette story always shows "Required 4.50:1";
- the two AI suggestions are written by hand. They are marked `liveModelCall: false`, so that one is disclosed.

Only the verdict badges and numbers come from real runs ([`scripts/record-public-demo.mjs`](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/scripts/record-public-demo.mjs)).

---

## Part C: plumbing

These don't change accessibility results directly, but they add maintenance, and one of them is likely broken.

### C1. Calling OpenAI and local models

**What it does.** The OpenAI and local-model (Ollama, LM Studio) clients are written by hand with `fetch`. The OpenAI one reads a field called `output_text` from the reply.

**Example.** Choosing OpenAI as the AI provider very likely fails every time with "OpenAI Responses output did not include output_text."

Checked in the official SDK's source (`openai` 7.36.0):

- `output_text` is added by the SDK on your computer (`addOutputText` in `lib/ResponsesParser.js`), by joining the text parts of the reply;
- the SDK's own type comment tells you to use it "where supported in SDKs";
- so the raw reply AEE receives doesn't have it.

AEE's unit tests fake a reply that does contain `output_text`, so they hide the problem. This was not tested against the live API.

**Our code.** [`ai-fixes/src/model-providers.ts` 228–364](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/ai-fixes/src/model-providers.ts#L228-L364). Errors keep only the status code, and there are no retries.

**Tested alternative.** The official [`openai`](https://github.com/openai/openai-node) SDK. It takes a `baseURL`, so it also covers Ollama and other compatible servers, and it retries twice by default.

A smaller related item: the Claude client parses JSON itself, while the installed Anthropic SDK has a structured-output parse helper.

**Verdict: replace** both hand-written clients with the `openai` SDK.

**Built.** The bug was real. A unit test that fakes OpenAI's reply as the API sends it (the shape of the SDK's `Response` type, with the answer in `output[].content[]` and no top-level `output_text`) failed on the old client with "OpenAI Responses output did not include output_text.", for a plain request and for one with a screenshot. Both clients now call the `openai` SDK 7.28.0: OpenAI through `responses.parse`, and local models through `chat.completions.parse` with `baseURL` set to `AEE_LLM_BASE_URL`, so both read the answer with the SDK's structured-output parsing against the specialist's strict schema. The same tests pass, with new ones for an OpenAI refusal (an error, never a suggestion) and a retried 503. The local client sets every OpenAI credential itself, because the SDK otherwise reads `OPENAI_API_KEY`, `OPENAI_ADMIN_KEY`, `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` from the environment and would send them to the local server; a test holds that. It keeps no retries, as before. Still not run against the live OpenAI API: a live test is ready and runs when `OPENAI_API_KEY` and `AEE_LLM_MODEL` are set. The Claude client is unchanged; its JSON parsing was not broken, so moving it to the Anthropic SDK's parse helper stays a separate, smaller item.

**Effort:** S.

### C2. Validating evidence files

**What it does.** Two things:

- AEE's schema validator creates Ajv with `strict: false`.
- The report code reads several evidence files by hand and fills in defaults when data is missing. Examples: "No help text was provided.", or the fidelity defaulting to "semantic-simulation".

**Example.** A reader transcript with its `fidelity` field missing is read as if it said "semantic-simulation". Missing evidence looks present.

**Our code.**

- [`schemas/src/validator.ts` 86–89](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/schemas/src/validator.ts#L86-L89).
- [`scenario-runner.ts` 1315–1449, 1552–1674 and 5159–5181](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/scenario-runner.ts#L1315-L1449).

**Tested alternative.** Ajv's own defaults, and AEE's existing `assertValidSchema`.

- Ajv's [strict-mode page](https://ajv.js.org/strict-mode.html) says strict mode exists to prevent "silently ignored mistakes in user schemas".
- All 23 AEE schemas were compiled with Ajv's default options. They all compile, with one warning to fix (a `minItems` without `type: "array"`).
- So the switch-off isn't needed, and it is a disabled check, which the owner's rules forbid.

**Verdict: replace.** Turn strict mode back on (S), and validate every evidence file that has a schema instead of reading it by hand (M).

**C2a, strict mode: built.** Turning strict mode on found more than the one warning above, because Ajv's defaults only log `strictTypes`; raised to errors, it rejected three mistakes in AEE's own schemas, all a keyword with no type:

- `evidence-record.schema.json`: the accessibility-tree record's `meta` and the reader record's `meta` gave `properties` with no `"type": "object"`.
- `virtual-screen-reader-lane.schema.json`: a completed lane's `steps` had `minItems: 1` with no `"type": "array"`.

Each now names its type. They let no wrong data through, since the property's top-level definition already gave the type. The validator now runs with Ajv's defaults plus `strictTypes` and `strictTuples` as errors, so the next such mistake fails the build instead of being logged. Two other things strict mode reported are not mistakes:

- **Union types** (`"type": ["string", "number"]`, used three times). JSON Schema allows a list of types, so `allowUnionTypes` is on.
- **`strictRequired`** (36 conditional `required` keys). It stays at Ajv's default, off. Ajv compiles `if`/`then`, `anyOf` and `oneOf` before the `properties` beside them, so it flags a `required` there even when the property is declared, and every one of the 36 is.

A unit test compiles every schema, and another checks that strict mode rejects a missing type, an unknown keyword and an unknown format.

**C2b, evidence files validated by their schemas: open.** The report code still reads evidence files by hand with quiet defaults.

### C3. Giving AI agents the findings (MCP)

**What it does.** AEE's MCP `findings` tool hands an AI agent the PR-comment text. That text is capped at 5 elements per finding, 30 test names and 60,000 characters, and it leaves out checkpoints and evidence paths.

**Example.** An agent asked to fix every instance of a contrast failure sees only the first five.

**Our code.** [`mcp/src/index.ts` 20–27](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/mcp/src/index.ts#L20-L27).

**Tested alternative.** MCP structured tool output, supported by the installed SDK 1.32 ([MCP spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools)). Structured content is returned as JSON, and tools can declare an output schema.

**Verdict: replace.** Return the full report as structured content, with the comment as the text part.

**Effort:** S.

**Built.** The gap was real. A test writes a schema-valid assessment with one contrast finding on six elements, each with its contrast reading, and a checkpoint with its screenshot and axe paths, then calls `findings` over MCP as an agent does. On the old server the text listed five elements and "and 1 more in the full report", with no evidence path, and the result had no structured content at all. Both `findings` and `run` now return `{ verdict, assessments: [{ folder, report }] }` as MCP structured content, each `report` the whole `aee-report.json` and `folder` where its evidence paths start, with the pull-request comment kept as the text for clients that read only text, as the [MCP spec](https://modelcontextprotocol.io/specification/2025-06-18/server/tools#structured-content) asks. The output schema's report part is AEE's own `scenario-report.schema.json`, not a second copy: the installed SDK (1.32.1) takes an output schema only as zod, so the report is a zod `unknown` checked with `@aee/schemas`' validator and described with the schema itself through zod's `.meta()`, which zod writes into the JSON Schema the client receives. The client could not resolve that schema's `./common.schema.json` references, so `@aee/schemas` gains `bundledSchema`, which embeds each referenced AEE schema under `$defs` with its own `$id`, JSON Schema 2020-12's bundling. The SDK's client checks the structured content against it with Ajv, and the test passes through that check; a report that does not match the schema is a tool error naming the field.

### C4–C13. Smaller plumbing replacements

Each of these is a like-for-like swap with a maintained tool. All are effort S except C8.

- **C4. Posting the PR comment.** [`cli/src/pr-comment.ts` 85–207](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/pr-comment.ts#L85-L207) pages through GitHub's API by hand, ignores proxy settings and never retries.
  - Tool: [`@actions/github`](https://github.com/actions/toolkit/tree/main/packages/github). Its README says the client "follows the machine proxy settings" and sets GitHub Enterprise URLs. Add `@octokit/plugin-retry`.
  - **Replace.**
- **C5. Reading command-line options.** Three hand-written parsers in [`cli/src/index.ts`](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/index.ts#L288-L516).
  - Tool: Node's built-in [`util.parseArgs`](https://nodejs.org/docs/latest-v22.x/api/util.html#utilparseargsconfig). It has been stable since Node 20; AEE needs 22.13. It supports repeated options and rejects unknown ones.
  - **Replace.**
  - **Built.** There were more than three: besides the loops for `aee run <scenario.yml>`, `aee comment` and `aee fix`, `aee plan` looked for `--json` anywhere with `argv.includes`, and `aee run <config.json>` read nothing after the path. Those two were where options were silently ignored. New tests run the built `aee` on real command lines; on the old parsers they passed for every line that worked (20 lines across the four commands) and every refusal tested (16), and failed for these: `aee plan scenario.yml --jsno` printed the plan and exited 0; `aee comment reports --fail-on=never` said "Unknown comment option: --fail-on=never"; `aee fix … --start=--watch` said "Unknown fix option: --start=--watch". Not shown by a failing test, but read in the code and run by hand: `aee run config.json --ci` ran without `--ci`, `aee comment reports -p` read `-p` as a folder, `aee plan a.yml b.yml` planned `a.yml` alone, and `aee comment -- reports` refused `--`. A repeated option was not a bug: each parser kept the last value, and `--accept` added one fix each time, which `util.parseArgs` does too. Each command's arguments are now defined once in [`cli/src/command-line.ts`](../../packages/cli/src/command-line.ts) and read with `util.parseArgs` in strict mode, and the usage lines are written from the same definitions, so a usage line cannot list an option the command does not read (`aee` on its own had dropped `--images`). What `util.parseArgs` leaves to the caller (how many paths, required options, allowed values, no empty value) is checked in one place. One line that worked before no longer does: a value that starts with a dash given as its own word, such as `--output -reports`, is refused as ambiguous, since strict mode reads it as a slip; `--output=-reports` gives it. `util.parseArgs` adds no dependency.
- **C6. CSV.** The ticket CSV writer ([`scenario-runner.ts` 4094–4107](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/scenario-runner.ts#L4094-L4107)) and the test's parser ([`tests/ticket.spec.ts` 25–48](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/tests/ticket.spec.ts#L25-L48)) share the same assumptions. The test parser drops a last row with no line ending.
  - Tools: [`csv-stringify`](https://csv.js.org/stringify/), whose `escape_formulas` option is exactly AEE's spreadsheet-injection rule, and [`csv-parse`](https://csv.js.org/parse/).
  - **Replace.**
- **C7. Fingerprinting an approved plan.** [`cli/src/scenario.ts` 531–550](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/scenario.ts#L531-L550) sorts keys with `localeCompare`, which depends on the machine's language settings. A plan approved on one machine can show "digest mismatch" on another. That fails safe, but it is confusing.
  - Tool: [`canonicalize`](https://github.com/erdtman/canonicalize), the RFC 8785 standard.
  - **Replace.** Existing approvals change once.
  - **Built.** The bug was real, and bigger than the key sort. A test that runs `aee plan` on the same scenario with the machine set to English, Estonian, Lithuanian and `C` got two different digests on the old code: Estonian sorts "z" between "s" and "t", so a journey allowing `zoom-page` and `tab-to-page-end` listed them in another order. That was the plan's list of actions (and of origins), sorted with `localeCompare` before hashing, not its keys: AEE's keys are all lower camel case, where the old key sort and RFC 8785's agree. The digest is now the SHA-256 of the plan's RFC 8785 canonical JSON from `canonicalize` 5.1.0 (Apache-2.0, no dependencies, its own types, about 7 KB of code), and the lists are sorted by UTF-16 code unit, which is RFC 8785's order. Node 22 and 24 have no RFC 8785 serializer of their own; `JSON.stringify` keeps insertion order. A test checks the digest against `canonicalize` directly. Both examples' approved digests are unchanged, as is a plan approved on an English machine, since English and code-unit order agree for action names. The one English exception is allowed origins where a port meets a dot: English puts `http://x:8080` before `http://x.test` and code-unit order after, so a plan listing both changes once. A plan approved on a machine whose language ordered its actions or origins differently stops matching once, and `aee plan` and `aee run` now say so: either the scenario changed, or it was approved with AEE 0.8.0 or earlier, whose digest depended on the machine's language.
- **C8. TypeScript types for the schemas.** The types mirroring the JSON schemas are written by hand, so drift is only caught when validation fails at run time.
  - Tool: [`json-schema-to-typescript`](https://github.com/bcherny/json-schema-to-typescript), run as part of the build.
  - **Replace.** Effort M.
- **C9. Checking the published packages.** [`scripts/check-packages.mjs`](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/scripts/check-packages.mjs) checks the files and entry points in each package.
  - Tools: [`publint`](https://publint.dev/rules) (for example "FILE_NOT_PUBLISHED") and [`@arethetypeswrong/cli`](https://github.com/arethetypeswrong/arethetypeswrong.github.io), which checks types in each resolution mode. Our script checks neither of those things today.
  - **Add both.** Keep the end-to-end part, which no tool covers: installing on the oldest supported Playwright and running the CLI there.
- **C11. Serving test pages.** Three copies of a static file server ([`tests/scenario-helpers.ts` 34–60](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/tests/scenario-helpers.ts#L34-L60), `check-packages.mjs`, `record-public-demo.mjs`), each with its own different file-type table. That goes against the repo's own "no copy-paste" rule.
  - Tools: [`sirv`](https://github.com/lukeed/sirv) or `serve-handler`.
  - **Replace after checking** how the chosen one blocks `..` path tricks; its README doesn't say.
- **C12. Markdown on the site.** [`scripts/site-page.mjs` 26–33](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/scripts/site-page.mjs#L26-L33) has a bug, run and confirmed: bold and links inside a code span are rendered. No current page is affected.
  - Tool: `marked.parseInline`, already installed. Keep escaping raw HTML, since marked "does not sanitize the output HTML".
  - **Built.** A unit test (`scripts/site-page.test.mjs`) failed on the old renderer: `` `**name**` `` came out as `<code><strong>name</strong></code>` and `` `[label](https://example.com)` `` as a link inside the code. `inline()` now calls `parseInline` on a `Marked` instance from `marked` 18.1.1, and the test passes. Raw HTML is still escaped and shown as written: the instance's `html` renderer escapes each HTML token with the site's `escapeHtml`. The text it renders all comes from the repo (`docs/MASTER-PLAN.md` and `site/features.json`), so escaping is enough and DOMPurify, which marked recommends for untrusted text, would need a DOM in Node for nothing. A link's address is not filtered: the old renderer linked only `http(s)` addresses, so text from outside the repo would need DOMPurify first. The one page that changes is the roadmap, built at deploy and not committed: step 7.3's `([spec](qa-designer-view.md))` showed as raw markdown and is now a link. A relative link resolves against the file the text comes from (`inline(text, base)`; the plan's address is `planUrl` in `scripts/master-plan.mjs`), so it points at `docs/qa-designer-view.md` on GitHub, not at a missing page on the site. axe found no violations on the roadmap before or after, default and expanded, desktop 1280 and phone 390.
- **C13. Reading the a11y-skills index.** [`mcp/src/explain.ts` 120–137](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/mcp/src/explain.ts#L120-L137) reads a markdown table and front matter with regexes. If the format changes, it falls back quietly.
  - Tools: the `marked` lexer, which gives table tokens, and `yaml`, already used by the CLI.
  - **Replace.**
  - **Built.** The regex missed two rows of the real index, not only unusual ones. "Tab order jumps around" opens two patterns ("[focus-management] + [landmarks]") and "axe: ARIA attribute not allowed / invalid role" names one after other words ("the widget's own file, then [accessibility]"), and the regex wanted a cell holding exactly one link. So `explain("tab order jumps around")` answered with the tabs pattern and "ARIA attribute not allowed" with listbox; tests for both failed on the old code. A third test gives the same table written two valid ways, the usual one and one with Windows line endings, no outer pipes, aligned columns, trailing spaces and a `./` link with a title: the regex read one of the first table's three routes and none of the second's. The index is now read with the `marked` lexer: every table row that links to a `.instructions.md` file routes its words to each pattern it links. Front matter is found with `yaml`'s parser, which reads it as the YAML document it is and ends it at the next `---` line; the regex wanted `\n` line endings, and a test with `\r\n` failed on it. `marked` is pinned to 18.0.14 in `@aee/mcp`, the newest release at least two weeks old (18.1.0 was 14 days old), and `yaml` to 2.9.1, the version the CLI already uses.

### C10, C14–C16. Maintenance questions

- **C10. The dependency-graph guard** ([`scripts/graph-guard.test.mjs`](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/scripts/graph-guard.test.mjs)) makes three checks:
  - "Each package imports only what it declares" could be `eslint-plugin-import-x`'s `no-extraneous-dependencies`, a clean swap.
  - "The docs diagram matches reality" could be generated by `dependency-cruiser`.
  - "No browser driver reachable through installs": no tool was verified to cover this, so keep it.
  - **Question:** do the two swaps, or keep the one test as it is?
- **C14. The HTML report** is about 1,600 lines of template strings, with escaping done by hand at every insertion. Every page-derived value spot-checked was escaped. It also has its own tabs widget, modal viewer and "Ask this report" matcher.
  - A template library would make escaping automatic, but that is a large job for maintenance, not accessibility.
  - The tabs widget is accessibility code. It could be swapped for [`@github/tab-container-element`](https://github.com/github/tab-container-element), which says it follows the ARIA guide on tabs. Its keyboard support isn't listed, so parity with AEE's Arrow, Home and End keys is unverified. Or keep it, covered by AEE's own reader and keyboard tests.
  - **Question.**
- **C15. Markdown escaping** is done three different ways (`scenario-runner.ts` 3315–3342 and 5151; `reporter/src/index.ts` 558–570). The reporter's escaper doesn't escape `<`, `[`, `*` or `@` in page text.
  - Building the markdown from a syntax tree (`mdast-util-to-markdown`) would give one escaper. Its escaping guarantee was not verified.
  - **Question.**
- **C16. Watching the user's test presses.** [`cli/src/test-fixture.ts` 139–191](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/cli/src/test-fixture.ts#L139-L191) replaces Playwright's own methods at run time.
  - It works because of an internal detail of Playwright: locators call the frame's methods. `ElementHandle.click` skips that, so it isn't seen.
  - It can break silently on a Playwright upgrade. No public hook was found, but the search was inconclusive.
  - **Question:** keep it and pin a test to each Playwright upgrade, or move to public page events and lose some precision?

---

## Kept: no tool covers it, or it is glue

| What                                                                                                                                                                                                        | Why it stays                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Heading look-alikes ([`heading-lookalikes.ts`](https://github.com/Elizabeth1979/accessibility-evidence-engine/blob/1e48ed6cd9b95846edf9eaaa1812d0fc7d0956d9/packages/playwright/src/heading-lookalikes.ts)) | axe's `p-as-heading` only looks at `<p>` next to another `<p>` and is experimental. Ours compares Chrome's tree with the font style of all text. It could also run `p-as-heading` as a second opinion. |
| Contrast settled from screenshot pixels (`contrast-measurement.ts`)                                                                                                                                         | Settles what axe marks "needs review" because of background images and gradients, using axe's own required ratio. No tool does this. Its maths matches axe's.                                          |
| Colour-only, text-in-image, hover-only, pointer-only checks                                                                                                                                                 | axe's `link-in-text-block` only covers links. No tool checks the others. The text-in-image word list is English-only, which is a question if other languages matter.                                   |
| Waiting for a quiet page (`quiet-page.ts`)                                                                                                                                                                  | Playwright marks `networkidle` as "DISCOURAGED" and has no "page is quiet" API.                                                                                                                        |
| End-of-document check in the reader glue                                                                                                                                                                    | Matches Guidepup's English phrases. Keep, but pin it with a test so a Guidepup update can't break it silently.                                                                                         |
| Reader video overlay (`tests/reader-recording.ts`)                                                                                                                                                          | Playwright's screencast overlay is injected into the page without `aria-hidden`, so the reader could read it. Ours is hidden on purpose.                                                               |
| Guidepup bundle build (`scripts/build-guidepup-reader.mjs`)                                                                                                                                                 | esbuild, the same way `@axe-core/playwright` loads axe.                                                                                                                                                |
| Local model start script (`scripts/start-local-model.sh`)                                                                                                                                                   | Follows Ollama's documented install and settings, with a pinned version and checksum.                                                                                                                  |
| Site generators, master-plan parser                                                                                                                                                                         | Templates, prettier and drift checks for AEE's own files.                                                                                                                                              |
| Core engine, plugins, policy, release judge                                                                                                                                                                 | Wiring and policy; a rules-engine library would add weight for nothing.                                                                                                                                |
| Network observer                                                                                                                                                                                            | Redacts private data while recording. Playwright's HAR recording would redact only afterwards.                                                                                                         |
| `fix.ts`, `comment-images.ts`, MCP server, YAML handling                                                                                                                                                    | Already use the right tools (parse5, Babel, pngjs, the MCP SDK, `yaml` with safe settings).                                                                                                            |
| Interaction video, evidence manifest, pointer/keyboard comparison                                                                                                                                           | Use Playwright's own video and locators; the rest is formatting.                                                                                                                                       |

## What this audit could not verify

- **The OpenAI `output_text` problem (C1)** is shown from the SDK source and a unit test with the API's reply shape, not from a live call. The fix is built; it has not been run against the live API either.
- **The VoiceOver setting key** that turns hints off (B4).
- **`mdast-util-to-markdown`'s escaping guarantee** (C15).
- **Whether Playwright has any public action hook** (C16). The search was inconclusive.
- **How `sirv` and `serve-handler` block path tricks** (C11).
- **`culori`** was named but not checked (A16).
- **Guidepup missing an alert inserted into a quiet parent (A11)** is read from its source, not run.
