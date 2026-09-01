# Evidence Privacy

AEE evidence should be treated as potentially sensitive test output. Use test accounts and non-production environments whenever possible, restrict access to output directories, and apply an appropriate retention policy.

## Network redaction

Network artifacts are sanitized before they are written to disk, including network logs supplied through a custom page adapter. AEE:

- removes URL usernames, passwords, and fragments;
- preserves query parameter names but replaces every query value with `[REDACTED]`;
- preserves header names but replaces every header value with `[REDACTED]`;
- replaces request bodies with `[REDACTED]`; and
- reconstructs recognized event properties only from their expected primitive types; and
- drops malformed or unrecognized event properties rather than persisting arbitrary payloads.

Malformed URL strings are replaced completely with `[REDACTED]` rather than being persisted.

The URL scheme, host, port, and path remain visible because they are used to correlate requests and responses. Do not place credentials, personal information, or other secrets in URL paths.

## Evidence that is not automatically redacted

DOM snapshots, accessibility-tree snapshots, focus metadata, screenshots, target descriptions, and generated reports can contain page text, accessible names, form values, identifiers, filesystem paths, or other information from the tested environment. AEE cannot reliably remove this content without also damaging the evidence.

Optional AI fix providers can receive the bounded context supplied by the caller, including nearby headings, visible copy, icon descriptions, and destination or dialog text. AEE does not automatically redact that model input. Minimize it, prefer synthetic data, and review the selected provider's data-handling requirements before sending captured UI context.

Before sharing an output bundle:

1. Review every generated artifact and report.
2. Remove or manually redact sensitive content.
3. Share only the artifact types needed for the investigation.
4. Do not commit `aee-output/`, `test-results/`, or `playwright-report/`; these paths are ignored by this repository but may need separate controls in a consuming project.
5. Do not send captured production content to a model provider without authorization.

You can omit an observer from `observers` to prevent that evidence type from being captured. Capture policy can also disable DOM, accessibility-tree, and screenshot collection:

```ts
policy: {
  capture: {
    includeDomSnapshot: false,
    includeAccessibilityTree: false,
    includeScreenshots: false
  }
}
```

Network collection is opt-in: it occurs only when the `network` observer is selected.
