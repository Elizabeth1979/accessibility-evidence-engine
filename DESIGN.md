---
name: Accessibility Evidence Engine
description: An editorial review desk for scoped, evidence-led accessibility decisions.
colors:
  ink: "#17221e"
  muted-ink: "#5b6963"
  paper: "#fbfaf6"
  surface: "#ffffff"
  wash: "#edf2ee"
  line: "#c8d1cc"
  line-strong: "#87978f"
  forest: "#123d31"
  forest-deep: "#092a22"
  mint: "#a8e6ce"
  pass: "#087443"
  fail: "#a51d32"
  fail-wash: "#fff1f3"
  unknown: "#745900"
  unknown-wash: "#fff8df"
  focus: "#f6b73c"
typography:
  display:
    fontFamily: '"AEE Display", Georgia, serif'
    fontSize: "clamp(3rem, 7vw, 6rem)"
    fontWeight: 700
    lineHeight: 0.94
    letterSpacing: "-0.035em"
  headline:
    fontFamily: '"AEE Display", Georgia, serif'
    fontSize: "clamp(2rem, 4vw, 3.5rem)"
    fontWeight: 700
    lineHeight: 1.05
    letterSpacing: "-0.025em"
  title:
    fontFamily: '"AEE Display", Georgia, serif'
    fontSize: "clamp(1.3rem, 3vw, 1.75rem)"
    fontWeight: 700
    lineHeight: 1.15
  body:
    fontFamily: '"Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif'
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.6
  label:
    fontFamily: '"Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif'
    fontSize: "0.78rem"
    fontWeight: 800
    lineHeight: 1.4
    letterSpacing: "0.04em"
  mono:
    fontFamily: '"SFMono-Regular", Consolas, "Liberation Mono", monospace'
    fontSize: "0.78rem"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  focus: "2px"
  code: "4px"
  control: "8px"
  evidence: "12px"
  decision: "16px"
  pill: "999px"
spacing:
  xs: "0.5rem"
  sm: "0.75rem"
  md: "1rem"
  lg: "1.5rem"
  xl: "2rem"
  2xl: "3rem"
components:
  button-primary:
    backgroundColor: "{colors.forest}"
    textColor: "{colors.surface}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "0.75rem 1rem"
  button-primary-hover:
    backgroundColor: "{colors.forest-deep}"
    textColor: "{colors.surface}"
    rounded: "{rounded.control}"
  chip:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.forest-deep}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "0.5rem 0.75rem"
  chip-active:
    backgroundColor: "{colors.forest}"
    textColor: "{colors.surface}"
    rounded: "{rounded.pill}"
  input:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.control}"
    padding: "0.75rem"
  card:
    backgroundColor: "{colors.surface}"
    textColor: "{colors.ink}"
    rounded: "{rounded.evidence}"
    padding: "clamp(1.15rem, 3vw, 1.75rem)"
  decision-card:
    backgroundColor: "{colors.forest-deep}"
    textColor: "{colors.surface}"
    rounded: "{rounded.decision}"
    padding: "clamp(1.5rem, 4vw, 3.25rem)"
---

# Design System: Accessibility Evidence Engine

## Overview

**Creative North Star: "The Editorial Review Desk"**

The report should feel like an accessibility triage room already in motion: decisive enough for a release conversation, calm enough for sustained evidence review, and rigorous enough that every conclusion can be traced. An editorial hierarchy turns a dense technical record into a readable sequence of status, tested strengths, priority, proposed change, effort, and proof.

This is an evidence surface, not a scanner dashboard. Warm paper, deep forest decision fields, ruled rows, compact notation, and large display language establish authority without substituting decoration for evidence. Density increases deliberately as the reviewer moves from the first decision viewport into the technical annex.

**Key Characteristics:**

- Decisive, scoped status language rather than a universal score.
- Editorial display type paired with restrained, highly legible interface text.
- Evidence imagery and proposed states presented as review material, never decoration.
- Ruled rows and tonal layering instead of ornamental panels or dashboard chrome.
- Responsive reading order that preserves every claim and its proof.

## Colors

The palette combines warm paper neutrals with deep editorial greens; semantic red, green, amber, and a high-visibility gold focus treatment remain reserved for meaning.

### Primary

- **Review Forest:** The principal action and emphasis color for buttons, active navigation, priority markers, and strong editorial accents.
- **Decision Forest:** The darkest field for release status and other first-order decisions.
- **Evidence Mint:** A restrained highlight for positive notation on dark decision surfaces.

### Secondary

- **Pass Green:** Successful tested behavior and confirmed positive results.
- **Finding Red:** Confirmed blockers and failure badges; its pale companion carries failure backgrounds.
- **Review Amber:** Unresolved or human-review-required states; its pale companion carries uncertainty backgrounds.
- **Focus Gold:** Keyboard focus only. Its role is operational visibility, not decoration.

### Neutral

- **Editorial Ink:** Primary body copy and high-contrast content.
- **Muted Ink:** Supporting explanations, captions, and technical metadata.
- **Warm Paper:** The page canvas.
- **Clean Surface:** Inputs, evidence cards, and contained review material.
- **Quiet Wash:** Tonal grouping for answers, code, previews, and table captions.
- **Rule Line / Strong Rule:** Structural separators; use the stronger rule for section boundaries and interactive outlines.

### Named Rules

**The Meaning Before Mood Rule.** Semantic colors communicate a tested result or interaction state; never use them merely to make a section more colorful.

**The No Score Gradient Rule.** Never turn the report into a red-to-green accessibility percentage or imply coverage beyond the authored scenario.

## Typography

**Display Font:** AEE Display (with Georgia fallback)

**Body Font:** Avenir Next (with Avenir, Segoe UI, system UI fallbacks)
**Label/Mono Font:** Avenir Next for compact labels; SFMono-Regular for identifiers and captured code

**Character:** The bundled variable display face makes decisions and section openings feel editorial and authored. The humanist sans keeps controls and long explanations familiar, while monospace appears only where technical identity matters.

### Hierarchy

- **Display:** The assessed page name and the most decisive first-viewport statement; tightly set and balanced over short measures.
- **Headline:** Major report sections and decision-scale headings.
- **Title:** Finding names, evidence groups, and compact editorial subheads.
- **Body:** Explanations, conclusions, and controls; keep long explanatory passages near 58–72 characters wide.
- **Label:** Short status flags, metadata labels, badges, and control copy; uppercase is reserved for compact notation.
- **Mono:** Rule identifiers, selectors, evidence paths, and captured HTML only.

### Named Rules

**The Decision Has a Voice Rule.** Display type states the assessment and its hierarchy; body type explains it. Do not set whole interfaces or long technical passages in the display face.

**The Portable Face Rule.** Ship the display font with the report and retain the defined fallback stack so the hierarchy does not depend on a reviewer’s installed fonts.

## Layout

The report uses a centered content shell capped at 1220px with fluid page padding. The masthead and first decision area use asymmetric two-column grids: the primary conclusion receives more width than metadata or the local report assistant. Section rhythm is created with strong horizontal rules, generous vertical intervals, and compact internal spacing rather than a field of equal cards.

Evidence comparisons use two equal columns, while prioritized fix rows reserve narrow columns for sequence and effort around a flexible evidence narrative. At 1000px the decision room stacks and effort moves below the finding. At 900px paired evidence and major header grids become single-column. At 680px all remaining paired review structures linearize without changing DOM reading order; at 560px page padding and metadata grids compress for narrow phones. Wide technical tables remain horizontally scrollable rather than collapsing their evidence columns.

**The Decision-to-Detail Rule.** Begin spacious and decisive, then allow density to rise as the reader enters evidence and the annex.

**The Reading Order Rule.** Responsive layouts may stack, scroll, or regroup, but they never hide evidence or rearrange the semantic reading order.

## Elevation & Depth

The system is flat by design and uses no box shadows. Depth comes from tonal contrast, borders, inset grouping, dark decision fields, image cropping, and the transition from paper canvas to clean evidence surfaces.

**The Ruled Surface Rule.** Use a line, tone, or dark field to establish hierarchy. A shadow is not part of this report language.

## Shapes

The form language distinguishes function by radius. Decision rooms use broad, composed corners; evidence containers use a moderate radius; controls and fields use compact corners; code uses only a slight softening. Status badges and filter chips are fully pill-shaped, while the report’s structural rows remain square and ruled.

**The Radius Has Meaning Rule.** Large corners belong to decision zones, medium corners to bounded evidence, compact corners to controls, and pills to terse semantic labels or filters.

## Components

### Buttons

- **Shape:** Compact control corners with confident padding; question prompts and filters use the pill treatment.
- **Primary:** Review Forest with white text and a heavy compact label.
- **Hover / Focus:** Hover deepens to Decision Forest. Keyboard focus is always a three-pixel Focus Gold outline with a three-pixel offset.
- **Chip / Filter:** Warm Paper at rest, then Review Forest with white text for hover and selected states.

### Chips

- **Style:** Thin strong rule, pill silhouette, compact heavy text, and restrained internal padding.
- **State:** Selected filters invert to the primary forest treatment; semantic badges instead use the dedicated pass, finding, or review palette.

### Cards / Containers

- **Corner Style:** Evidence containers are moderately rounded; the decision brief and report assistant use the broader decision radius.
- **Background:** Clean Surface for contained review material, Quiet Wash for supporting explanation, and Decision Forest for release status.
- **Shadow Strategy:** None; borders and tonal fields carry structure.
- **Border:** Rule Line for contained evidence, Strong Rule for interactive and sectional boundaries.
- **Internal Padding:** Fluid on major surfaces, compact and consistent on evidence cards.

### Inputs / Fields

- **Style:** Clean Surface, one-pixel Strong Rule, compact control corners, and body typography.
- **Focus:** The shared Focus Gold outline is never replaced by color shift alone.
- **Error / Disabled:** Do not infer a failure state from generic input styling; use explicit copy and semantic treatment when such a state is implemented.

### Navigation

Report tabs are horizontally scrollable, bold text links with a three-pixel bottom rule for the selected state. Hover introduces a quiet rule; selected state uses Review Forest. The navigation remains a single readable strip on narrow screens rather than becoming an undiscoverable menu.

### Status Brief

The signature decision surface pairs a short pill flag, a large scoped release statement, a concise explanation, and three factual measures. It never reduces the assessment to a giant percentage and always keeps positive tested behavior visible beside blockers.

### Fix Review Row

Each row keeps priority, finding, current evidence, honest proposed state, impact, focused effort, and traceability actions together. Captured regions may be magnified and annotated; proposed visuals must be labeled as proposals and never impersonate implemented screenshots.

## Do's and Don'ts

### Do:

- **Do** lead with the scoped release decision, confirmed issue count, positive tested behaviors, and focused effort.
- **Do** use ruled rows and tonal surfaces to organize dense evidence.
- **Do** magnify or annotate affected regions and keep a route to the full capture.
- **Do** preserve visible keyboard focus, semantic labels, and the same evidence in every responsive layout.
- **Do** keep conversational answers local to captured evidence and visibly bounded by the authored scenario.

### Don't:

- **Don't** present an accessibility percentage, universal conformance claim, or certainty the evidence does not support.
- **Don't** use decorative gradients, ornamental shadows, or generic dashboard card grids.
- **Don't** present a simulated proposal as an implemented result.
- **Don't** hide technical proof to simplify mobile layouts; linearize it or make wide tables scroll.
- **Don't** use semantic status colors as ambient decoration.
