# `@aee/cli`

Approved-scenario and fixture command-line runner for [Accessibility Evidence Engine](https://github.com/Elizabeth1979/accessibility-evidence-engine).

```bash
aee doctor
aee plan path/to/scenario.yml
aee run path/to/scenario.yml --open
aee run path/to/scenario.yml --ci --output aee-output/scenarios
```

The YAML owns the goal, scope, allowed and forbidden actions, concrete commands, and exact approved plan digest. The runner executes only the authored portable-reader commands and pointer/keyboard comparisons in isolated Playwright contexts. It writes integrated HTML, JSON, and Markdown reports plus a scenario-level checksummed manifest. `--ci` fails for a failed, unknown, or incomplete result.

`aee doctor` checks that this machine can run `aee run`: Node.js and `@playwright/test` against the ranges in this package's `package.json` (compared with `semver`), Chromium started the way `aee run` starts it, the output folder (`--output <dir>`, default `aee-output`) writable and ignored by git, and the AI policy. Each failing check prints the exact command or setting that fixes it, and the exit code is 1 while any check fails. A missing AI provider or real screen reader is information, not a failure. A model named in `AEE_LLM_PROVIDER` is checked by asking its server for its model list, which sends no page evidence. `--json` prints `{ ready, checks }`, each check with `id`, `title`, `status` (`ok`, `fail` or `info`), `detail`, and `fix` when it fails or `optional` for what can be turned on.

Legacy JSON fixture execution remains available with `aee run path/to/config.json`. Generated evidence may contain sensitive data and must be reviewed before sharing.

See the [project README](https://github.com/Elizabeth1979/accessibility-evidence-engine#readme) for setup, status, and limitations.
