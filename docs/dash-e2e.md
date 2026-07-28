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

This is a local developer and acceptance path. Repository CI runs the Node suite
and `nix flake check`; it does not run browser acceptance, so browser evidence
is produced deliberately from a documented shell rather than implicitly on every
push.

## Known failures

None outstanding. The Rich/TUI scroll-restoration scenario, which this shell
first exposed as an assertion that compared two pre-hydration zeros, was fixed
separately in `bd-94d7df`.
