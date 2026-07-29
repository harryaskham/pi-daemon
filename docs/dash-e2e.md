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

## Sandboxing on CI runners

Chromium's sandbox needs user namespaces and a normally-sized `/dev/shm`. A
hardened self-hosted runner may supply neither, and the browser then exits
during launch, so every scenario fails with `Target page, context or browser has
been closed` before any assertion runs (`bd-df1c84`).

The `Dash browser smoke` job therefore sets `PI_DAEMON_E2E_NO_SANDBOX=1`, which
adds `--no-sandbox --disable-dev-shm-usage` to the browser launch. That is
acceptable only because the browser loads nothing but our own build over
loopback, on a runner that is already an isolated environment. It is opt-in per
environment and never the default: a developer machine keeps the sandbox, and
nothing in the repository turns it off implicitly. The options live in
`web/playwright-launch.mjs` so the config and the launch preflight cannot
disagree.

## When the browser will not start

`e2e:nix` and `e2e:smoke` run `web/scripts/check-browser-launch.mjs` before the
suite. It starts the audited browser with the exact options the suite will use
and, on failure, prints the browser's own diagnostics plus the environment facts
that decide whether a launch is possible: browsers path, launch arguments, uid,
`/dev/shm` size and free space, and whether the kernel exposes unprivileged user
namespaces. It runs in well under a second.

This exists because Playwright reports a browser that dies during startup as
`Target page, context or browser has been closed`, once per scenario, minutes
into the run, with the browser's own stderr swallowed. That symptom names
neither the cause nor the environment. Run it directly with:

```bash
nix develop .#e2e --command npm run e2e:check-launch --workspace @harryaskham/pi-daemon-dash
```

If it fails, re-run with `DEBUG=pw:browser` to see the browser's own stderr,
which normally names the cause outright.

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

## The run record

Every browser run writes `web/test-results/run.json` alongside the traces
Playwright already saves on failure. It holds each scenario's status and error
text, plus `webServer` startup failures, so an incident can be classified after
the fact rather than only while someone is watching the terminal. CI uploads
`web/test-results` as an artifact when the smoke job fails, so the same record
is available for a runner failure.

Read it first when a run fails:

```bash
python3 -c 'import json;d=json.load(open("web/test-results/run.json"));print(d["stats"]);print([e["message"][:120] for e in d["errors"]])'
```

The reporter set lives in `web/playwright-reporters.mjs` so the wiring can be
asserted structurally rather than by matching config source text.

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
| Determinism under load | fixed in `bd-65fddd` | stable |

The browser bundle is a ~2.1 GiB Nix closure. That is free on a warm
self-hosted store and substitutable from the binary cache, but it is the one
cost that would hurt a cold or ephemeral runner.

The blocking issue was determinism, not runtime, and it is now fixed. Two
consecutive full runs failed `TUI presentation streams one canonical controller
grid to read-only pane mirrors` at
`expect(Math.abs(restoredAnchor - readingAnchor)).toBeLessThan(32)`, while the
same scenario passed in isolation. That was a real product defect, not a
tolerance that needed widening: the reading anchor was refreshed only on scroll
events, so dynamic row measurement grew the transcript underneath it and the
restore faithfully reproduced a stale anchor. `bd-65fddd` observes the sizer and
keeps the anchor current. Measured after the fix on the same host at load
average 14-16.4: five consecutive scenario repeats passed, and five of six
full-suite runs were 21/21.

The remaining reason to keep the subset is the sixth run, which failed six
scenarios in under a second each. That failure is unexplained. Its output was
not retained, so it cannot now be classified, and it did not reproduce in five
subsequent full runs. Two candidate explanations are on the table:

- **Browser launch failure.** Sub-second failures across consecutive unrelated
  scenarios are the signature of the browser process dying at launch, which
  Playwright reports as `browserContext.newPage: Target page, context or browser
  has been closed`. A merely slow scenario burns its timeout instead. The same
  signature appeared for all three `@smoke` scenarios in CI run `30412617437`,
  which `bd-df1c84` addresses.
- **Host contention.** The host was also running several other agents. Against
  this, `/dev/shm` measured 85M used of 7.7G before a full run and 79M after,
  so there was no measurable shared-memory pressure at rest or persisting
  afterwards.

If it recurs, read `web/test-results/run.json` first. Every run writes that
record, so the failure is already captured: look for `Target page, context or
browser has been closed` against every scenario, which separates the two
explanations in one step, and they need different fixes.

A gate that is red for reasons unrelated to the change under review trains
reviewers to ignore it, which is worse than no gate. The three `@smoke`
scenarios assert structure only — bounded virtualization, sidebar states, and
production boot never painting fixture data — with no wall-clock or pixel
tolerance, so host contention cannot turn them red.

Revisit full-suite gating once that unexplained failure is classified and the
runner class is known not to lose browsers under concurrent load. The
determinism objection that previously blocked it is resolved, and the runtime is
affordable: 3 minutes on a warm runner, in parallel with the existing Node and
Nix jobs.

## Known failures

None outstanding. The reading-anchor scenario that previously failed under load
is fixed in `bd-65fddd`; see the gating section above for the measurements.
