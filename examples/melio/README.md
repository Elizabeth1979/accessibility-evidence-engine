# Melio example

`scenario.yml` is the user-controlled assessment request. It defines the goal, WCAG scope, Core
profile, allowed public interactions, forbidden account and financial actions, evidence privacy,
and mandatory plan approval.

`allowedActions` are permissions, not instructions. The runner executes only concrete actions listed under `interactionComparisons` and `virtualScreenReaderCommands`.

Compile and inspect the deterministic plan:

```bash
npm run build
node packages/cli/dist/index.js plan examples/melio/scenario.yml
```

For machine-readable output:

```bash
node packages/cli/dist/index.js plan examples/melio/scenario.yml --json
```

The planner currently reports `BLOCKED` because several capabilities required by the Core profile
are not fully implemented. This is deliberate: a partial smoke test must not be presented as a
complete accessibility assessment.

The scenario also owns the ordered virtual-reader commands and the exact pointer/keyboard comparisons. The example passes those declarations to the lane runners; the engine does not invent targets or interactions.

The current safe comparison hovers the public **Sign in** link in one fresh context and focuses the same link in another. It compares only the declared URL, visibility, and text outcome. It does not activate sign-in, create an account, or enter a payment workflow. Every action gets fresh viewport and full-page images, DOM, accessibility-tree, focus, and Axe evidence, and the combined result is stored in `interaction-trace.json`.

Melio currently routes visitors through homepage variants such as `/b/` and `/c/`. The runner first obtains one initial storage state and gives an identical copy to both fresh lanes, preventing experiment assignment from masquerading as an input-method difference. The final URLs are still compared between lanes. Observed text is whitespace-normalized before exact comparison while the raw DOM remains in the evidence artifacts.

These are still bounded executions of the declared scenario, not a complete Melio accessibility assessment. The planner remains blocked until the remaining required reporting and evidence capabilities are implemented.
