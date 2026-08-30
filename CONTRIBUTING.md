# Contributing to Accessibility Evidence Engine

Thank you for helping improve AEE. The project is an early public preview, so focused issues, reproducible examples, tests, and documentation corrections are especially valuable.

By submitting a contribution, you agree that it may be distributed under the repository's [Apache License 2.0](LICENSE).

## Before you start

- Search existing issues before opening a new one.
- Use the bug or feature-request form so maintainers receive the context needed to respond.
- For a substantial API, schema, policy, or architecture change, open an issue before investing in an implementation.
- Report security problems privately according to [SECURITY.md](SECURITY.md).
- Do not include credentials, personal data, private application output, or proprietary page evidence in issues, commits, tests, or pull requests.

All participation must follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Development setup

Install the locked dependency tree and build the workspaces:

```bash
npm ci
npm run build
```

Install Chromium when working on the real-page integration:

```bash
npm run playwright:install
```

## Project principles

Changes should preserve these boundaries:

- Observers collect evidence; they do not make accessibility judgments.
- Judges consume normalized evidence rather than querying a live page.
- `unknown`, unsupported capture, and observer errors are distinct from pass and fail.
- Release decisions must be traceable to judgments and evidence identifiers.
- Network information must be sanitized before persistence.
- A passing result must not be described as WCAG certification.

See [Architecture](docs/architecture.md) and [Observer lifecycle](docs/observer-lifecycle.md) for more detail.

## Making a change

1. Create a focused branch from the latest `main`.
2. Keep the change limited to one concern.
3. Add or update tests for behavioral changes.
4. Update JSON Schemas when a serialized contract changes.
5. Update documentation when behavior, configuration, or limitations change.
6. Review generated evidence for sensitive information before attaching it anywhere.

The repository uses strict TypeScript, ESLint, and Prettier. Follow the existing naming and import style, then run the automated checks below.

## Required checks

Run the same checks used by continuous integration:

```bash
npm audit --audit-level=high
npm run check
npm run format:check
npm run lint
npm run test:unit
npm run test:coverage
npm run test:playwright
```

If a change does not require a browser test, explain why in the pull request rather than silently omitting the check.

## Pull requests

A useful pull request:

- explains the problem and the chosen approach;
- links the relevant issue when one exists;
- describes user-visible or schema changes;
- lists the checks that were run;
- calls out privacy, compatibility, or release-policy implications; and
- avoids unrelated generated files or refactoring.

Maintainers may ask for changes to preserve evidence traceability, backward compatibility, privacy, or honest accessibility claims.
