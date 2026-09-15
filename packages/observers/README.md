# `@aee/observers`

DOM, accessibility-tree, focus, visual, pinned axe, and privacy-sanitized network observers for [Accessibility Evidence Engine](https://github.com/Elizabeth1979/accessibility-evidence-engine).

The visual observer captures separate viewport and full-page PNGs before and after an interaction. The accessibility-tree observer preserves the raw tree and emits a bounded normalized role/name/heading-level index for deterministic correlation. The axe observer preserves the complete axe 4.13 result for the cumulative WCAG 2.0, 2.1, and 2.2 A/AA tag selection. The portable virtual-reader observer writes canonical JSON and readable TXT transcripts while recording its semantic target and whether virtual navigation moved DOM focus. Guidepup remains a declared extension point.

See the [project README](https://github.com/Elizabeth1979/accessibility-evidence-engine#readme) for the capability matrix and limitations.
