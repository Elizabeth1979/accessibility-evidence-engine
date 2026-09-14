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

The checked-in plan digest is explicitly approved and the planner reports `READY`. If the authored
scenario changes, its digest changes and execution stops until the new plan is reviewed and approved.

Run the exact approved scenario and create one integrated report:

```bash
node packages/cli/dist/index.js run examples/melio/scenario.yml --output aee-output/melio
```

Use `--open` for the HTML review surface or `--ci` when a failed, unknown, or incomplete result must
return a nonzero process status.

The scenario also owns the ordered virtual-reader commands and the exact pointer/keyboard comparisons. The example passes those declarations to the lane runners; the engine does not invent targets or interactions.

The current safe comparison hovers the public **Sign in** link in one fresh context and focuses the same link in another. It compares only the declared URL, visibility, and text outcome. It does not activate sign-in, create an account, or enter a payment workflow. Every action gets fresh viewport and full-page images, DOM, accessibility-tree, focus, and Axe evidence, and the combined result is stored in `interaction-trace.json`.

The comparison also writes a WebM recording, JSON action timeline, and WebVTT captions for each lane. `manifest.json` covers them and the synchronized evidence with relative paths, SHA-256 checksums, per-action provenance, and privacy marked sensitive and unreviewed for sharing.

Melio currently routes visitors through homepage variants such as `/b/` and `/c/`. The runner first obtains one initial storage state and gives an identical copy to both fresh lanes, preventing experiment assignment from masquerading as an input-method difference. The final URLs are still compared between lanes. Observed text is whitespace-normalized before exact comparison while the raw DOM remains in the evidence artifacts.

This is still a bounded execution of the declared scenario, not a complete Melio accessibility assessment or a WCAG conformance claim.
