# QA and designer view

A design spec for master plan step 7.1: bring three tools the owner already built into the HTML report, so QA and designers get a report made for them, not only for developers. Step 7.3 built the Page view with its first two layers and the announcement list, step 7.4 the tickets and the CSV, and step 7.5 the Headings, Tab order, Images and Focus indicator layers.

![Mockup of the Page view, drawn from a real run of the test lab's demo page: numbered issue markers and the screen reader's path on the page as tested, with the lists beside them.](diagrams/qa-designer-view-mockup.png)

## Why

The report answers a developer's questions: which rule, which element, what fix. QA and designers ask different ones:

- **Where on the page is it?** The bookmarklets draw headings, tab order, alt text and focus on a live page.
- **What does a screen-reader user hear?** sr-visualizer lists each announcement and highlights its element.
- **Can I file it?** clip-to-ticket turns a finding into a ticket someone else can act on.

Each works on a live page or a recording. This view gives the same answers from the evidence a run already captured, inside the one report the team already shares.

## Rules the view keeps

1. **Evidence only.** The report never loads or injects into the live page; reporters do not query the page ([architecture](architecture.md)). Every overlay is drawn from boxes captured during the run, on the run's own full-page screenshot. So it shows the page as tested, and it works offline, in a CI artifact, months later.
2. **Measured, not guessed.** Tab order is the order the sweep's Tab presses actually reached, not a selector list sorted by `tabindex` as the bookmarklet does. Headings include `role="heading"` with `aria-level`, read from the accessibility tree, which the bookmarklet misses.
3. **Meaning before mood** ([design](../DESIGN.md)). Colour marks results only: Finding Red for blocking, Review Amber for advisory or needs review, Pass Green for a pass. There is no per-level rainbow. Every marker also carries a number or a text label, so nothing relies on colour alone (WCAG 1.4.1).
4. **The list is the interface; the picture illustrates it.** Each layer is a list that works by keyboard and screen reader. The markers on the screenshot mirror the list: selecting an item outlines its marker and scrolls it into view. Markers are not tab stops, since a page can have hundreds.
5. **Works without screenshots.** With screenshot capture off ([privacy](privacy.md)), the lists remain and the picture area says it was not captured.
6. **Same scope, no score.** A layer shows what the run tested. A layer with nothing to show says so, and nothing becomes a percentage.
7. **Accessible itself.** Keyboard only, screen reader, reduced motion, 200% zoom and 320 px width, and axe finds no violations in any state.

## 1. Page view: overlays (from the bookmarklets)

A **Page view** tab (`#panel-page`), after Status & plan, built in step 7.3. It has three parts:

- **Layers:** a group of checkboxes (`fieldset` and `legend`) that show or hide a layer's markers and its list together, with CSS alone.
- **Page states:** one section per screenshot, named by what captured it, such as "As the virtual screen reader read it". Each box is drawn only on the screenshot it was measured on, never moved onto another capture. So a run whose findings come from two captures shows two sections, not a picker that could put a box on the wrong picture.
- **Page and lists:** the full-page screenshot with the chosen layers drawn over it in SVG, then the lists.
  - Selecting an item outlines its marker and moves the picture to it.
  - The markers are hidden from assistive technology: the picture is one labelled image, and the lists say everything it shows.

On a phone the full page would be a thumbnail too small to read, as the mockup's phone width showed. The report's rule is to magnify affected regions rather than show unreadable full-page thumbnails ([report surface](accessibility-report-surface.md)). So on a phone:

- the picture shows at a readable scale in a box pinned above the lists;
- selecting an item moves the picture to it;
- a focused item always scrolls clear of the pinned box.

This replaced the separate crops first planned here, since one picture that moves shows the element in its surroundings.

Issues and the screen reader path start switched on; the other four start off, so the picture stays readable until someone asks for more.

| Layer              | What it draws                                                                                                          | Harvested from     | Data                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- | ------------------ | ---------------------------------------------------- |
| Issues             | A numbered outline for each affected element: red when it blocks release, amber when advisory                          | New                | Each finding instance's `targetBox`                  |
| Screen reader path | A numbered dashed outline for each announced item, in reading order                                                    | sr-visualizer      | Each reader entry's `visualBounds`                   |
| Headings           | An "H1"–"H6" label and outline for each heading; the list is indented by level and flags an empty heading or a skip    | highlight-headings | The element map                                      |
| Tab order          | A numbered badge for each Tab stop, in the order Tab reached it, with the keyboard problems found on it                | show-tab-order     | Each sweep Tab stop's name, role and box             |
| Images and alt     | For each image: "No alt" (red), "Decorative", or its alt text                                                          | show-alt-text      | The element map                                      |
| Focus indicator    | For each Tab stop, a close-up of it with focus, flagged "No visible focus" where it looks the same with and without it | focus-indicator    | Each sweep Tab stop's close-up and focus measurement |

Unlike the bookmarklets, which read `document.querySelectorAll`, the boxes come from the browser's own DOM snapshot, so content in shadow roots is included. Headings and images get their role, name and level from the accessibility tree, as a screen reader does.

A heading level can be wrong without skipping one: the lab's Workspace settings is a level 3 heading under Projects, although it is a peer section. The layer does not flag that, since only the page's meaning tells it is wrong. It indents the heading under Projects, where a person sees it. Frames are a gap today: the snapshot reads the top document only, and the element map should add each frame's document, offset by its frame's box.

## 2. What the screen reader said (from sr-visualizer)

The announcement list sits in the Page view, beside the path it lists, rather than on the Tested journeys tab: selecting an item outlines its element, which the journeys tab has no picture for. The reader table stays on the Tested journeys tab as the full evidence.

- **Each item, in order:** its number, the phrase as announced, and its role and name in words. That replaces sr-visualizer's colour dot, which showed its place in the list, not a meaning.
- **"No name":** an item announced without a name is marked "No name" in Finding Red, the same rule as the Virtual reader status row.
- **Selecting an item** outlines its element on the page, which is the Screen reader path layer.
  - The list items are buttons with `aria-current` on the selected one.
  - Previous and Next move through them, with "3 of 6".
  - Nothing plays or moves on its own, and the outline does not animate under reduced motion.
- **The scope, in words:** it lists what the scenario's reader commands reached, not the whole page; add commands to cover more.

Reading the phrase aloud with the browser's voice is left for later. If it is added, it must say it is the browser's voice, not a screen reader.

## 3. Copy as ticket (from clip-to-ticket)

Built in step 7.4:

- **Per fix:** each fix row in Fix review has **Copy as ticket**, which puts the Markdown below on the clipboard. Where the browser blocks copying, as some do for a file opened from disk, the row opens its **Ticket text** and selects it instead, so Ctrl+C or Command+C finishes the job.
- **For all fixes:** every run writes `aee-fixes.csv` beside the report, one row per fix with the same fields as columns, and Fix review links to it as **Download all fixes as CSV**. Cells follow RFC 4180. A cell that a spreadsheet would run as a formula (starting with =, +, -, @ or a tab) is kept as text, since page text can start with anything. Tests using the Playwright fixture get the CSV attached to their results.
- **Offline:** the report calls no tracker API. It stays offline, and filing is the person's action.
- **Expected and actual:** for an axe rule, "expected" is the rule's own requirement, such as "Buttons must have discernible text". For the sweep's own findings, a sentence says what should happen instead, such as "Tab reaches it, and Enter or Space does what a click does", since their titles name the problem. "Actual" is what the virtual screen reader announced at the element when the run reached it, and otherwise the measured failure, such as the contrast ratio.
- **Page text is escaped:** it never turns into Markdown or HTML in the tracker. An axe message mentioning `<label>` stays text.

| Field              | From the report                                                                                 | clip-to-ticket field |
| ------------------ | ----------------------------------------------------------------------------------------------- | -------------------- |
| Title              | The finding's title and the element's label                                                     | `issue_title`        |
| Severity           | Blocks release or Advisory                                                                      | `severity`           |
| WCAG               | The registry's criterion, title, level and Understanding link                                   | `wcag_reference`     |
| Rule               | The axe rule or AEE finding id and its documentation link                                       | `axe_rule_id`        |
| How to build it    | The a11y-skills pattern link                                                                    | `apg_pattern`        |
| Where              | The page address, the element's selector and the page state                                     | New                  |
| Steps to reproduce | The journey's start address and the actions up to the checkpoint, from the run                  | New                  |
| Expected / actual  | Expected from the fix; actual from the evidence, such as the announcement or the measured ratio | New                  |
| Suggested fix      | The deterministic fix, then any AI suggestion, labelled "AI suggestion, review before use"      | `suggested_fix`      |
| Affected elements  | How many, and which                                                                             | New                  |
| Evidence           | The report's file name and the crop's image file, to attach                                     | `screenshot_context` |

Clip-to-ticket had no steps to reproduce and no expected and actual; a run knows both. Not carried over:

- **Dropped fields:**
  - `ease_of_fix`: the report already estimates effort per group.
  - `status`, the timestamp and the video index: these belong to recordings.
  - A separate generated-alt-text field: it is the AI suggestion.
- **Its WCAG and APG data files:** the registry already has each criterion's number, title, level and link, and the master plan keeps those files out unless the registry proves insufficient.
- **Example media and names:** none of clip-to-ticket's example media or names come across.

For example, the demo page's unnamed archive button, from a real run with the lab's stand-in model:

```markdown
### Buttons must have discernible text: Archive project

- **Severity:** Blocks release
- **WCAG:** 4.1.2 Name, Role, Value (A) https://www.w3.org/WAI/WCAG22/Understanding/name-role-value.html
- **Rule:** `button-name` https://dequeuniversity.com/rules/axe/4.13/button-name
- **How to build it:** https://github.com/Elizabeth1979/a11y-skills/blob/<commit>/patterns/buttons.instructions.md
- **Where:** http://127.0.0.1:4173/test-case.html, `#archive-project`, as the virtual screen reader read it
- **Steps to reproduce:**
  1. Open http://127.0.0.1:4173/test-case.html.
  2. Find Archive project (#archive-project).
  3. Check: Buttons must have discernible text.
- **Expected:** Buttons must have discernible text
- **Actual:** The virtual screen reader announced "button" at #archive-project.
- **Suggested fix:** Buttons must have discernible text. Fix every affected element listed here, then rerun the same authored journey.
- **AI suggestion, review before use:** "Archive Project Alpha" for #archive-project (suggested by AI, lab-fixture)
- **Affected elements:** 1: Archive project (#archive-project)
- **Evidence:** `aee-report.html`, `lab-page-virtual-reader/lab-page-virtual-reader-001/artifacts/visual-full-page-after.png`
```

## Data the layers read

Step 7.5 closed the three gaps this spec found. None needs a new kind of browser access:

1. **Element map.** Every checkpoint saves `element-map-after.json` beside its full-page screenshot, from the same accessibility tree and DOM snapshot the reader reads. It lists the page's headings and images, each with its role, name, level or alt state, and its box in page coordinates. An empty heading keeps its place although it has no height. Landmarks and focusable elements are left out until a layer draws them.
2. **Tab stops.** The sweep records each stop's accessible name and role, from the accessibility tree, and its box on the sweep's screenshot. It saves a close-up of each stop as Tab reached it, then takes the same region again with focus removed. Focus counts as visible when the two differ by more than rendering noise: pixels, not styles, so a ring drawn on a wrapper, or a colour change, counts. It says nothing about the indicator's contrast (WCAG 2.4.11, 2.4.13).
3. **Page size for reader boxes.** Taken from the checkpoint's screenshot, since 7.3.

## Out of scope

- **Drawing on the live page:** the bookmarklets stay a separate tool for that.
- **A real screen reader's voice:** that is Milestone 4's VoiceOver and NVDA lane.
- **Filing tickets from the report through a tracker's API.**
- **clip-to-ticket's video analysis.**
