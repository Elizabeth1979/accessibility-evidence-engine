# Melio example

`scenario.yml` is the user-controlled assessment request. It defines the goal, WCAG scope, Core
profile, allowed public interactions, forbidden account and financial actions, evidence privacy,
and mandatory plan approval.

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

`melio-homepage.spec.ts` remains a narrow Playwright smoke test for one Tab transition. It is not the
execution of `scenario.yml` and must not be described as a complete Melio assessment.
