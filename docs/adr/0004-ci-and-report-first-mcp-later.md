# ADR 0004: CI and the report come first; MCP is one more surface

**Status:** Accepted, 2026-09-27
**Origin:** accessibility-engine ADR 0005 ("agent-native MCP is the primary surface"), changed.

## Context

accessibility-engine made its MCP server the main way to run it: the developer's coding agent runs investigations, asks questions and applies fixes. AEE's goal is different. It is a pull request that gets red CI and one comment with the fix and the pattern ([master plan](../MASTER-PLAN.md#goal)), and the current focus is the tool working for its owner.

## Decision

The deterministic path is primary:

- `aee run` and `--ci`, with the HTML, JSON and Markdown report;
- in M4, the PR-comment report, the Playwright fixture and the GitHub Action.

MCP (M6) is one more surface over the same engine. It explains a rule through the registry and its a11y-skills pattern, and it has no rule logic of its own and no model access beyond `@aee/ai-fixes`.

Kept from the original:

- capability lives once, and surfaces stay thin;
- "talk to the tool" goes through the agent the developer already uses, not a bespoke chatbot. The report's own "Ask this report" answers from captured evidence, on the machine.

## Consequences

- M4 comes before M6. Step 6.1 ports `@aee/mcp` rewired to this engine rather than building a second one.
- Every surface reads the same report and registry, so they cannot disagree about a finding.
