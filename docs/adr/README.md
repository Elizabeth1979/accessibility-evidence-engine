# Architecture decision records

Each record states one lasting decision about how the engine is built: the context, the decision, how the code enforces it, and what it costs. Plan-level choices (what to build next, and why a step was done a certain way) go in the [master plan's decisions log](../MASTER-PLAN.md#decisions-log) instead.

| ADR                                               | Decision                                                      | Origin                                 |
| ------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------- |
| [0001](0001-ai-sees-evidence-only.md)             | AI sees evidence only, never the live page                    | accessibility-engine ADR 0002          |
| [0002](0002-axe-core-is-the-floor.md)             | axe-core is the floor, not the product                        | accessibility-engine ADR 0003          |
| [0003](0003-verdicts-are-deterministic.md)        | Verdicts are deterministic; AI sits beside them               | accessibility-engine ADR 0004, changed |
| [0004](0004-ci-and-report-first-mcp-later.md)     | CI and the report come first; MCP is one more surface         | accessibility-engine ADR 0005, changed |
| [0005](0005-registry-follows-act-rules-format.md) | The remediation registry follows the ACT Rules Format's shape | New                                    |

A new record takes the next number and the same sections. A record is not edited to reverse it: a new record supersedes it, and the old one's status says so.
