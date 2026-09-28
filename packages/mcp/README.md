# `@aee/mcp`

An [MCP](https://modelcontextprotocol.io) server that lets a coding agent use [Accessibility Evidence Engine](https://github.com/Elizabeth1979/accessibility-evidence-engine):

- `explain`: the [a11y-skills](https://github.com/Elizabeth1979/a11y-skills) pattern for an axe rule id (`button-name`), an AEE finding id (`pointer-only`), a pattern name (`dialog-modal`) or a UI element in words (`icon button`), through the same remediation registry every report links with.
- `findings`: the fixes in a folder of AEE assessments, as the pull-request comment lists them.
- `run`: runs a scenario a person has approved and returns its fixes.

It has no accessibility rules or model of its own, and it cannot apply a fix: `aee fix` does that, after a person reviews the suggestion. Start it over stdio with `aee-mcp`.

See the [project README](https://github.com/Elizabeth1979/accessibility-evidence-engine#readme) for setup and limitations.
