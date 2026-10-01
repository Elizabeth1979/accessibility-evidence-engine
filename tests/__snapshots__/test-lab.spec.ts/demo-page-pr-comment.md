## Accessibility: release blocked, 8 fixes needed

Tested `http://127.0.0.1:PORT/` against WCAG 2.2 A/AA. Evidence: complete.

| Area | Result |
| --- | --- |
| Keyboard access | Fix required |
| Virtual reader | Fix required |
| Semantics | Fix required |
| Visual contrast | Fix required |

### Blocking fixes (8)

<details>
<summary><strong>Works with a mouse only</strong> · WCAG 2.1.1 · 1 element</summary>

**Problem:** Keyboard users cannot reach or press it.

**Elements:**

- `Export report` at `#export-report`

**Fix:** Use a native button, or a link if it goes to another page, so it is in the Tab order and works with Enter and Space.

**Pattern:** [focus-management](https://github.com/Elizabeth1979/a11y-skills/blob/e0dfbeb50b453f9fd87423a1c7d4d29c9ccc4c15/patterns/focus-management.instructions.md) (a11y-skills)

</details>

<details>
<summary><strong>Shown on mouse hover only</strong> · WCAG 1.4.13 · 1 element</summary>

**Problem:** Keyboard and touch-screen users never see this content.

**Elements:**

- `Team plan · 5 seats · renews on 1 March` at `#plan-details`

**Fix:** Show the same content when its trigger gets keyboard focus, or put it behind a button that opens it, such as a details element.

**Pattern:** [tooltip](https://github.com/Elizabeth1979/a11y-skills/blob/e0dfbeb50b453f9fd87423a1c7d4d29c9ccc4c15/patterns/tooltip.instructions.md) (a11y-skills)

</details>

<details>
<summary><strong>Focus is lost after an action</strong> · WCAG 2.4.3 · 1 element</summary>

**Problem:** Keyboard and screen-reader users lose their place and have to start again from the top of the page.

**Elements:**

- `Archive project` at `#archive-project`

**Fix:** After the action, move focus to the element that replaces the one that disappeared, or to the next sensible control.

**Pattern:** [focus-management](https://github.com/Elizabeth1979/a11y-skills/blob/e0dfbeb50b453f9fd87423a1c7d4d29c9ccc4c15/patterns/focus-management.instructions.md) (a11y-skills)

</details>

<details>
<summary><strong>Buttons must have discernible text</strong> · WCAG 4.1.2 · 1 element</summary>

**Problem:** The confirmed rule failure can prevent people from understanding or operating the tested page as intended.

**Elements:**

- `Archive project` at `#archive-project`

**Fix:** Buttons must have discernible text. Fix every affected element listed here, then rerun the same authored journey.

**Pattern:** [buttons](https://github.com/Elizabeth1979/a11y-skills/blob/e0dfbeb50b453f9fd87423a1c7d4d29c9ccc4c15/patterns/buttons.instructions.md) (a11y-skills)

</details>

<details>
<summary><strong>Elements must meet minimum color contrast ratio thresholds</strong> · WCAG 1.4.3 · 1 element</summary>

**Problem:** Some people with low vision or reduced contrast sensitivity may not be able to read this text.

**Elements:**

- `Usage resets on the first day of each month.` at `#usage-hint`

**Fix:** Element has insufficient color contrast of 2.13 \(foreground color: #3f4c48, background color: #07110f, font size: 12.0pt \(16px\), font weight: normal\). Expected contrast ratio of 4.5:1 Choose a brand-approved foreground/background token pair that computes to at least 4.5:1 for this text, then verify every applicable default, hover, focus, and active state.

**Pattern:** [color-contrast](https://github.com/Elizabeth1979/a11y-skills/blob/e0dfbeb50b453f9fd87423a1c7d4d29c9ccc4c15/patterns/color-contrast.instructions.md) (a11y-skills)

</details>

<details>
<summary><strong>Images must have alternative text</strong> · WCAG 1.1.1 · 1 element</summary>

**Problem:** The confirmed rule failure can prevent people from understanding or operating the tested page as intended.

**Elements:**

- `Usage chart` at `#usage-chart`

**Fix:** Images must have alternative text. Fix every affected element listed here, then rerun the same authored journey.

**Pattern:** [image-labeling](https://github.com/Elizabeth1979/a11y-skills/blob/e0dfbeb50b453f9fd87423a1c7d4d29c9ccc4c15/patterns/image-labeling.instructions.md) (a11y-skills)

</details>

<details>
<summary><strong>Form elements must have labels</strong> · WCAG 4.1.2 · 1 element</summary>

**Problem:** The confirmed rule failure can prevent people from understanding or operating the tested page as intended.

**Elements:**

- `Project search` at `#project-search`

**Fix:** Form elements must have labels. Fix every affected element listed here, then rerun the same authored journey.

**Pattern:** [forms](https://github.com/Elizabeth1979/a11y-skills/blob/e0dfbeb50b453f9fd87423a1c7d4d29c9ccc4c15/patterns/forms.instructions.md) (a11y-skills)

</details>

<details>
<summary><strong>Links must have discernible text</strong> · WCAG 2.4.4, WCAG 4.1.2 · 1 element</summary>

**Problem:** The confirmed rule failure can prevent people from understanding or operating the tested page as intended.

**Elements:**

- `Help link` at `#help-link`

**Fix:** Links must have discernible text. Fix every affected element listed here, then rerun the same authored journey.

**Pattern:** [link](https://github.com/Elizabeth1979/a11y-skills/blob/e0dfbeb50b453f9fd87423a1c7d4d29c9ccc4c15/patterns/link.instructions.md) (a11y-skills)

</details>

### Advisory: reported, never blocks release (2)

<details>
<summary><strong>A message appears, but is not announced</strong> · WCAG 4.1.3 · 1 element</summary>

**Problem:** Screen-reader users press the control and hear nothing, so they do not know whether it worked.

**Elements:**

- `Project Alpha archived. You can restore it.` at `#action-status`

**Fix:** Show the message inside a live region that is on the page before the message appears: role=&quot;status&quot; for a confirmation or progress, role=&quot;alert&quot; for an error that needs attention now.

**Pattern:** [live-regions](https://github.com/Elizabeth1979/a11y-skills/blob/e0dfbeb50b453f9fd87423a1c7d4d29c9ccc4c15/patterns/live-regions.instructions.md) (a11y-skills)

</details>

<details>
<summary><strong>Headings should not be empty</strong> · 1 element</summary>

**Problem:** A best-practice result: it can make the page harder to use, but it is not a WCAG failure and does not block release.

**Elements:**

- `Usage heading` at `#usage-heading`

**Fix:** Headings should not be empty. Fix every affected element listed here, then rerun the same authored journey.

**Pattern:** [headings](https://github.com/Elizabeth1979/a11y-skills/blob/e0dfbeb50b453f9fd87423a1c7d4d29c9ccc4c15/patterns/headings.instructions.md) (a11y-skills)

</details>

**AI suggestions:** AI may suggest wording here, but aee run sends page evidence to a model only when you name one: set AEE\_LLM\_PROVIDER=local for a model on this machine \(Ollama with gemma4:e4b by default\), or AEE\_LLM\_PROVIDER=claude with ANTHROPIC\_API\_KEY.

<sub>The full report, with screenshots and evidence for every finding, is aee-report.html in the run's output. Evidence may contain sensitive page content.</sub>
