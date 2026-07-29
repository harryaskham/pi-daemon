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
`web/e2e/performance-budget.ts` instead. `test/deterministic-gate.test.mjs`
enforces this across all three suites, so a new bare bound fails the gate rather
than waiting for a busy host to expose it.

A **hang bound** is different from a budget and is allowed: a generous limit
proving an operation did not hang, orders of magnitude above the timeout it
exercises. Compare against a named constant rather than a bare literal, so it
reads as "did not hang" rather than as a latency assertion — see
`DISPOSE_HANG_BOUND_MS` in `test/multiplexer.test.mjs`.

The `@smoke` browser subset is stricter still, because it gates every push: it
may bound only quantities the fixture determines, such as how many rows a
virtualized list rendered. Times, pixel geometry, and scroll offsets are out,
since a red gate everyone waits on is the worst place to discover that a bound
tracks host load. The same test enforces it.

## Editing the CI workflow

Two settings in `.github/workflows/ci.yml` are deliberate and easy to undo by
accident. Both follow the same rule as the budgets above: a gate is only worth
having if it can actually answer.

**Slow verification lives in its own workflow.** `ci.yml` is the fast lane and
cancels superseded runs; `ci-macos.yml` has its own concurrency group and lets a
push to `main` queue, so the slowest verification keeps its verdict instead of
being killed by the next landing.

They are separate because the first attempt at this put both in one workflow and
merely scoped `cancel-in-progress` to pull requests. That deadlocked CI
completely: a job whose runner label matches nothing can never be assigned and
therefore never completes, so with cancellation off every later run waited behind
it and dispatched no jobs at all — not a failure, no verdict of any kind, until
the next push replaced the pending run. Two rules follow.

Do **not** put a slow or optional job in the fast lane's concurrency group and
turn cancellation off to protect it. Give it its own workflow.

Do **not** assume a job that never reports is flaky. Check that a runner
carrying its labels is actually registered — `gh api repos/OWNER/REPO/actions/runners`
— because a job that cannot be scheduled looks exactly like a job that keeps
being cancelled, and only one of those is worth budgeting around.

**Step and job budgets are per platform.** Linux answers in minutes from a warm
store, so a run approaching its budget indicates a real problem. macOS measured
1.2 to 13.3 minutes on success, so it carries a wider budget to cover a cold
cache rather than failing on its own tail. Keep them separate; a single shared
ceiling either fails macOS on healthy runs or hides a genuine Linux regression.

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

## Negative controls

An assertion whose value is that it *rejects* something can pass while checking
nothing, and reading it will not reveal that: its text describes the intended
property correctly, and what is missing — any evidence that it can fail — is not
visible in the source at all. Three such assertions were found in one night, each
exposed only by an environment that differed slightly from the one it was written
in: an acceptance comparing two pre-hydration zeros, a fixture whose
permissiveness depended on the runner's umask, and a check pinned to a spelling
rather than a property.

So demonstrate that the assertion can fail. In order of preference:

1. **Assert the precondition the property depends on**, where it is checkable.
   A fail-closed case that needs a group-readable file should prove the file is
   group-readable before asserting the rejection — `test/permission-fixture.mjs`
   sets a fixture's mode and then checks it. This form goes first because it
   catches vacuity arising from an environment you were never in, which is the
   failure you cannot enumerate. The helper fails loudly on a hardened runner,
   a machine nobody on the project has.
2. **Check in a negative case against an extracted predicate.** Where the
   predicate can be pulled out, assert that it rejects the broken shapes, in the
   same file, so a later change that hollows out the assertion fails visibly.
   `nix/e2e-shell-check.nix` expresses its validation once and runs it twice:
   against the real shell, and against five tuples that each break exactly one
   clause. The mutations run on every `nix flake check`.
3. **Record a manual mutation.** Otherwise, break the property, watch the test
   fail, restore it, and name the mutation in the commit message, so the next
   editor can tell it was done. The `bd-228b91` commit names the four ways its
   pipeline could break and records that each was rejected — the weakest form
   doing its limited job. Restoring is where this form goes wrong, in both
   directions: `git checkout` on an already-staged file restores from the index
   and reverts nothing, and `git checkout HEAD --` on a file with uncommitted
   work discards the work along with the mutation. Both happened in one night.
   Take a copy before mutating and restore from that, and check the status of
   the command being verified rather than a pipeline's last stage — in
   `bd-b225fa` the mutation shipped as the change, because the revert was a
   no-op and `nix build | tail` reported `tail`'s exit status. The negative
   control became the defect.

The two checked forms answer different questions and neither implies the other:
a precondition proves the setup still establishes the situation the assertion
needs, a negative case proves the predicate still rejects. Use both where both
are cheap.

Form 3 is last because of where it runs, not only because it leaves less behind.
The mutation is exercised on the authoring machine, which is the benign
environment: deliberately breaking the umask case under a permissive umask shows
the assertion firing correctly, so the ritual passes and confirms a test that is
vacuous elsewhere.

Prefer observing an effect over asserting that the source contains a spelling of
it — but check what the observation costs first. Interpolating a store path into
a check derivation pulls that closure into the check's build inputs, so
asserting a value such as `PLAYWRIGHT_BROWSERS_PATH` naively would add the 2.1
GiB Playwright bundle to every `nix flake check`; discard the string context, or
confine the check to attributes that carry no store path. Where a check is
metadata-only by design, that is worth enforcing rather than remembering:
`nix/e2e-shell-check.nix` guards every value with `builtins.hasContext` and
throws at evaluation, naming the cause and the remedy, instead of silently
acquiring the input. Do not generalise the guard — a check that legitimately
needs a store path is ordinary. Observation is also
only free in a lane that can perform it — evaluating a devShell attribute needs
Nix, and the Node gate deliberately has none — so preferring the stronger form
sometimes means moving an assertion between lanes rather than rewriting it.

A guard that verifies something true of every value *except* the one it was
pointed at is a different failure, and worth naming separately: it fails in the
safe direction, going red immediately rather than staying green for a night. The
remedy differs too. A vacuous assertion needs a negative case; a misaimed one
needed its exemption to live where the guard could see it rather than in a
comment beside it.

A third form fails correctly and still misleads. An assertion's failure text
renders only on the failing path, so a green suite is no evidence at all about
it — it is simultaneously the text most likely to be wrong and least likely to be
read. A drift alarm here recorded that the SDK does not export a helper the
daemon reproduces, and its message told the reader to update the constant and
consume the export. That is the one response which satisfies the alarm while
leaving unasked the question it exists to force, because the upstream helper
creates directories as a side effect and the daemon needs a pure derivation. The
assertion was correct throughout; only its advice was wrong, and no passing run
could have revealed that. Fire the assertion once and read what it prints.

The same error occurs in measurements, not only in assertions. Counting outcomes
tells you the distribution of what happened, not whether the thing you are
counting is capable of happening. Three of the findings above are that at
different scales: a fixture reported a mode nobody checked was the mode
requested; forty-one ownership guards had a perfect pass rate because none could
fire; and a CI job's six-successes-in-thirty record was counted without asking
whether a runner carrying its labels existed at all. Before reading a rate, ask
what a failure would have required.

The same applies to reporting one. A figure comes from the run it describes or it
is not stated — in a report, or in passing. A report lends a fabricated number
the credibility of the checkable material around it; a passing mention is likelier
to contain one, because nobody is careful in a sentence that is not the point.
Vigilance is not the defence: both instances behind this rule were written by
people actively describing it. Capture the figure in the invocation that produces
the result rather than transcribing it.

This matters most for fail-closed and permission assertions, where a vacuous
pass is a silent loss of security coverage rather than a missing test.

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
