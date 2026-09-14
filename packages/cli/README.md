# `@aee/cli`

Approved-scenario and fixture command-line runner for [Accessibility Evidence Engine](https://github.com/Elizabeth1979/accessibility-evidence-engine).

```bash
aee plan path/to/scenario.yml
aee run path/to/scenario.yml --open
aee run path/to/scenario.yml --ci --output aee-output/scenarios
```

The YAML owns the goal, scope, allowed and forbidden actions, concrete commands, and exact approved plan digest. The runner executes only the authored portable-reader commands and pointer/keyboard comparisons in isolated Playwright contexts. It writes integrated HTML, JSON, and Markdown reports plus a scenario-level checksummed manifest. `--ci` fails for a failed, unknown, or incomplete result.

Legacy JSON fixture execution remains available with `aee run path/to/config.json`. Generated evidence may contain sensitive data and must be reviewed before sharing.

See the [project README](https://github.com/Elizabeth1979/accessibility-evidence-engine#readme) for setup, status, and limitations.
