# Contributing

Read `AGENTS.md` and `PLAN.md` first.

## Development

```bash
nix develop
npm ci
npm test
nix flake check
```

`npm test` rebuilds everything, including a production build of the Dash SPA,
which a test touching only `src/**` does not need. For a focused loop, compile
the server alone and reuse the SPA that is already built:

```bash
npm run test:src -- test/session-api.test.mjs   # or: just test-src test/session-api.test.mjs
npm run build:src                               # compile src/ without the SPA
```

On this repository that is roughly 17 seconds instead of 46. `npm test` remains
the authoritative gate, and packaging, Nix, and release paths always run the
full build, so nothing ships without the SPA. If `web/dist` has never been
built, `build:src` says so and leaves `dist/dashboard` absent; run the full
`npm run build` before anything that serves or asserts the packaged SPA.

Dash browser acceptance runs from its own shell, which supplies audited
Playwright browsers instead of an unrunnable download:

```bash
just dash-e2e         # whole suite, deliberate local acceptance
just dash-e2e-smoke   # the bounded @smoke subset CI runs on every push
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

## Dependency updates and the pinned Nix hash

`flake.nix` pins `npmDepsHash`, a fixed-output hash over the npm dependency
cache that `package-lock.json` determines. Any lock change invalidates it, and
an automated dependency bump cannot refresh it on its own, so refresh it in the
same change:

```bash
just npm-deps-hash          # or: npm run nix:deps-hash
```

This computes the exact hash with the flake's own pinned nixpkgs and rewrites
`flake.nix`. Verify without changing anything with `just npm-deps-hash-check`.

CI keeps a stale pin from becoming a mystery. The Node jobs run
`npm run nix:deps-hash:fast`, which needs neither Nix nor network: it compares
`package-lock.json` against the `npm-deps-lock` marker recorded beside the pin
and fails in seconds naming the refresh command. The `npm-deps-hash` flake check
then fetches only the dependency cache, so a genuine mismatch reports the exact
replacement hash without waiting for a full build. The marker is a staleness
signal only; `npmDepsHash` remains the value Nix actually verifies.

When a grouped dependency pull request goes red on that fast check, pull the
branch, run the refresh command, and push the updated `flake.nix`.

`npm test` needs an `openssl` binary: `test/tls-fixture.mjs` issues a real
certificate pair for the TLS and credential fail-closed cases, and `node:crypto`
cannot do that — its `X509Certificate` is parse-only. Both dev shells provide it,
and `OPENSSL_BIN` points the fixture at a specific binary if yours is elsewhere.
Those cases must never be skipped when it is absent; they are the security
coverage, and a skip would turn the gate green while it silently disappears.

## Nix formatting

`flake.nix` declares `alejandra` as the repository formatter and the Nix sources
are converged on it, so a narrow change stays a narrow diff:

```bash
just nix-fmt          # format flake.nix and nix/
just nix-fmt-check    # verify without changing anything; CI runs this
```

Run it before landing a Nix change. Keeping the tree converged is what stops the
formatter from becoming unusable: on a divergent tree the first person to run it
inherits everyone else's churn, so they revert it, and the divergence grows.

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
