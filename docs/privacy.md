# Evidence Privacy

AEE evidence should be treated as potentially sensitive test output. Use test accounts and non-production environments whenever possible, restrict access to output directories, and apply an appropriate retention policy.

## Network redaction

Network artifacts are sanitized before they are written to disk, including network logs supplied through a custom page adapter. AEE:

- removes URL usernames, passwords, and fragments;
- preserves query parameter names but replaces every query value with `[REDACTED]`;
- preserves header names but replaces every header value with `[REDACTED]`;
- replaces request bodies with `[REDACTED]`; and
- drops unrecognized event properties rather than persisting arbitrary payloads.

The URL scheme, host, port, and path remain visible because they are used to correlate requests and responses. Do not place credentials, personal information, or other secrets in URL paths.

## Evidence that is not automatically redacted

DOM snapshots, accessibility-tree snapshots, focus metadata, screenshots, target descriptions, and generated reports can contain page text, accessible names, form values, identifiers, filesystem paths, or other information from the tested environment. AEE cannot reliably remove this content without also damaging the evidence.

Before sharing an output bundle:

1. Review every generated artifact and report.
2. Remove or manually redact sensitive content.
3. Share only the artifact types needed for the investigation.
4. Do not commit `aee-output/`, `test-results/`, or `playwright-report/`; these paths are ignored by this repository but may need separate controls in a consuming project.

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
