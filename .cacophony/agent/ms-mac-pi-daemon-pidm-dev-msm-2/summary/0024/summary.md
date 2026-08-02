# Session summary — root web workspace argument forwarding

## Outcome

Completed `bd-8e7f56`: every root `web:*` npm convenience script now preserves
forwarded workspace-tool arguments instead of letting the inner npm process
consume them as configuration and silently broaden a run.

## Implementation

- Added `scripts/run-web-workspace.mjs`:
  - allow-listed workspace scripts (`dev`, `build`, `test`, `e2e`, `e2e:nix`,
    `e2e:smoke`, `bundle:report`);
  - forwarded argv bounded to 64 entries, 4,096 characters each, 32,768
    aggregate, with NUL refused;
  - constructs exact `npm run <script> --workspace
    @harryaskham/pi-daemon-dash -- <forwarded argv>`;
  - omits the inner `--` when no args exist;
  - inherits stdio/environment and preserves child status/signal truth.
- Routed all root `web:*` scripts through the wrapper; performance mode retains
  its explicit `PI_DAEMON_PERFORMANCE_BUDGETS=1` environment.
- Added tests pinning exact argv, all eight root script mappings, unsafe/bounded
  refusals, and the release smoke contract. The old nested npm form is a
  negative assertion so it cannot return silently.
- Updated `docs/dash-e2e.md`, `CONTRIBUTING.md`, `PLAN.md`, and `CHANGELOG.md`.

## Validation

- Wrapper/release focused suites: 13/13 green.
- Fake npm process received exact separate argv: `run`, `e2e`, `--workspace`,
  workspace id, `--`, `--grep`, and multiword `dormant preview`.
- Real root `npm run web:test -- --testNamePattern 'web test diagnostics'`
  emitted no unknown-config warning and ran 3 matching tests while skipping 91.
- `npm test`: 534/534 green.
- `nix flake check`: exit 0 in the foreground.
