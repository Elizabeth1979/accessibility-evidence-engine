# Security Policy

## Supported versions

AEE is currently a pre-release project. Security fixes are made on the `main` branch and included in the next release. Older commits and unpublished package builds are not maintained as separate supported versions.

## Reporting a vulnerability

Do not report suspected vulnerabilities in a public issue, discussion, pull request, or test artifact.

Use the repository's [private vulnerability reporting form](https://github.com/Elizabeth1979/accessibility-evidence-engine/security/advisories/new). Private vulnerability reporting must be enabled in the repository settings when this project is published. If that form is unavailable, do not disclose the issue publicly; contact the maintainer through the contact method on the [maintainer's GitHub profile](https://github.com/Elizabeth1979) and request a private reporting channel.

Include, when applicable:

- the affected commit, package, API, or configuration;
- the impact and conditions required to reproduce it;
- a minimal reproduction that contains no real credentials or private evidence;
- whether the issue can expose DOM, accessibility-tree, screenshot, focus, network, or filesystem data; and
- any suggested mitigation or patch.

You should receive an acknowledgment within five business days and a status update within ten business days. Timelines for a fix and disclosure will depend on severity and complexity. Please allow maintainers a reasonable opportunity to investigate and release a fix before public disclosure.

## Security-sensitive areas

Examples include:

- bypasses of network or artifact redaction;
- unintended capture or disclosure of credentials, personal data, or private application state;
- unsafe artifact or output-path handling;
- arbitrary code execution or file access through configurations, fixtures, plugins, or reports;
- schema-validation bypasses with security impact; and
- vulnerable runtime dependencies.

Accessibility false positives, false negatives, missing rules, and ordinary crashes are normally bugs rather than security vulnerabilities unless they also cross a security or privacy boundary.

## Evidence handling

AEE artifacts can contain sensitive test data even when the engine is functioning as designed. Review [Evidence privacy](docs/privacy.md) before collecting or sharing output. Do not submit real workplace evidence with a vulnerability report unless the maintainer has agreed on a secure transfer method.
