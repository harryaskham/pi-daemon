# Contributing

Read `AGENTS.md` and `PLAN.md` first.

## Development

```bash
nix develop
npm ci
npm test
nix flake check
```

Dash browser acceptance runs from its own shell, which supplies audited
Playwright browsers instead of an unrunnable download:

```bash
just dash-e2e
```

See [`docs/dash-e2e.md`](docs/dash-e2e.md) for scenario filtering, the
version-drift preflight, and wall-clock budget enforcement.

Wall-clock performance budgets are deliberately excluded from the deterministic
gate, in the Node, web unit, and browser suites: the measurements always run and
are reported, but the numeric bound is asserted only when
`PI_DAEMON_PERFORMANCE_BUDGETS=1` is set. Enforce them explicitly on a quiet
machine, where a failure is a real regression signal:

```bash
npm run test:manual:performance   # Node suite budgets
npm run web:test:performance      # Dash web unit budgets
PI_DAEMON_PERFORMANCE_BUDGETS=1 just dash-e2e   # Dash browser budgets
```

A budget missed on a busy shared host says nothing about the code, so do not
add a bare wall-clock assertion to the standard suite; report it through
`test/performance-budget.mjs`, `web/src/test/performance-budget.ts`, or
`web/e2e/performance-budget.ts` instead.

Changes should be narrow, tested, and documented. Protocol changes require a
versioning assessment, fixtures, and compatibility coverage. Security-sensitive
changes require adversarial tests.

## Commits and pull requests

Use concise imperative commit subjects and include the relevant provisional
`PD-...` identifier while the formal board is not configured. Explain behavior,
compatibility, tests, and security impact in pull requests.

## Reporting defects

Include the pi-daemon version, Node version, platform, operation/error code, and
redacted reproduction. Never attach auth files, prompts, model output, tokens,
or environment dumps.
