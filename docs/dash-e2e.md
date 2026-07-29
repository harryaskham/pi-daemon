---
title: Dash browser acceptance
---

# Dash browser acceptance

The Dash Playwright suite (`web/e2e/dash.spec.ts`) drives the production SPA
build in a real browser. Playwright normally downloads its own Chromium, and
that download is dynamically linked against host libraries that library-strict
distributions do not provide: on NixOS and on the Aurora Linux host that filed
this gap, the downloaded browser exits `127` because `libnspr4.so` is missing,
even though TypeScript, Vite, Vitest, and Playwright test discovery all pass.

The repository therefore ships a dedicated Nix development shell that supplies
the audited nixpkgs browser bundle. No ad-hoc host packages are required.

## Run the suite

```bash
# Whole suite.
nix develop .#e2e --command npm run e2e:nix --workspace @harryaskham/pi-daemon-dash

# One scenario. Prefer a regex without literal spaces so argument forwarding
# survives npm and just.
nix develop .#e2e --command npm run e2e:nix --workspace @harryaskham/pi-daemon-dash -- --grep 'dormant.preview'

# Same thing through the Justfile.
just dash-e2e --grep 'dormant.preview'
```

`npm run web:e2e:nix` runs the whole suite from the repository root. It does not
forward extra Playwright arguments, because npm does not pass `--` through two
levels of `npm run`; use the workspace form above when you need `--grep`.

## What the shell provides

`devShells.e2e` exports three variables:

| Variable | Purpose |
| --- | --- |
| `PLAYWRIGHT_BROWSERS_PATH` | The nixpkgs `playwright-driver.browsers` bundle, complete with its runtime libraries. |
| `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD` | Prevents any fallback download of an unusable browser. |
| `PI_DAEMON_PLAYWRIGHT_DRIVER_VERSION` | The Nix driver version, used by the preflight to explain drift. |

## Version alignment is load-bearing

Playwright resolves browsers by revision, so the npm `@playwright/test` pin must
equal the nixpkgs `playwright-driver` version. When they diverge, the bundle
holds `chromium-<other revision>` and Playwright fails late with a bare
"Executable doesn't exist".

`npm run e2e:nix` runs `web/scripts/check-playwright-browsers.mjs` first, which
compares the revisions the installed `playwright-core` requires against the
directories the bundle actually contains and fails immediately with the exact
mismatch and both versions. Run it alone with `npm run e2e:check --workspace
@harryaskham/pi-daemon-dash`.

When the preflight reports drift, align the two pins deliberately:

- pin `@playwright/test` in `web/package.json` to the version the flake's
  nixpkgs revision provides, or
- move the flake's nixpkgs input to a revision whose `playwright-driver` matches
  the npm pin.

Both sides are exact pins on purpose; do not "fix" drift by letting Playwright
download a browser.

## Build timeout

`webServer` type-checks and builds the SPA before serving it, which takes well
over Playwright's short default on a cold checkout. The config waits
180 seconds, overridable with `DASH_TEST_WEBSERVER_TIMEOUT_MS`, and the preview
port with `DASH_TEST_PORT`.

## Wall-clock budgets are opt-in

The browser suite measures navigation-to-first-rows, 10k branch-tree open, and
10k session search. Those millisecond bounds are meaningful on an idle reference
machine and meaningless on a loaded shared host, where a correct implementation
misses them purely because it was descheduled. As in the Node suite, the
measurements always run and are recorded as `performance-budget` annotations,
and only the assertion is opt-in:

```bash
PI_DAEMON_PERFORMANCE_BUDGETS=1 nix develop .#e2e --command \
  npm run e2e:nix --workspace @harryaskham/pi-daemon-dash
```

Structural invariants — virtualized row counts, layout geometry, and behavior —
are always enforced, so an unbudgeted run still fails if virtualization
regresses into an O(total entries) DOM. Run the budgeted form on a quiet
machine; a failure there is a real regression signal.

## Scope

CI runs the bounded `@smoke` subset on every push and pull request, from the
same Nix shell:

```bash
just dash-e2e-smoke
```

The full suite stays a deliberate local and acceptance path. The `Dash browser
smoke` job proves the SPA still builds, boots, and renders in a real browser, so
a total breakage cannot reach `main` unnoticed; everything beyond that is run on
demand.

## Should CI gate on the full suite?

Not yet, and the subset above is the compromise. Measured on the `sonance`
self-hosted runner class at load average ~11.7, on `85e41a0`:

| Property | Full suite | `@smoke` subset |
| --- | --- | --- |
| Scenarios | 21 | 3 |
| Wall clock | 3.0-3.1 min | 53s |
| Determinism under load | 1 intermittent failure | stable |

The browser bundle is a ~2.1 GiB Nix closure. That is free on a warm
self-hosted store and substitutable from the binary cache, but it is the one
cost that would hurt a cold or ephemeral runner.

The blocking issue is determinism, not runtime. Two consecutive full runs failed
`TUI presentation streams one canonical controller grid to read-only pane
mirrors` at `expect(Math.abs(restoredAnchor - readingAnchor)).toBeLessThan(32)`
with a measured 43px, while the same scenario passes in isolation. A gate that
is red for reasons unrelated to the change under review trains reviewers to
ignore it, which is worse than no gate. The three `@smoke` scenarios were chosen
because they assert structure only — bounded virtualization, sidebar states, and
production boot never painting fixture data — with no wall-clock or pixel
tolerance, so host contention cannot turn them red.

Revisit full-suite gating when the load-sensitive scenarios are deterministic
under contention. At that point the runtime is affordable: 3 minutes on a warm
runner, in parallel with the existing Node and Nix jobs.

## Known failures

`TUI presentation streams one canonical controller grid to read-only pane
mirrors` fails intermittently in full-suite runs under host load, at the 32px
reading-anchor tolerance introduced with the `bd-94d7df` fix (43px observed,
twice, at load average ~11.7). It passes in isolation. The restoration behavior
itself is fixed; what is not yet load-proof is the tolerance around the settled
measurement. It is excluded from the `@smoke` subset for that reason.
